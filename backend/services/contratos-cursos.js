/**
 * contratos-cursos.js — contrato de cursos POR PESSOAS.
 *
 * O contrato tem os cursos (contratos_cursos_itens) e N vagas (contratos_cursos_vagas). Cada vaga é uma pessoa:
 * convite por e-mail (pessoa nova = 'convidada' até criar a senha; quem já tem acesso = 'ativa'). Só quem ocupa
 * uma vaga ativa, de contrato vigente, vê os cursos (regra viva em contratos-conector.sqlViaContratoCursos).
 * A Marsh (admin) e o gestor da empresa (administrador corporativo, no portal) preenchem as vagas.
 * É independente do Conector: serve, por exemplo, para dar o curso de ABAP a quem tem licença Funcional.
 */
const pool = require('../db');
const auditoria = require('./auditoria');
const cc = require('./contratos-conector');
const senhas = require('./senhas');

const { ErroRegra } = cc;
const MAX_VAGAS = 500;

function lerVagas(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > MAX_VAGAS) throw new ErroRegra(`Número de vagas: de 1 a ${MAX_VAGAS}.`);
  return v;
}

async function criarVagas(db, contratoId, n) {
  await db.query(`INSERT INTO contratos_cursos_vagas (contrato_id) SELECT $1 FROM generate_series(1, $2::int)`, [contratoId, n]);
}

/** Muda o total de vagas: acrescenta livres ou desativa livres (nunca tira alguém da vaga). */
async function ajustarVagas(db, k, total) {
  total = lerVagas(total);
  const r = (await db.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE usuario_id IS NOT NULL)::int AS ocupadas
     FROM contratos_cursos_vagas WHERE contrato_id = $1 AND ativo`, [k.id])).rows[0];
  if (total > r.total) await criarVagas(db, k.id, total - r.total);
  if (total < r.total) {
    if (total < r.ocupadas) throw new ErroRegra(`${r.ocupadas} vaga(s) estão com pessoas. Libere vagas antes de diminuir para ${total}.`);
    await db.query(
      `UPDATE contratos_cursos_vagas SET ativo = FALSE WHERE id IN (
         SELECT id FROM contratos_cursos_vagas WHERE contrato_id = $1 AND ativo AND usuario_id IS NULL ORDER BY id DESC LIMIT $2)`,
      [k.id, r.total - total]);
  }
}

/** Contrato com cursos, vagas, ocupantes e o progresso de cada um nos cursos do contrato. */
async function detalhar(id, db = pool) {
  const k = (await db.query(
    `SELECT k.id, k.empresa_id, k.cliente_id, k.status, k.cobranca, k.valor::float AS valor, k.observacoes,
            to_char(k.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
            (k.status = 'ativo' AND k.data_inicio <= CURRENT_DATE AND (k.data_fim IS NULL OR k.data_fim >= CURRENT_DATE)) AS vigente,
            COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente_nome,
            (SELECT ct.id FROM contratos ct WHERE ct.contrato_cursos_id = k.id ORDER BY ct.id DESC LIMIT 1) AS contrato_financeiro_id
     FROM contratos_cursos k JOIN clientes cl ON cl.id = k.cliente_id WHERE k.id = $1`, [id])).rows[0];
  if (!k) return null;
  k.cursos = (await db.query(
    `SELECT c.id, c.titulo, c.status FROM contratos_cursos_itens it JOIN cursos c ON c.id = it.curso_id
     WHERE it.contrato_id = $1 ORDER BY c.ordem, c.titulo`, [id])).rows;
  k.vagas = (await db.query(
    `SELECT v.id, v.usuario_id, v.estado, v.convidado_em, v.data_atribuicao, u.nome AS usuario_nome, u.email AS usuario_email,
            (SELECT COUNT(*)::int FROM cursos_aulas a JOIN contratos_cursos_itens it ON it.curso_id = a.curso_id
               JOIN cursos c ON c.id = a.curso_id
              WHERE it.contrato_id = v.contrato_id AND a.ativo AND c.ativo AND c.status = 'publicado') AS aulas_total,
            (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
               JOIN contratos_cursos_itens it ON it.curso_id = a.curso_id JOIN cursos c ON c.id = a.curso_id
              WHERE it.contrato_id = v.contrato_id AND p.usuario_id = v.usuario_id AND a.ativo AND c.ativo AND c.status = 'publicado') AS aulas_concluidas
     FROM contratos_cursos_vagas v LEFT JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.contrato_id = $1 AND v.ativo ORDER BY (v.usuario_id IS NULL), v.id`, [id])).rows;
  k.total_vagas = k.vagas.length;
  k.ocupadas = k.vagas.filter(v => v.usuario_id).length;
  return k;
}

/**
 * Coloca uma pessoa numa vaga: { eu: true } (quem administra ocupa para si; eu = usuário eu_id) ou { nome, email }.
 * vagaId vazio = a próxima vaga livre. Devolve { usuario, criado, convite_enviado, vaga_id, estado }.
 */
async function ocuparVaga(k, vagaId, { eu, nome, email }, { euId = null, atorId = null } = {}) {
  if (k.status !== 'ativo') throw new ErroRegra('Contrato de cursos encerrado.');
  const db = await pool.connect();
  let usuario, criado = false, vaga, estado;
  try {
    await db.query('BEGIN');
    vaga = vagaId
      ? (await db.query('SELECT * FROM contratos_cursos_vagas WHERE id = $1 AND contrato_id = $2 AND ativo FOR UPDATE', [vagaId, k.id])).rows[0]
      : (await db.query(
        `SELECT * FROM contratos_cursos_vagas WHERE contrato_id = $1 AND ativo AND usuario_id IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [k.id])).rows[0];
    if (!vaga) throw new ErroRegra(vagaId ? 'Vaga não encontrada.' : 'Todas as vagas deste contrato de cursos estão ocupadas. Libere uma ou aumente as vagas.');
    if (vaga.usuario_id) throw new ErroRegra('Esta vaga já está ocupada. Libere-a antes de passar para outra pessoa.');
    if (eu) {
      if (!euId) throw new ErroRegra('Informe o e-mail da pessoa.');
      usuario = (await db.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [euId])).rows[0];
    } else {
      ({ usuario, criado } = await cc.acharOuCriarUsuario(db, {
        clienteId: k.cliente_id, empresaId: k.empresa_id, nome, email, papel: 'aluno' }));
    }
    const ja = await db.query('SELECT 1 FROM contratos_cursos_vagas WHERE contrato_id = $1 AND usuario_id = $2 AND ativo', [k.id, usuario.id]);
    if (ja.rows.length) throw new ErroRegra(`${usuario.nome} já está numa vaga deste contrato.`);
    estado = criado ? 'convidada' : 'ativa';
    await db.query(
      `UPDATE contratos_cursos_vagas SET usuario_id = $1, data_atribuicao = NOW(), estado = $2::varchar,
         convidado_em = CASE WHEN $2::varchar = 'convidada' THEN NOW() END WHERE id = $3`, [usuario.id, estado, vaga.id]);
    await auditoria.registrar({ empresa_id: k.empresa_id, usuario_id: atorId, acao: 'vaga.ocupada', entidade: 'vaga_cursos',
      entidade_id: vaga.id, depois: { contrato_cursos_id: k.id, usuario_id: usuario.id, email: usuario.email, estado } }, db);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && err.constraint === 'uq_cursos_vagas_contrato_usuario') throw new ErroRegra(`${usuario.nome} já está numa vaga deste contrato.`);
    if (err.code === '23505' && err.constraint === 'usuarios_email_key') throw new ErroRegra(`${email} acabou de ser convidado em outro pedido. Atualize a página.`);
    throw err;
  } finally {
    db.release();
  }
  const convite_enviado = criado ? await cc.enviarConvite(usuario) : false;
  return { usuario, criado, convite_enviado, vaga_id: vaga.id, estado };
}

/** Tira a pessoa da vaga (ou cancela o convite). Ela continua com a conta, o progresso e o que comprou. Devolve o usuario_id. */
async function liberarVaga(k, vagaId, atorId = null, { acao } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const vaga = (await db.query('SELECT * FROM contratos_cursos_vagas WHERE id = $1 AND contrato_id = $2 AND ativo FOR UPDATE', [vagaId, k.id])).rows[0];
    if (!vaga) throw new ErroRegra('Vaga não encontrada.');
    if (!vaga.usuario_id) throw new ErroRegra('A vaga já está livre.');
    await db.query(`UPDATE contratos_cursos_vagas SET usuario_id = NULL, data_atribuicao = NULL, estado = 'livre', convidado_em = NULL WHERE id = $1`, [vaga.id]);
    if (vaga.estado === 'convidada') {
      await db.query(
        `UPDATE usuarios_tokens t SET usado_em = NOW() WHERE t.usuario_id = $1 AND t.tipo = 'convite' AND t.usado_em IS NULL
           AND ${cc.SEM_OUTRO_CONVITE('$1')}`, [vaga.usuario_id]);
    }
    await auditoria.registrar({ empresa_id: k.empresa_id, usuario_id: atorId,
      acao: acao || (vaga.estado === 'convidada' ? 'vaga.convite_cancelado' : 'vaga.liberada'), entidade: 'vaga_cursos',
      entidade_id: vaga.id, antes: { contrato_cursos_id: k.id, usuario_id: vaga.usuario_id, estado: vaga.estado, desde: vaga.data_atribuicao } }, db);
    await db.query('COMMIT');
    return vaga.usuario_id;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Convites sem aceite (sem link válido e passado o prazo): a vaga volta a ficar livre. */
async function expirarConvites() {
  const r = await pool.query(
    `SELECT v.id AS vaga_id, v.contrato_id, v.usuario_id FROM contratos_cursos_vagas v
     WHERE v.ativo AND v.estado = 'convidada' AND v.convidado_em < NOW() - make_interval(hours => $1)
       AND NOT EXISTS (SELECT 1 FROM usuarios_tokens t WHERE t.usuario_id = v.usuario_id AND t.tipo = 'convite'
                         AND t.usado_em IS NULL AND t.expira_em > NOW())
     LIMIT 200`, [senhas.PRAZO_H.convite]);
  let n = 0;
  for (const { vaga_id, contrato_id } of r.rows) {
    const k = (await pool.query('SELECT * FROM contratos_cursos WHERE id = $1', [contrato_id])).rows[0];
    try { await liberarVaga(k, vaga_id, null, { acao: 'vaga.convite_expirado' }); n++; } catch (err) {
      if (!(err instanceof ErroRegra)) throw err;
    }
  }
  return n;
}

module.exports = { MAX_VAGAS, lerVagas, criarVagas, ajustarVagas, detalhar, ocuparVaga, liberarVaga, expirarConvites };
