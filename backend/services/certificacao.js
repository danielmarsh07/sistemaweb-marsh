/**
 * certificacao.js — certificado da vaga e licença individual do Conector.
 *
 * Quem ocupa uma vaga e conclui TODAS as aulas dos cursos publicados incluídos no perfil (cadastro de benefícios) ganha:
 *   1. um certificado gravado (código verificável em /certificado.html?c=CODIGO);
 *   2. uma licença só dele: chave própria, 1 máquina, plano do perfil, SIDs e validade do contrato.
 * O perfil precisa ter ao menos um curso publicado com aula (senão não há o que concluir).
 * A licença acompanha o contrato: SIDs, fim e status são copiados de novo a cada mudança (sincronizarContrato).
 * Liberar a vaga cancela a licença; se a mesma pessoa voltar, a licença dela volta a valer (mesma chave).
 */
const crypto = require('crypto');
const pool = require('../db');
const cifra = require('./cifra');
const { gerarChave, hashChave, prefixoChave } = require('./licenca');
const { PERFIS, TRILHAS } = require('./contratos-conector');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gerarCodigo = () => 'MC-' + Array.from({ length: 8 }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('');
const hojeBrasilia = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

const STATUS_LICENCA = { ativo: 'ativa', suspenso: 'suspensa', cancelado: 'cancelada' };

/**
 * Cursos do perfil (cadastro de benefícios) com o progresso do usuário, agrupados por trilha para exibir.
 * completo = pode certificar: há ao menos um curso com aula e todas as aulas de todos foram concluídas.
 */
async function progressoPerfil(db, perfil, usuarioId) {
  const ordem = PERFIS[perfil] ? PERFIS[perfil].trilhas : [];
  const r = await db.query(
    `SELECT c.id, c.titulo, c.trilha, c.carga_horaria,
            (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo) AS total,
            (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
              WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS feitas
     FROM beneficios b JOIN cursos c ON c.id = b.curso_id
     WHERE b.produto = 'conector' AND b.perfil = $1 AND b.ativo AND c.ativo AND c.status = 'publicado'
     ORDER BY COALESCE(array_position($3::text[], c.trilha::text), 99), c.ordem, c.titulo`, [perfil, usuarioId, ordem]);
  const comAula = r.rows.filter(c => c.total > 0);
  const chaves = [...new Set(comAula.map(c => c.trilha || 'outros'))];
  const porTrilha = chaves.map(t => {
    const cursos = comAula.filter(c => (c.trilha || 'outros') === t);
    return { trilha: t, nome: TRILHAS[t] || 'Outros cursos', cursos, concluida: cursos.every(c => c.feitas >= c.total) };
  });
  const total = comAula.reduce((s, c) => s + c.total, 0);
  const feitas = comAula.reduce((s, c) => s + Math.min(c.feitas, c.total), 0);
  return { trilhas: porTrilha, total, feitas, completo: comAula.length > 0 && porTrilha.every(t => t.concluida) };
}

/** Linhas de licença a partir do contrato (SIDs, conexões, fim, status). */
function dadosDoContrato(k) {
  const conexoes = Array.isArray(k.conexoes) ? k.conexoes : [];
  return {
    sids: conexoes.map(c => c.sid).join(','),
    conexoes: JSON.stringify(conexoes),
    data_fim: k.data_fim,
    status: STATUS_LICENCA[k.status] || 'suspensa'
  };
}

/** Cria (ou reativa) a licença da pessoa na vaga. Devolve a linha. */
async function garantirLicenca(db, k, vaga, usuario) {
  const d = dadosDoContrato(k);
  const atual = (await db.query('SELECT * FROM licencas WHERE vaga_id = $1 AND usuario_id = $2', [vaga.id, usuario.id])).rows[0];
  if (atual) {
    const r = await db.query(
      `UPDATE licencas SET status = $1, sids = $2, conexoes = $3::jsonb, data_fim = $4, ativo = TRUE,
         titular_nome = $5, titular_email = $6, data_atualizacao = NOW() WHERE id = $7 RETURNING *`,
      [d.status, d.sids, d.conexoes, d.data_fim, usuario.nome, usuario.email, atual.id]);
    return r.rows[0];
  }
  const chave = gerarChave();
  const r = await db.query(
    `INSERT INTO licencas (empresa_id, cliente_id, plano, max_usuarios, max_maquinas, sids, conexoes, data_inicio, data_fim,
       status, chave_hash, chave_prefixo, chave_cifrada, titular_nome, titular_email, vaga_id, usuario_id, observacoes,
       chamados_exigem_aprovacao)
     -- max_usuarios vazio: o limite é a máquina (1); a mesma pessoa pode ter usuários SAP diferentes por sistema
     VALUES ($1, $2, $3, NULL, 1, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, TRUE) RETURNING *`,
    [k.empresa_id, k.cliente_id, PERFIS[vaga.perfil].plano, d.sids, d.conexoes, hojeBrasilia(), d.data_fim, d.status,
     hashChave(chave), prefixoChave(chave), cifra.configurada() ? cifra.cifrar(chave) : null,
     usuario.nome, usuario.email, vaga.id, usuario.id,
     `Licença individual da vaga ${PERFIS[vaga.perfil].nome} do contrato nº ${k.id}.`]);
  return r.rows[0];
}

/**
 * Confere as vagas do usuário: quem concluiu o perfil ganha certificado e licença (idempotente).
 * Devolve a lista de certificados emitidos agora.
 */
async function avaliarUsuario(usuarioId) {
  const vagas = (await pool.query(
    `SELECT v.*, row_to_json(k.*) AS contrato
     FROM contratos_conector_vagas v JOIN contratos_conector k ON k.id = v.contrato_id
     WHERE v.usuario_id = $1 AND v.ativo AND k.status = 'ativo'
       AND k.data_inicio <= CURRENT_DATE AND k.data_fim >= CURRENT_DATE`, [usuarioId])).rows;
  if (!vagas.length) return [];
  const usuario = (await pool.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [usuarioId])).rows[0];
  const emitidos = [];
  for (const vaga of vagas) {
    const k = vaga.contrato;
    let cert = (await pool.query('SELECT * FROM certificados WHERE usuario_id = $1 AND vaga_id = $2', [usuarioId, vaga.id])).rows[0];
    if (!cert) {
      const prog = await progressoPerfil(pool, vaga.perfil, usuarioId);
      if (!prog.completo) {
        // Exceção do contrato: licença sem os cursos (o certificado sai quando concluir)
        if (k.licenca_sem_curso) {
          const lic = (await pool.query(`SELECT status, ativo FROM licencas WHERE vaga_id = $1 AND usuario_id = $2`, [vaga.id, usuarioId])).rows[0];
          if (precisaReativar(lic)) await garantirLicenca(pool, k, vaga, usuario);
        }
        continue;
      }
      const cursos = prog.trilhas.flatMap(t => t.cursos.map(c => ({ titulo: c.titulo, carga_horaria: c.carga_horaria, trilha: t.trilha })));
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        cert = (await db.query(
          `INSERT INTO certificados (codigo, usuario_id, vaga_id, contrato_id, perfil, nome, cursos)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (usuario_id, vaga_id) DO NOTHING RETURNING *`,
          [gerarCodigo(), usuarioId, vaga.id, k.id, vaga.perfil, usuario.nome, JSON.stringify(cursos)])).rows[0];
        if (cert) await garantirLicenca(db, k, vaga, usuario);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        db.release();
      }
      if (cert) emitidos.push(cert);
      continue;
    }
    // Já certificado: a licença precisa estar valendo (ex.: a pessoa voltou para a vaga)
    const lic = (await pool.query(`SELECT status, ativo FROM licencas WHERE vaga_id = $1 AND usuario_id = $2`, [vaga.id, usuarioId])).rows[0];
    if (precisaReativar(lic)) await garantirLicenca(pool, k, vaga, usuario);
  }
  return emitidos;
}

/**
 * A vaga está ocupada e o contrato vale, então a licença da pessoa tem que estar valendo: falta, foi cancelada
 * ou foi excluída na tela Licenças (ativo = false, mesmo que o status tenha voltado para "ativa").
 */
function precisaReativar(lic) {
  return !lic || lic.status === 'cancelada' || !lic.ativo;
}

/** Copia SIDs, conexões, fim e status do contrato para as licenças das vagas ocupadas por quem as tem. */
async function sincronizarContrato(contratoId) {
  const k = (await pool.query('SELECT * FROM contratos_conector WHERE id = $1', [contratoId])).rows[0];
  if (!k) return;
  const d = dadosDoContrato(k);
  await pool.query(
    `UPDATE licencas l SET sids = $1, conexoes = $2::jsonb, data_fim = $3, status = $4, data_atualizacao = NOW()
     FROM contratos_conector_vagas v
     WHERE l.vaga_id = v.id AND v.contrato_id = $5 AND l.usuario_id = v.usuario_id AND v.ativo AND l.ativo`,
    [d.sids, d.conexoes, d.data_fim, d.status, k.id]);
}

/** Vaga liberada: a licença daquela pessoa naquela vaga para de valer. */
async function cancelarLicencaVaga(vagaId, usuarioId) {
  await pool.query(
    `UPDATE licencas SET status = 'cancelada', data_atualizacao = NOW() WHERE vaga_id = $1 AND usuario_id = $2`,
    [vagaId, usuarioId]);
}

/** Dados da licença para o portal da própria pessoa (com a chave, se estiver guardada). */
function licencaParaPortal(l) {
  if (!l) return null;
  let chave = null;
  if (l.chave_cifrada && cifra.configurada()) { try { chave = cifra.decifrar(l.chave_cifrada); } catch { chave = null; } }
  return {
    id: l.id, plano: l.plano, status: l.status, data_fim: l.data_fim, sids: l.sids, chave, chave_prefixo: l.chave_prefixo,
    max_maquinas: l.max_maquinas, maquinas_ativas: l.maquinas_ativas, maquina_nome: l.maquina_nome,
    vigente: l.status === 'ativa' && l.vigente
  };
}

module.exports = {
  progressoPerfil, avaliarUsuario, garantirLicenca, sincronizarContrato, cancelarLicencaVaga, licencaParaPortal, gerarCodigo
};
