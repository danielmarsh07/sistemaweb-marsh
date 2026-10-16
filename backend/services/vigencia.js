/**
 * vigencia.js — inadimplência e renovação de contratos (fluxo novo, fase 5). Roda na rotina horária; tudo idempotente.
 *
 * Inadimplência (decisão do dono, 2026-10-16):
 *   - fatura aberta vencida → alerta em Sistema → Alertas (uma vez por fatura);
 *   - com dias_suspensao (padrão 30) de atraso, o contrato do Conector cobrado por ela fica SUSPENSO:
 *     licenças e cursos gratuitos param na hora (conferidos ao vivo);
 *   - quando a fatura é paga (ou cancelada), a suspensão automática é desfeita sozinha.
 *     Suspensão feita à mão pelo admin (sem suspenso_por_fatura_id) nunca é desfeita aqui.
 * Renovação:
 *   - avisos 30, 7 e 1 dia antes do fim da vigência (admins da Marsh; no Conector, também os admins da empresa);
 *   - no fim: com renovacao_automatica, +12 meses (e o contrato do Conector junto); sem, o contrato é encerrado.
 */
const pool = require('../db');
const auditoria = require('./auditoria');
const email = require('./email');
const { registrarAlerta } = require('./alertas');

const br = d => String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-').reverse().join('/');
const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const BASE = () => process.env.APP_URL || 'https://marshconsultoria.com.br';

async function depoisDeMudarConector(contratoId) {
  await require('./certificacao').sincronizarContrato(contratoId).catch(err => console.error('[vigencia] licenças:', err.message));
  await require('./acessos').sincronizarTodos({ contratoId }).catch(err => console.error('[vigencia] acessos:', err.message));
}

// ===== Inadimplência =====
async function alertarVencidas() {
  const r = await pool.query(
    `SELECT f.id, f.empresa_id, f.valor::float AS valor, f.data_vencimento, ct.contrato_conector_id,
            COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS cliente,
            COALESCE(cfg.dias_suspensao, 30) AS dias
     FROM faturas f JOIN clientes c ON c.id = f.cliente_id
     LEFT JOIN contratos ct ON ct.id = f.contrato_id
     LEFT JOIN financeiro_config cfg ON cfg.empresa_id = f.empresa_id
     WHERE f.status = 'aberta' AND f.data_vencimento < CURRENT_DATE AND f.alerta_atraso_em IS NULL LIMIT 100`);
  for (const f of r.rows) {
    const suspende = f.contrato_conector_id
      ? ` Se não for paga até ${br(new Date(new Date(f.data_vencimento).getTime() + f.dias * 86400000))}, as licenças do Conector desse contrato serão suspensas automaticamente.` : '';
    await registrarAlerta({ chave: `inadimplencia:fatura:${f.id}`, nivel: 'aviso',
      titulo: `Fatura vencida: ${f.cliente} — ${moeda(f.valor)} (venceu ${br(f.data_vencimento)})`,
      detalhe: `Fatura #${f.id} em aberto.${suspende}` });
    await pool.query('UPDATE faturas SET alerta_atraso_em = NOW() WHERE id = $1', [f.id]);
  }
  return r.rows.length;
}

async function suspenderInadimplentes() {
  const r = await pool.query(
    `SELECT DISTINCT ON (k.id) k.id AS contrato_conector_id, k.empresa_id, f.id AS fatura_id, f.valor::float AS valor, f.data_vencimento,
            COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS cliente
     FROM faturas f
     JOIN contratos ct ON ct.id = f.contrato_id AND ct.contrato_conector_id IS NOT NULL
     JOIN contratos_conector k ON k.id = ct.contrato_conector_id AND k.status = 'ativo'
     JOIN clientes c ON c.id = f.cliente_id
     LEFT JOIN financeiro_config cfg ON cfg.empresa_id = f.empresa_id
     WHERE f.status = 'aberta' AND f.data_vencimento <= CURRENT_DATE - COALESCE(cfg.dias_suspensao, 30)
     ORDER BY k.id, f.data_vencimento`);
  let n = 0;
  for (const s of r.rows) {
    const up = await pool.query(
      `UPDATE contratos_conector SET status = 'suspenso', suspenso_por_fatura_id = $2, data_atualizacao = NOW()
       WHERE id = $1 AND status = 'ativo' RETURNING id`, [s.contrato_conector_id, s.fatura_id]);
    if (!up.rowCount) continue;
    n++;
    await auditoria.registrar({ empresa_id: s.empresa_id, acao: 'conector.suspenso_inadimplencia', entidade: 'contrato_conector',
      entidade_id: s.contrato_conector_id, detalhe: `Fatura #${s.fatura_id} vencida em ${br(s.data_vencimento)}` });
    await depoisDeMudarConector(s.contrato_conector_id);
    await registrarAlerta({ chave: `inadimplencia:suspenso:${s.contrato_conector_id}`, nivel: 'erro',
      titulo: `Licenças suspensas por atraso: ${s.cliente} (contrato do Conector nº ${s.contrato_conector_id})`,
      detalhe: `Fatura #${s.fatura_id} de ${moeda(s.valor)} vencida em ${br(s.data_vencimento)}. Volta sozinho quando a fatura for paga.` });
  }
  return n;
}

/** Desfaz as suspensões automáticas cuja fatura foi paga/cancelada (e sem outra em atraso além do prazo). */
async function reativarPagos() {
  const r = await pool.query(
    `SELECT k.id, k.empresa_id, k.suspenso_por_fatura_id FROM contratos_conector k
     WHERE k.status = 'suspenso' AND k.suspenso_por_fatura_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM faturas f JOIN contratos ct ON ct.id = f.contrato_id
         LEFT JOIN financeiro_config cfg ON cfg.empresa_id = f.empresa_id
         WHERE ct.contrato_conector_id = k.id AND f.status = 'aberta'
           AND f.data_vencimento <= CURRENT_DATE - COALESCE(cfg.dias_suspensao, 30))`);
  for (const k of r.rows) {
    const up = await pool.query(
      `UPDATE contratos_conector SET status = 'ativo', suspenso_por_fatura_id = NULL, data_atualizacao = NOW()
       WHERE id = $1 AND status = 'suspenso' AND suspenso_por_fatura_id IS NOT NULL RETURNING id`, [k.id]);
    if (!up.rowCount) continue;
    await auditoria.registrar({ empresa_id: k.empresa_id, acao: 'conector.reativado_pagamento', entidade: 'contrato_conector',
      entidade_id: k.id, detalhe: `Fatura #${k.suspenso_por_fatura_id} regularizada` });
    await depoisDeMudarConector(k.id);
  }
  return r.rows.length;
}

// ===== Renovação =====
const MARCOS = [30, 7, 1];

/** Avisos de fim de vigência (uma vez por marco e por contrato). */
async function avisarVencimentos() {
  const r = await pool.query(
    `SELECT ct.id, ct.empresa_id, ct.descricao, ct.cliente_id, ct.renovacao_automatica, ct.contrato_conector_id,
            to_char(ct.data_fim, 'YYYY-MM-DD') AS data_fim, (ct.data_fim - CURRENT_DATE) AS faltam,
            COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS cliente
     FROM contratos ct JOIN clientes c ON c.id = ct.cliente_id
     WHERE ct.status = 'ativo' AND ct.data_fim IS NOT NULL AND (ct.data_fim - CURRENT_DATE) = ANY($1)`, [MARCOS]);
  let n = 0;
  for (const ct of r.rows) {
    const marco = `dias:${ct.faltam}`;
    const ja = await pool.query(`SELECT 1 FROM auditoria WHERE entidade = 'contrato' AND entidade_id = $1 AND acao = 'contrato.aviso_vencimento' AND detalhe = $2`,
      [ct.id, marco]);
    if (ja.rows.length) continue;
    await auditoria.registrar({ empresa_id: ct.empresa_id, acao: 'contrato.aviso_vencimento', entidade: 'contrato', entidade_id: ct.id, detalhe: marco });
    n++;
    const oque = ct.renovacao_automatica ? 'será renovado automaticamente por mais 12 meses' : 'será encerrado (renovação automática desligada)';
    await email.notificarAdminsComercial({
      empresa_id: ct.empresa_id, assunto: `Contrato vence em ${ct.faltam} dia(s): ${ct.cliente}`,
      titulo: 'Contrato perto do fim da vigência',
      linhas: [['Cliente', ct.cliente], ['Contrato', ct.descricao], ['Fim', br(ct.data_fim)], ['O que acontece', `No fim, o contrato ${oque}.`]],
      link: `${BASE()}/dashboard.html#contratos`
    }).catch(() => false);
    // Licenças do Conector: a empresa também é avisada (administradores no portal)
    if (ct.contrato_conector_id) {
      const admins = (await pool.query(
        `SELECT u.email FROM clientes_admins a JOIN usuarios u ON u.id = a.usuario_id WHERE a.cliente_id = $1 AND u.ativo`, [ct.cliente_id])).rows.map(x => x.email);
      if (admins.length) {
        await email.enviarAvisoVencimentoLicencas({ para: admins, cliente: ct.cliente, fim: ct.data_fim, dias: ct.faltam, renova: ct.renovacao_automatica })
          .catch(() => false);
      }
    }
  }
  return n;
}

const mais12Meses = iso => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 12); return d.toISOString().slice(0, 10); };

/** Fim da vigência: renova (+12 meses, com o Conector junto) ou encerra. */
async function processarFimDeVigencia() {
  const r = await pool.query(
    `SELECT id, empresa_id, renovacao_automatica, contrato_conector_id, to_char(data_fim, 'YYYY-MM-DD') AS data_fim
     FROM contratos WHERE status = 'ativo' AND data_fim IS NOT NULL AND data_fim < CURRENT_DATE LIMIT 100`);
  for (const ct of r.rows) {
    if (ct.renovacao_automatica) {
      const novo = mais12Meses(ct.data_fim);
      const up = await pool.query(`UPDATE contratos SET data_fim = $2, data_atualizacao = NOW() WHERE id = $1 AND data_fim = $3::date RETURNING id`,
        [ct.id, novo, ct.data_fim]);
      if (!up.rowCount) continue;
      await auditoria.registrar({ empresa_id: ct.empresa_id, acao: 'contrato.renovado', entidade: 'contrato', entidade_id: ct.id,
        antes: { data_fim: ct.data_fim }, depois: { data_fim: novo } });
      if (ct.contrato_conector_id) {
        await pool.query(`UPDATE contratos_conector SET data_fim = GREATEST(data_fim, $2::date), data_atualizacao = NOW() WHERE id = $1`, [ct.contrato_conector_id, novo]);
        await depoisDeMudarConector(ct.contrato_conector_id);
      }
    } else {
      const up = await pool.query(`UPDATE contratos SET status = 'encerrado', data_atualizacao = NOW() WHERE id = $1 AND status = 'ativo' RETURNING id`, [ct.id]);
      if (up.rowCount) {
        await auditoria.registrar({ empresa_id: ct.empresa_id, acao: 'contrato.encerrado', entidade: 'contrato', entidade_id: ct.id,
          detalhe: `Fim da vigência em ${br(ct.data_fim)} (sem renovação automática)` });
      }
    }
  }
  return r.rows.length;
}

async function ciclo() {
  await alertarVencidas();
  await suspenderInadimplentes();
  await reativarPagos();
  await avisarVencimentos();
  await processarFimDeVigencia();
}

module.exports = { ciclo, alertarVencidas, suspenderInadimplentes, reativarPagos, avisarVencimentos, processarFimDeVigencia };
