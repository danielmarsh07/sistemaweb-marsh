/**
 * contratos-conector.js — contratos do Conector SAP por vagas.
 *
 * Quem compra (CPF ou CNPJ) é o gestor: vê o contrato inteiro, ocupa vagas com pessoas (convite por e-mail),
 * pode ocupar uma vaga ele mesmo e cadastra os SIDs. Cada vaga tem um perfil, que define os cursos:
 *   abap      → IA no ABAP + Portal + Conector      (licença Desenvolvimento)
 *   funcional → IA para Funcionais + Portal + Conector (licença Leitura)
 *   ambos     → os quatro                            (licença Desenvolvimento)
 * O usuário de uma vaga (portal_papel = 'aluno') vê só os próprios treinamentos.
 */
const pool = require('../db');
const senhas = require('./senhas');

const PERFIS = {
  abap:      { nome: 'ABAP',          trilhas: ['abap', 'portal', 'conector'],              plano: 'desenvolvimento' },
  funcional: { nome: 'Funcional',     trilhas: ['funcional', 'portal', 'conector'],         plano: 'leitura' },
  ambos:     { nome: 'ABAP + Funcional', trilhas: ['abap', 'funcional', 'portal', 'conector'], plano: 'desenvolvimento' }
};
const TRILHAS = { abap: 'IA no ABAP', funcional: 'IA para Funcionais', portal: 'Portal Marsh', conector: 'Conector SAP' };
const MAX_VAGAS = 200;

// Condição SQL: a vaga (alias v) dá acesso ao curso (alias c) — perfil cobre a trilha do curso
const PERFIL_COBRE_TRILHA = '(' + Object.entries(PERFIS).map(([p, d]) =>
  `(v.perfil = '${p}' AND c.trilha IN (${d.trilhas.map(t => `'${t}'`).join(', ')}))`).join(' OR ') + ')';

// Vaga ativa de contrato vigente
const VAGA_VIGENTE = `v.ativo AND k.status = 'ativo' AND k.data_inicio <= CURRENT_DATE AND k.data_fim >= CURRENT_DATE`;

/**
 * Condição SQL de curso liberado para um usuário do portal (alias c = cursos).
 * pCliente / pUsuario = placeholders ($1, $2...). Vale a liberação por empresa (como sempre, menos para aluno)
 * ou uma vaga vigente do usuário cujo perfil cobre a trilha do curso.
 */
function sqlCursoLiberado(pCliente, pUsuario) {
  return `c.ativo = TRUE AND c.status = 'publicado' AND (
    (EXISTS (SELECT 1 FROM cursos_liberacoes lb
             WHERE lb.curso_id = c.id AND lb.cliente_id = ${pCliente} AND (lb.data_fim IS NULL OR lb.data_fim >= CURRENT_DATE))
     AND COALESCE((SELECT portal_papel FROM usuarios WHERE id = ${pUsuario}), '') <> 'aluno')
    OR EXISTS (SELECT 1 FROM contratos_conector_vagas v JOIN contratos_conector k ON k.id = v.contrato_id
               WHERE v.usuario_id = ${pUsuario} AND ${VAGA_VIGENTE} AND ${PERFIL_COBRE_TRILHA}))`;
}

async function papelPortal(usuarioId) {
  const r = await pool.query('SELECT portal_papel FROM usuarios WHERE id = $1', [usuarioId]);
  return r.rows[0] ? r.rows[0].portal_papel : null;
}

const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 150;

class ErroRegra extends Error {}

/**
 * Acha ou cria o usuário do portal para o e-mail, no cliente do contrato.
 * papel: 'gestor' | 'aluno' — um usuário de sempre (NULL) ou gestor não perde acesso ao virar aluno de uma vaga.
 * Devolve { usuario, criado }. Usuário novo recebe convite para criar a senha.
 */
async function acharOuCriarUsuario(db, { clienteId, empresaId, nome, email, papel }) {
  email = String(email || '').trim();
  nome = String(nome || '').trim();
  if (!emailValido(email)) throw new ErroRegra('E-mail inválido.');
  const ex = (await db.query('SELECT id, nome, email, tipo, cliente_id, portal_papel, ativo FROM usuarios WHERE LOWER(email) = LOWER($1)', [email])).rows[0];
  if (ex) {
    if (ex.tipo !== 'cliente' || Number(ex.cliente_id) !== Number(clienteId)) {
      throw new ErroRegra(`O e-mail ${email} já é usado por outro usuário do sistema.`);
    }
    const novoPapel = papel === 'gestor' ? 'gestor' : (ex.portal_papel === 'aluno' ? 'aluno' : ex.portal_papel);
    const u = (await db.query(
      `UPDATE usuarios SET portal_papel = $1, ativo = TRUE WHERE id = $2
       RETURNING id, nome, email, tipo, cliente_id, portal_papel, ativo`, [novoPapel, ex.id])).rows[0];
    return { usuario: u, criado: false };
  }
  if (!nome) throw new ErroRegra('Informe o nome da pessoa.');
  if (nome.length > 150) throw new ErroRegra('Nome deve ter até 150 caracteres.');
  const u = (await db.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo, portal_papel)
     VALUES ($1, $2, $3, $4, 'cliente', $5, TRUE, $6)
     RETURNING id, nome, email, tipo, cliente_id, portal_papel, ativo`,
    [nome, email, await senhas.senhaProvisoria(), empresaId || 1, clienteId, papel])).rows[0];
  return { usuario: u, criado: true };
}

async function enviarConvite(usuario) {
  try { return (await senhas.enviarLink(usuario, 'convite')).enviado; } catch { return false; }
}

/** Contrato com vagas, ocupantes e progresso de cada um nos cursos do perfil. */
async function detalharContrato(id) {
  const k = (await pool.query(
    `SELECT k.*, to_char(k.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
            (k.status = 'ativo' AND k.data_inicio <= CURRENT_DATE AND k.data_fim >= CURRENT_DATE) AS vigente,
            COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente_nome, cl.cpf_cnpj,
            g.nome AS gestor_nome, g.email AS gestor_email
     FROM contratos_conector k
     JOIN clientes cl ON cl.id = k.cliente_id
     JOIN usuarios g ON g.id = k.gestor_usuario_id
     WHERE k.id = $1`, [id])).rows[0];
  if (!k) return null;
  const vagas = (await pool.query(
    `SELECT v.id, v.perfil, v.usuario_id, v.data_atribuicao, u.nome AS usuario_nome, u.email AS usuario_email,
            (SELECT COUNT(*)::int FROM cursos_aulas a JOIN cursos c ON c.id = a.curso_id
              WHERE a.ativo AND c.ativo AND c.status = 'publicado' AND ${PERFIL_COBRE_TRILHA}) AS aulas_total,
            (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id JOIN cursos c ON c.id = a.curso_id
              WHERE p.usuario_id = v.usuario_id AND a.ativo AND c.ativo AND c.status = 'publicado' AND ${PERFIL_COBRE_TRILHA}) AS aulas_concluidas
     FROM contratos_conector_vagas v
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.contrato_id = $1 AND v.ativo
     ORDER BY CASE v.perfil WHEN 'abap' THEN 1 WHEN 'funcional' THEN 2 ELSE 3 END, v.id`, [id])).rows;
  for (const v of vagas) {
    v.perfil_nome = PERFIS[v.perfil] ? PERFIS[v.perfil].nome : v.perfil;
    v.cursos = (PERFIS[v.perfil] ? PERFIS[v.perfil].trilhas : []).map(t => TRILHAS[t]);
    v.eh_gestor = v.usuario_id === k.gestor_usuario_id;
  }
  return { ...k, vagas };
}

/** Normaliza { abap, funcional, ambos } em quantidades inteiras. */
function lerQuantidades(vagas) {
  const q = {};
  let total = 0;
  for (const p of Object.keys(PERFIS)) {
    const n = vagas && vagas[p] !== undefined && vagas[p] !== '' ? Number(vagas[p]) : 0;
    if (!Number.isInteger(n) || n < 0 || n > MAX_VAGAS) throw new ErroRegra(`Vagas ${PERFIS[p].nome}: número inteiro de 0 a ${MAX_VAGAS}.`);
    q[p] = n;
    total += n;
  }
  return { q, total };
}

async function criarVagas(db, contratoId, q) {
  for (const [perfil, n] of Object.entries(q)) {
    for (let i = 0; i < n; i++) {
      await db.query('INSERT INTO contratos_conector_vagas (contrato_id, perfil) VALUES ($1, $2)', [contratoId, perfil]);
    }
  }
}

/**
 * Ocupa a vaga: { eu: true } (o gestor) ou { nome, email } (convite).
 * contrato = linha de contratos_conector. Devolve { usuario, convite_enviado }.
 */
async function ocuparVaga(contrato, vagaId, { eu, nome, email }, gestorId) {
  if (contrato.status !== 'ativo') throw new ErroRegra('Contrato não está ativo.');
  const db = await pool.connect();
  let usuario, criado = false;
  try {
    await db.query('BEGIN');
    const vaga = (await db.query(
      'SELECT * FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo FOR UPDATE', [vagaId, contrato.id])).rows[0];
    if (!vaga) throw new ErroRegra('Vaga não encontrada.');
    if (vaga.usuario_id) throw new ErroRegra('Esta vaga já está ocupada. Libere-a antes de passar para outra pessoa.');
    if (eu) {
      usuario = (await db.query('SELECT id, nome, email, portal_papel FROM usuarios WHERE id = $1', [gestorId])).rows[0];
    } else {
      ({ usuario, criado } = await acharOuCriarUsuario(db, {
        clienteId: contrato.cliente_id, empresaId: contrato.empresa_id, nome, email, papel: 'aluno' }));
    }
    const outra = await db.query(
      'SELECT 1 FROM contratos_conector_vagas WHERE contrato_id = $1 AND usuario_id = $2 AND ativo', [contrato.id, usuario.id]);
    if (outra.rows.length) throw new ErroRegra(`${usuario.nome} já ocupa uma vaga deste contrato.`);
    await db.query('UPDATE contratos_conector_vagas SET usuario_id = $1, data_atribuicao = NOW() WHERE id = $2', [usuario.id, vaga.id]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  const convite_enviado = criado ? await enviarConvite(usuario) : false;
  return { usuario, criado, convite_enviado };
}

/** Libera a vaga. Aluno sem nenhuma outra vaga fica desativado (o progresso dele é guardado). */
async function liberarVaga(contrato, vagaId) {
  const vaga = (await pool.query(
    'SELECT * FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo', [vagaId, contrato.id])).rows[0];
  if (!vaga) throw new ErroRegra('Vaga não encontrada.');
  if (!vaga.usuario_id) throw new ErroRegra('A vaga já está livre.');
  await pool.query('UPDATE contratos_conector_vagas SET usuario_id = NULL, data_atribuicao = NULL WHERE id = $1', [vaga.id]);
  await pool.query(
    `UPDATE usuarios u SET ativo = FALSE
     WHERE u.id = $1 AND u.portal_papel = 'aluno'
       AND NOT EXISTS (SELECT 1 FROM contratos_conector_vagas v WHERE v.usuario_id = u.id AND v.ativo)`, [vaga.usuario_id]);
}

module.exports = {
  PERFIS, TRILHAS, PERFIL_COBRE_TRILHA, VAGA_VIGENTE, ErroRegra,
  sqlCursoLiberado, papelPortal, acharOuCriarUsuario, enviarConvite, detalharContrato,
  lerQuantidades, criarVagas, ocuparVaga, liberarVaga
};
