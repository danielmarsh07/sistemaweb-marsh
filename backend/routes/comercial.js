/**
 * /api/comercial — funil de vendas e propostas (só administradores).
 *
 * Oportunidade (cliente cadastrado ou prospect) → propostas com itens mensais/únicos → link público para o
 * cliente responder → ganha → gera cliente (se prospect) + contrato recorrente do faturamento.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const email = require('../services/email');
const com = require('../services/comercial');
const auditoria = require('../services/auditoria');
const conector = require('../services/precificacao-conector');

const emp = req => req.usuario.empresa_id || 1;
const vazioNulo = v => (v === undefined || v === null || String(v).trim() === '' ? null : v);
const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const texto = (v, max) => (vazioNulo(v) === null ? null : String(v).trim().slice(0, max));

function erro500(res, msg, err) {
  console.error(`[comercial] ${msg}:`, err.message);
  res.status(500).json({ erro: msg, detalhe: err.message });
}

router.use((req, res, next) => {
  const tipo = req.usuario.tipo;
  if (tipo !== 'admin_empresa' && tipo !== 'admin_sistema') {
    return res.status(403).json({ erro: 'Apenas administradores acessam o comercial.' });
  }
  next();
});

const NOME_CLIENTE = `COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome)`;
const COLUNAS_OPORTUNIDADE = `
  o.id, o.cliente_id, o.titulo, o.empresa_nome, o.contato_nome, o.contato_email, o.contato_telefone,
  o.interesse, o.origem, o.etapa, o.valor_mensal::float AS valor_mensal, o.valor_unico::float AS valor_unico,
  COALESCE(o.probabilidade, 0) AS probabilidade,
  to_char(o.previsao_fechamento, 'YYYY-MM-DD') AS previsao_fechamento,
  to_char(o.data_fechamento, 'YYYY-MM-DD') AS data_fechamento,
  o.motivo_perda, o.mensagem_origem, o.observacoes, o.contrato_id, o.data_criacao, o.data_atualizacao,
  COALESCE(${NOME_CLIENTE}, o.empresa_nome) AS nome_exibicao`;

async function carregarOportunidade(id, empresa_id) {
  const r = await pool.query(
    `SELECT ${COLUNAS_OPORTUNIDADE} FROM oportunidades o LEFT JOIN clientes c ON c.id = o.cliente_id
     WHERE o.id = $1 AND o.empresa_id = $2`, [id, empresa_id]);
  return r.rows[0] || null;
}

// ===== Metadados para os selects =====
router.get('/meta', (req, res) => {
  res.json({
    etapas: Object.entries(com.ETAPAS).map(([id, e]) => ({ id, nome: e.nome, probabilidade: e.prob })),
    origens: Object.entries(com.ORIGENS).map(([id, nome]) => ({ id, nome }))
  });
});

// ===== Oportunidades =====
// GET /oportunidades?fechadas_dias=90 — abertas + ganhas/perdidas nos últimos N dias
router.get('/oportunidades', async (req, res) => {
  const dias = Math.min(Math.max(Number(req.query.fechadas_dias ?? 90) || 0, 0), 3650);
  try {
    const r = await pool.query(
      `SELECT ${COLUNAS_OPORTUNIDADE},
              (SELECT COUNT(*) FROM propostas p WHERE p.oportunidade_id = o.id)::int AS qtd_propostas,
              (SELECT p.status FROM propostas p WHERE p.oportunidade_id = o.id ORDER BY p.id DESC LIMIT 1) AS ultima_proposta_status
       FROM oportunidades o LEFT JOIN clientes c ON c.id = o.cliente_id
       WHERE o.empresa_id = $1
         AND (o.etapa NOT IN ('ganha', 'perdida') OR ($2::int > 0 AND o.data_fechamento >= CURRENT_DATE - $2::int))
       ORDER BY o.data_atualizacao DESC
       LIMIT 500`, [emp(req), dias]);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao buscar oportunidades', err); }
});

router.get('/oportunidades/:id', async (req, res) => {
  try {
    const o = await carregarOportunidade(req.params.id, emp(req));
    if (!o) return res.status(404).json({ erro: 'Oportunidade não encontrada.' });
    const [hist, props] = await Promise.all([
      pool.query(
        `SELECT h.id, h.tipo, h.texto, h.data_criacao, u.nome AS usuario_nome
         FROM oportunidades_historico h LEFT JOIN usuarios u ON u.id = h.usuario_id
         WHERE h.oportunidade_id = $1 ORDER BY h.data_criacao DESC, h.id DESC LIMIT 200`, [o.id]),
      pool.query(
        `SELECT ${com.COLUNAS_PROPOSTA} FROM propostas p WHERE p.oportunidade_id = $1 ORDER BY p.id DESC`, [o.id])
    ]);
    res.json({ ...o, historico: hist.rows, propostas: props.rows });
  } catch (err) { erro500(res, 'Erro ao buscar oportunidade', err); }
});

async function validarOportunidade(b, empresa_id) {
  if (!vazioNulo(b.titulo)) return 'Informe o título (ex.: AMS SAP para a Empresa X).';
  if (vazioNulo(b.cliente_id) === null && !vazioNulo(b.empresa_nome) && !vazioNulo(b.contato_nome)) {
    return 'Escolha um cliente ou informe a empresa/contato do prospect.';
  }
  if (vazioNulo(b.cliente_id) !== null) {
    const c = await pool.query('SELECT 1 FROM clientes WHERE id = $1 AND empresa_id = $2', [b.cliente_id, empresa_id]);
    if (!c.rows.length) return 'Cliente inválido.';
  }
  if (b.origem && !com.ORIGENS[b.origem]) return 'Origem inválida.';
  if (b.etapa && !com.ETAPAS[b.etapa]) return 'Etapa inválida.';
  for (const k of ['valor_mensal', 'valor_unico']) {
    if (vazioNulo(b[k]) !== null && !(Number(b[k]) >= 0)) return 'Valores não podem ser negativos.';
  }
  if (vazioNulo(b.probabilidade) !== null && !(Number(b.probabilidade) >= 0 && Number(b.probabilidade) <= 100)) return 'Probabilidade: 0 a 100%.';
  if (vazioNulo(b.previsao_fechamento) !== null && !dataValida(b.previsao_fechamento)) return 'Previsão de fechamento inválida.';
  return null;
}

function paramsOportunidade(b) {
  return [
    vazioNulo(b.cliente_id), texto(b.titulo, 255), texto(b.empresa_nome, 255), texto(b.contato_nome, 255),
    texto(b.contato_email, 255), texto(b.contato_telefone, 50), texto(b.interesse, 60), b.origem || 'outro',
    Number(b.valor_mensal || 0), Number(b.valor_unico || 0),
    vazioNulo(b.probabilidade) === null ? null : Math.round(Number(b.probabilidade)),
    vazioNulo(b.previsao_fechamento), texto(b.observacoes, 5000)
  ];
}

router.post('/oportunidades', async (req, res) => {
  const b = req.body || {};
  try {
    const e = await validarOportunidade(b, emp(req));
    if (e) return res.status(400).json({ erro: e });
    const etapa = b.etapa && com.ETAPAS_ABERTAS.includes(b.etapa) ? b.etapa : 'lead';
    const p = paramsOportunidade(b);
    if (p[10] === null) p[10] = com.ETAPAS[etapa].prob;
    const r = await pool.query(
      `INSERT INTO oportunidades (cliente_id, titulo, empresa_nome, contato_nome, contato_email, contato_telefone,
         interesse, origem, valor_mensal, valor_unico, probabilidade, previsao_fechamento, observacoes,
         etapa, empresa_id, criado_por_usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [...p, etapa, emp(req), req.usuario.id]);
    await com.registrarHistorico(r.rows[0].id, 'sistema', `Oportunidade criada em ${com.ETAPAS[etapa].nome}.`, req.usuario.id);
    res.status(201).json({ mensagem: 'Oportunidade criada!', id: r.rows[0].id });
  } catch (err) { erro500(res, 'Erro ao criar oportunidade', err); }
});

// PUT não muda a etapa (use POST /:id/etapa, que registra no histórico)
router.put('/oportunidades/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const e = await validarOportunidade(b, emp(req));
    if (e) return res.status(400).json({ erro: e });
    const r = await pool.query(
      `UPDATE oportunidades SET cliente_id=$1, titulo=$2, empresa_nome=$3, contato_nome=$4, contato_email=$5,
         contato_telefone=$6, interesse=$7, origem=$8, valor_mensal=$9, valor_unico=$10,
         probabilidade=COALESCE($11, probabilidade), previsao_fechamento=$12, observacoes=$13,
         atualizado_por_usuario_id=$14, data_atualizacao=NOW()
       WHERE id=$15 AND empresa_id=$16 RETURNING id`,
      [...paramsOportunidade(b), req.usuario.id, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Oportunidade não encontrada.' });
    res.json({ mensagem: 'Oportunidade atualizada!' });
  } catch (err) { erro500(res, 'Erro ao atualizar oportunidade', err); }
});

router.delete('/oportunidades/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM oportunidades WHERE id = $1 AND empresa_id = $2 AND contrato_id IS NULL RETURNING id`,
      [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Não encontrada, ou já gerou contrato (não pode ser excluída).' });
    res.json({ mensagem: 'Oportunidade excluída.' });
  } catch (err) { erro500(res, 'Erro ao excluir oportunidade', err); }
});

router.post('/oportunidades/:id/etapa', async (req, res) => {
  const { etapa, motivo_perda } = req.body || {};
  if (!com.ETAPAS[etapa]) return res.status(400).json({ erro: 'Etapa inválida.' });
  if (etapa === 'perdida' && !vazioNulo(motivo_perda)) return res.status(400).json({ erro: 'Informe o motivo da perda.' });
  try {
    const o = await carregarOportunidade(req.params.id, emp(req));
    if (!o) return res.status(404).json({ erro: 'Oportunidade não encontrada.' });
    await com.mudarEtapa(o.id, etapa, req.usuario.id, { motivo_perda: texto(motivo_perda, 255) });
    res.json({ mensagem: `Movida para ${com.ETAPAS[etapa].nome}.` });
  } catch (err) { erro500(res, 'Erro ao mudar etapa', err); }
});

router.post('/oportunidades/:id/notas', async (req, res) => {
  const t = texto((req.body || {}).texto, 5000);
  if (!t) return res.status(400).json({ erro: 'Escreva a nota.' });
  try {
    const o = await carregarOportunidade(req.params.id, emp(req));
    if (!o) return res.status(404).json({ erro: 'Oportunidade não encontrada.' });
    await com.registrarHistorico(o.id, 'nota', t, req.usuario.id);
    await pool.query('UPDATE oportunidades SET data_atualizacao = NOW() WHERE id = $1', [o.id]);
    res.status(201).json({ mensagem: 'Nota registrada.' });
  } catch (err) { erro500(res, 'Erro ao registrar nota', err); }
});

// POST /oportunidades/:id/gerar-contrato { dia_vencimento, data_inicio, descricao, descricao_servico, valor }
// ou, para proposta do Conector SAP, { dia_vencimento, data_inicio, conector: { vagas: { abap, funcional, ambos }, modalidade,
//   ciclo, precos, gestor_nome?, gestor_email?, data_fim? } } — cria o contrato do Conector com licenças, preço e cobrança.
// Cria o cliente (se for prospect) e marca a oportunidade como ganha.
router.post('/oportunidades/:id/gerar-contrato', async (req, res) => {
  const b = req.body || {};
  const cc = require('../services/contratos-conector');
  const dia = Number(b.dia_vencimento || 10);
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) return res.status(400).json({ erro: 'Dia de vencimento: 1 a 28.' });
  if (!dataValida(b.data_inicio)) return res.status(400).json({ erro: 'Data de início inválida.' });
  if (!b.conector) {
    if (!(Number(b.valor) > 0)) return res.status(400).json({ erro: 'Valor mensal deve ser maior que zero.' });
    if (!vazioNulo(b.descricao) || !vazioNulo(b.descricao_servico)) return res.status(400).json({ erro: 'Informe o nome do contrato e a descrição do serviço.' });
  }
  const client = await pool.connect();
  try {
    const o = await carregarOportunidade(req.params.id, emp(req));
    if (!o) return res.status(404).json({ erro: 'Oportunidade não encontrada.' });
    await client.query('BEGIN');
    // Trava a oportunidade: dois cliques simultâneos não geram dois contratos
    const trava = await client.query('SELECT contrato_id FROM oportunidades WHERE id = $1 FOR UPDATE', [o.id]);
    if (trava.rows[0].contrato_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Esta oportunidade já gerou um contrato.' });
    }
    let clienteId = o.cliente_id;
    let clienteNovo = false;
    if (!clienteId) {
      const nome = o.empresa_nome || o.contato_nome;
      const c = await client.query(
        `INSERT INTO clientes (nome, razao_social, email, email_financeiro, telefone, responsavel_nome, responsavel_email,
           responsavel_telefone, status, ativo, empresa_id, criado_por_usuario_id)
         VALUES ($1, $2, $3, $3, $4, $5, $3, $4, 'ativo', TRUE, $6, $7) RETURNING id`,
        [nome, o.empresa_nome, o.contato_email, o.contato_telefone, o.contato_nome, emp(req), req.usuario.id]);
      clienteId = c.rows[0].id;
      clienteNovo = true;
      await client.query('UPDATE oportunidades SET cliente_id = $1 WHERE id = $2', [clienteId, o.id]);
    }
    // Proposta aceita (a mais recente): os itens vão para o contrato e o valor único vira fatura avulsa em rascunho
    const proposta = (await client.query(
      `SELECT id, numero, versao, itens, total_unico::float AS total_unico FROM propostas
       WHERE oportunidade_id = $1 AND empresa_id = $2 AND status = 'aceita' ORDER BY data_resposta DESC NULLS LAST, id DESC LIMIT 1`,
      [o.id, emp(req)])).rows[0] || null;
    let ct, conector = null;
    if (b.conector) {
      // Proposta do Conector: contrato com as licenças e o preço da proposta (o gestor recebe convite para o portal)
      const k = b.conector;
      const { q } = cc.lerQuantidades(k.vagas);
      const fimPadrao = (() => { const d = new Date(`${b.data_inicio}T12:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
      const fim = k.data_fim || fimPadrao;
      if (!dataValida(fim) || fim < b.data_inicio) throw new cc.ErroRegra('Fim do contrato inválido.');
      conector = await cc.criarContrato(client, {
        empresaId: emp(req), clienteId, gestorNome: k.gestor_nome || o.contato_nome, gestorEmail: k.gestor_email || o.contato_email,
        q, inicio: b.data_inicio, fim, precos: cc.lerPrecos(k.precos), modalidade: cc.lerModalidade(k.modalidade), ciclo: cc.lerCiclo(k.ciclo),
        cobranca: { gerar: true, dia_vencimento: dia }, usuarioId: req.usuario.id,
        observacoes: `Gerado da oportunidade #${o.id} (${o.titulo})${proposta ? `, proposta ${proposta.numero} v${proposta.versao}` : ''}.` });
      await client.query('UPDATE contratos SET proposta_id = $2 WHERE id = $1', [conector.cobranca.id, proposta && proposta.id]);
      ct = { rows: [{ id: conector.cobranca.id }] };
    } else {
      ct = await client.query(
        `INSERT INTO contratos (empresa_id, cliente_id, descricao, descricao_servico, valor, dia_vencimento, data_inicio,
           emitir_nfse, status, observacoes, criado_por_usuario_id, proposta_id, itens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'ativo', $8, $9, $10, $11) RETURNING id`,
        [emp(req), clienteId, texto(b.descricao, 255), String(b.descricao_servico).trim(), Number(b.valor), dia,
         b.data_inicio, `Gerado da oportunidade #${o.id} (${o.titulo}).`, req.usuario.id,
         proposta && proposta.id, proposta && JSON.stringify(proposta.itens)]);
    }
    let faturaUnica = null;
    if (proposta && proposta.total_unico > 0) {
      const cfg = (await client.query('SELECT * FROM financeiro_config WHERE empresa_id = $1', [emp(req)])).rows[0] || {};
      const unicos = (proposta.itens || []).filter(i => i.tipo === 'unico').map(i => i.descricao).filter(Boolean);
      faturaUnica = (await client.query(
        `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, status,
           emitir_nfse, codigo_servico, nome_servico, aliquota_iss, ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss, criado_por_usuario_id, observacoes)
         VALUES ($1, $2, date_trunc('month', $3::date)::date, $4, $5,
           (date_trunc('month', $3::date) + INTERVAL '1 month' + ($6::int - 1) * INTERVAL '1 day')::date, 'rascunho',
           TRUE, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [emp(req), clienteId, b.data_inicio, unicos.length ? unicos.join('; ') : `${texto(b.descricao, 200) || o.titulo} — valor único`,
         proposta.total_unico, dia, cfg.codigo_servico || null, cfg.nome_servico || null, cfg.aliquota_iss || 0,
         cfg.ret_ir || 0, cfg.ret_csll || 0, cfg.ret_pis || 0, cfg.ret_cofins || 0, cfg.ret_inss || 0, req.usuario.id,
         `Valor único da proposta ${proposta.numero} v${proposta.versao}.`])).rows[0].id;
    }
    if (!conector) {
      await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato.criado', entidade: 'contrato',
        entidade_id: ct.rows[0].id, depois: { valor: Number(b.valor), oportunidade_id: o.id, proposta_id: proposta && proposta.id },
        detalhe: faturaUnica ? `Fatura avulsa #${faturaUnica} (valor único) criada como rascunho.` : null }, client);
    }
    await client.query('UPDATE oportunidades SET contrato_id = $1 WHERE id = $2', [ct.rows[0].id, o.id]);
    await com.mudarEtapa(o.id, 'ganha', req.usuario.id, { client });
    await com.registrarHistorico(o.id, 'sistema', conector
      ? `Contrato do Conector nº ${conector.k.id} gerado (${conector.cobranca.ciclo === 'mensal' ? 'cobrança mensal' : 'cobrança anual'} #${ct.rows[0].id})${clienteNovo ? ' e cliente cadastrado' : ''}.`
      : `Contrato #${ct.rows[0].id} gerado${clienteNovo ? ' e cliente cadastrado' : ''}.`, req.usuario.id, client);
    await client.query('COMMIT');
    const convite = conector && conector.criado ? await cc.enviarConvite(conector.gestor) : false;
    res.status(201).json({
      mensagem: (conector
        ? `Contrato do Conector criado com as licenças e o preço da proposta; cobrança ${conector.cobranca.ciclo === 'mensal' ? 'mensal' : 'anual'} de R$ ${conector.cobranca.valor.toFixed(2).replace('.', ',')} em Contratos.` +
          (conector.criado ? (convite ? ` Convite enviado ao gestor (${conector.gestor.email}).` : ' O convite ao gestor não pôde ser enviado; reenvie pelo contrato.') : '')
        : `Contrato criado.` + (proposta ? ` Itens da proposta ${proposta.numero} copiados para o contrato.` : '')) +
        (clienteNovo ? ' Prospect cadastrado como cliente (complete CNPJ e endereço em Clientes).' : '') +
        (faturaUnica ? ' O valor único virou uma fatura avulsa em rascunho no Faturamento.' : ''),
      contrato_id: ct.rows[0].id, contrato_conector_id: conector && conector.k.id,
      cliente_id: clienteId, cliente_novo: clienteNovo, fatura_unica_id: faturaUnica
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof cc.ErroRegra) return res.status(400).json({ erro: err.message });
    erro500(res, 'Erro ao gerar contrato', err);
  } finally { client.release(); }
});

// ===== Resumo do funil =====
router.get('/resumo', async (req, res) => {
  try { res.json(await com.resumoFunil(emp(req))); }
  catch (err) { erro500(res, 'Erro ao montar resumo', err); }
});

// ===== Configuração das propostas =====
router.get('/config', async (req, res) => {
  try { res.json(await com.configProposta(emp(req))); }
  catch (err) { erro500(res, 'Erro ao buscar configuração', err); }
});

router.put('/config', async (req, res) => {
  const b = req.body || {};
  const dias = Number(b.prop_validade_dias || 15);
  if (!Number.isInteger(dias) || dias < 1 || dias > 180) return res.status(400).json({ erro: 'Validade: 1 a 180 dias.' });
  try {
    await pool.query(
      `INSERT INTO financeiro_config (empresa_id, prop_razao_social, prop_cnpj, prop_contato, prop_apresentacao,
         prop_condicoes_padrao, prop_validade_dias, data_atualizacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET prop_razao_social = EXCLUDED.prop_razao_social,
         prop_cnpj = EXCLUDED.prop_cnpj, prop_contato = EXCLUDED.prop_contato,
         prop_apresentacao = EXCLUDED.prop_apresentacao, prop_condicoes_padrao = EXCLUDED.prop_condicoes_padrao,
         prop_validade_dias = EXCLUDED.prop_validade_dias, data_atualizacao = NOW()`,
      [emp(req), texto(b.prop_razao_social, 255), texto(b.prop_cnpj, 30), texto(b.prop_contato, 255),
       texto(b.prop_apresentacao, 5000), texto(b.prop_condicoes_padrao, 5000), dias]);
    res.json({ mensagem: 'Configuração salva!' });
  } catch (err) { erro500(res, 'Erro ao salvar configuração', err); }
});

// ===== Simulador de preço — Conector SAP =====
// Cálculo puro em services/precificacao-conector.js; a tabela de preços da empresa vem de services/comercial.js.
const precosConector = com.precosConector;
const simularConector = com.simularConector;

router.get('/simulador-conector/config', async (req, res) => {
  try {
    res.json({ precos: await precosConector(emp(req)), padrao: conector.PRECOS_PADRAO, rotulos: conector.ROTULOS_PRECOS });
  } catch (err) { erro500(res, 'Erro ao buscar tabela de preços', err); }
});

// PUT { precos: {...} } — só as chaves conhecidas; vazio = volta ao padrão
router.put('/simulador-conector/config', async (req, res) => {
  const entrada = (req.body || {}).precos || {};
  const v = conector.normalizarPrecos(entrada, { validar: true });
  if (v.erro) return res.status(400).json({ erro: v.erro });
  try {
    await pool.query(
      `INSERT INTO financeiro_config (empresa_id, prop_precos_conector, data_atualizacao) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET prop_precos_conector = EXCLUDED.prop_precos_conector, data_atualizacao = NOW()`,
      [emp(req), JSON.stringify(v.precos)]);
    res.json({ mensagem: 'Tabela de preços salva!', precos: v.precos });
  } catch (err) { erro500(res, 'Erro ao salvar tabela de preços', err); }
});

// POST /simulador-conector/calcular { funcionais, abaps, ciclo, modalidade, sistemas, porte, chamados_p/m/g, pacotes,
//   desconto_pct, desconto_meses, desconto_implantacao, validade_dias, roi_* } → itens, totais, comparação e ROI
router.post('/simulador-conector/calcular', async (req, res) => {
  try {
    const s = await simularConector(req.body || {}, emp(req));
    if (s.erro) return res.status(400).json({ erro: s.erro });
    res.json(s.resultado);
  } catch (err) { erro500(res, 'Erro ao calcular simulação', err); }
});

// ===== Propostas =====
const carregarPropostaEmp = (id, empresa_id) => com.carregarProposta('p.id = $1 AND p.empresa_id = $2', [id, empresa_id]);

router.get('/propostas/:id', async (req, res) => {
  try {
    const p = await carregarPropostaEmp(req.params.id, emp(req));
    if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    res.json({ ...p, config: await com.configProposta(emp(req)), link: p.token ? com.linkPublico(p.token) : null });
  } catch (err) { erro500(res, 'Erro ao buscar proposta', err); }
});

function validarProposta(b) {
  if (!vazioNulo(b.titulo)) return { erro: 'Informe o título da proposta.' };
  if (!dataValida(b.validade)) return { erro: 'Data de validade inválida.' };
  return com.calcularItens(b.itens);
}

// POST /oportunidades/:id/propostas — nova proposta, ou { copiar_de } para criar a próxima versão,
// ou { simulador_conector: {entradas}, incluir_roi } para criar já preenchida pelo simulador do Conector SAP
router.post('/oportunidades/:id/propostas', async (req, res) => {
  const b = req.body || {};
  // Simulador: valida antes de abrir a transação (erro de entrada = 400)
  let sim = null;
  if (b.simulador_conector && !b.copiar_de) {
    sim = await simularConector(b.simulador_conector, emp(req)).catch(err => ({ falha: err }));
    if (sim.falha) return erro500(res, 'Erro ao calcular simulação', sim.falha);
    if (sim.erro) return res.status(400).json({ erro: sim.erro });
  }
  const client = await pool.connect();
  try {
    const o = await carregarOportunidade(req.params.id, emp(req));
    if (!o) return res.status(404).json({ erro: 'Oportunidade não encontrada.' });
    const cfg = await com.configProposta(emp(req));
    let validadeDias = cfg.prop_validade_dias;
    await client.query('BEGIN');
    let dados;
    if (sim) {
      // Itens passam pela mesma normalização da edição manual (calcularItens): totais batem com o editor
      const r = sim.resultado;
      const itens = com.calcularItens(r.itens);
      if (itens.erro) { await client.query('ROLLBACK'); return res.status(400).json({ erro: itens.erro }); }
      const cliente = o.nome_exibicao || o.contato_nome || o.titulo;
      dados = {
        numero: await com.proximoNumero(client, emp(req)), versao: 1,
        titulo: `Conector SAP Marsh — ${cliente}`.slice(0, 255),
        ...conector.textosProposta(r, cfg, { incluirRoi: b.incluir_roi !== false }),
        itens: itens.itens, total_mensal: itens.total_mensal, total_unico: itens.total_unico,
        conector: com.conectorDaSimulacao(r, sim.precos) // "Gerar contrato" cria o contrato do Conector com isto
      };
      validadeDias = r.entradas.validade_dias;
    } else if (b.copiar_de) {
      const base = await carregarPropostaEmp(b.copiar_de, emp(req));
      if (!base || base.oportunidade_id !== o.id) { await client.query('ROLLBACK'); return res.status(400).json({ erro: 'Proposta de origem inválida.' }); }
      const v = await client.query('SELECT MAX(versao) AS v FROM propostas WHERE empresa_id = $1 AND numero = $2', [emp(req), base.numero]);
      dados = { ...base, versao: v.rows[0].v + 1 };
    } else {
      dados = {
        numero: await com.proximoNumero(client, emp(req)), versao: 1,
        titulo: o.titulo, introducao: cfg.prop_apresentacao, escopo: '', condicoes: cfg.prop_condicoes_padrao,
        itens: [
          ...(o.valor_mensal > 0 ? [{ descricao: o.titulo, tipo: 'mensal', quantidade: 1, valor_unitario: o.valor_mensal, total: o.valor_mensal }] : []),
          ...(o.valor_unico > 0 ? [{ descricao: 'Implantação', tipo: 'unico', quantidade: 1, valor_unitario: o.valor_unico, total: o.valor_unico }] : [])
        ],
        total_mensal: o.valor_mensal, total_unico: o.valor_unico
      };
    }
    const r = await client.query(
      `INSERT INTO propostas (empresa_id, oportunidade_id, numero, versao, titulo, introducao, escopo, condicoes, itens,
         total_mensal, total_unico, validade, criado_por_usuario_id, conector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11, CURRENT_DATE + $12::int, $13, $14) RETURNING id`,
      [emp(req), o.id, dados.numero, dados.versao, dados.titulo, dados.introducao, dados.escopo, dados.condicoes,
       JSON.stringify(dados.itens || []), dados.total_mensal || 0, dados.total_unico || 0, validadeDias, req.usuario.id,
       dados.conector ? JSON.stringify(dados.conector) : null]);
    await com.registrarHistorico(o.id, 'proposta', `Proposta ${dados.numero}${dados.versao > 1 ? ` v${dados.versao}` : ''} criada (rascunho)` +
      (sim ? ` pelo simulador do Conector SAP: ${sim.resultado.comparacao.usuarios} usuário(s), plano ${sim.resultado.modalidade_escolhida}, ciclo ${sim.resultado.entradas.ciclo}.` : '.'),
      req.usuario.id, client);
    await client.query('COMMIT');
    res.status(201).json({ mensagem: 'Proposta criada como rascunho.', id: r.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    erro500(res, 'Erro ao criar proposta', err);
  } finally { client.release(); }
});

// PUT /propostas/:id — só rascunho (depois de enviada, crie uma nova versão)
router.put('/propostas/:id', async (req, res) => {
  const b = req.body || {};
  const v = validarProposta(b);
  if (v.erro) return res.status(400).json({ erro: v.erro });
  try {
    const r = await pool.query(
      `UPDATE propostas SET titulo=$1, introducao=$2, escopo=$3, condicoes=$4, itens=$5::jsonb, total_mensal=$6,
         total_unico=$7, validade=$8, atualizado_por_usuario_id=$9, data_atualizacao=NOW()
       WHERE id=$10 AND empresa_id=$11 AND status='rascunho' RETURNING oportunidade_id`,
      [texto(b.titulo, 255), texto(b.introducao, 10000), texto(b.escopo, 20000), texto(b.condicoes, 10000),
       JSON.stringify(v.itens), v.total_mensal, v.total_unico, b.validade, req.usuario.id, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só rascunhos podem ser editados. Para mudar uma proposta enviada, crie uma nova versão.' });
    res.json({ mensagem: 'Proposta salva!' });
  } catch (err) { erro500(res, 'Erro ao salvar proposta', err); }
});

router.delete('/propostas/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM propostas WHERE id = $1 AND empresa_id = $2 AND status = 'rascunho' RETURNING oportunidade_id, numero`,
      [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só rascunhos podem ser excluídos.' });
    await com.registrarHistorico(r.rows[0].oportunidade_id, 'proposta', `Rascunho da proposta ${r.rows[0].numero} excluído.`, req.usuario.id);
    res.json({ mensagem: 'Rascunho excluído.' });
  } catch (err) { erro500(res, 'Erro ao excluir proposta', err); }
});

// POST /propostas/:id/enviar { enviar_email } — gera o link público; opcionalmente manda por e-mail ao contato
router.post('/propostas/:id/enviar', async (req, res) => {
  try {
    const p = await carregarPropostaEmp(req.params.id, emp(req));
    if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (!['rascunho', 'enviada'].includes(p.status)) return res.status(400).json({ erro: 'Proposta já respondida.' });
    if (!p.itens || !p.itens.length) return res.status(400).json({ erro: 'Inclua ao menos um item antes de enviar.' });
    const token = p.token || crypto.randomBytes(24).toString('hex');
    await pool.query(
      `UPDATE propostas SET status = 'enviada', token = $1, data_envio = COALESCE(data_envio, NOW()),
         atualizado_por_usuario_id = $2, data_atualizacao = NOW() WHERE id = $3`, [token, req.usuario.id, p.id]);
    // Versões anteriores ainda pendentes deixam de valer
    await pool.query(
      `UPDATE propostas SET status = 'substituida', data_atualizacao = NOW()
       WHERE empresa_id = $1 AND numero = $2 AND versao < $3 AND status IN ('rascunho', 'enviada')`,
      [emp(req), p.numero, p.versao]);
    if (['lead', 'qualificacao'].includes(p.etapa)) await com.mudarEtapa(p.oportunidade_id, 'proposta', req.usuario.id);
    await pool.query(
      `UPDATE oportunidades SET valor_mensal = $1, valor_unico = $2, data_atualizacao = NOW() WHERE id = $3`,
      [p.total_mensal, p.total_unico, p.oportunidade_id]);

    const link = com.linkPublico(token);
    let enviado = false;
    if ((req.body || {}).enviar_email) {
      if (!email.emailConfigurado()) return res.status(400).json({ erro: 'Envio de e-mail não configurado (RESEND_API_KEY). O link foi gerado: copie e envie manualmente.', link });
      if (!p.contato_email) return res.status(400).json({ erro: 'A oportunidade não tem e-mail de contato. O link foi gerado: copie e envie manualmente.', link });
      const fin = await pool.query('SELECT email_copia FROM financeiro_config WHERE empresa_id = $1', [emp(req)]);
      enviado = await email.enviarProposta({
        proposta: p, para: p.contato_email, nomeContato: p.contato_nome, link,
        copia: fin.rows[0] && fin.rows[0].email_copia
      });
    }
    await com.registrarHistorico(p.oportunidade_id, 'proposta',
      `Proposta ${p.numero}${p.versao > 1 ? ` v${p.versao}` : ''} enviada${enviado ? ` por e-mail para ${p.contato_email}` : ' (link gerado)'}.`,
      req.usuario.id);
    res.json({ mensagem: enviado ? 'Proposta enviada por e-mail!' : 'Link da proposta gerado.', link, enviado });
  } catch (err) { erro500(res, 'Erro ao enviar proposta', err); }
});

// POST /propostas/:id/status { status: aceita|recusada } — resposta recebida fora do link (telefone, e-mail)
router.post('/propostas/:id/status', async (req, res) => {
  const { status, comentario } = req.body || {};
  if (!['aceita', 'recusada'].includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  try {
    const p = await carregarPropostaEmp(req.params.id, emp(req));
    if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (!['rascunho', 'enviada'].includes(p.status)) return res.status(400).json({ erro: 'Proposta já respondida.' });
    await pool.query(
      `UPDATE propostas SET status = $1, data_resposta = NOW(), resposta_comentario = $2,
         atualizado_por_usuario_id = $3, data_atualizacao = NOW() WHERE id = $4`,
      [status, texto(comentario, 2000), req.usuario.id, p.id]);
    await com.registrarHistorico(p.oportunidade_id, 'proposta',
      `Proposta ${p.numero} marcada como ${status} manualmente.${comentario ? ` ${comentario}` : ''}`, req.usuario.id);
    if (status === 'aceita') await com.mudarEtapa(p.oportunidade_id, 'ganha', req.usuario.id);
    res.json({ mensagem: status === 'aceita' ? 'Proposta aceita! Oportunidade marcada como ganha.' : 'Proposta marcada como recusada.' });
  } catch (err) { erro500(res, 'Erro ao atualizar proposta', err); }
});

module.exports = router;
