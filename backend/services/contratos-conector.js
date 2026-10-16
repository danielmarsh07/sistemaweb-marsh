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
const auditoria = require('./auditoria');

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
  // Certificado e licença de quem ocupa cada vaga (a licença é da pessoa naquela vaga)
  const extras = (await pool.query(
    `SELECT v.id AS vaga_id, ce.codigo, ce.emitido_em, l.chave_prefixo, l.status AS licenca_status,
            (SELECT a.nome_maquina FROM licencas_ativacoes a WHERE a.licenca_id = l.id AND a.revogada = FALSE
              ORDER BY a.primeira_ativacao DESC LIMIT 1) AS maquina_nome
     FROM contratos_conector_vagas v
     LEFT JOIN certificados ce ON ce.vaga_id = v.id AND ce.usuario_id = v.usuario_id
     LEFT JOIN licencas l ON l.vaga_id = v.id AND l.usuario_id = v.usuario_id
     WHERE v.contrato_id = $1 AND v.ativo AND v.usuario_id IS NOT NULL`, [id])).rows;
  for (const v of vagas) {
    const x = extras.find(e => e.vaga_id === v.id) || {};
    v.certificado = x.codigo ? { codigo: x.codigo, emitido_em: x.emitido_em } : null;
    v.licenca = x.chave_prefixo ? { chave_prefixo: x.chave_prefixo, status: x.licenca_status, maquina_nome: x.maquina_nome || null } : null;
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
async function ocuparVaga(contrato, vagaId, { eu, nome, email }, gestorId, atorId = gestorId) {
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
    await auditoria.registrar({ empresa_id: contrato.empresa_id, usuario_id: atorId, acao: 'vaga.ocupada', entidade: 'vaga_conector',
      entidade_id: vaga.id, depois: { contrato_id: contrato.id, perfil: vaga.perfil, usuario_id: usuario.id, email: usuario.email } }, db);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    // Índice único (contrato, pessoa): pedido simultâneo para a mesma pessoa em outra vaga
    if (err.code === '23505' && err.constraint === 'uq_vagas_contrato_usuario') {
      throw new ErroRegra(`${usuario.nome} já ocupa uma vaga deste contrato.`);
    }
    // Mesmo e-mail novo convidado em dois pedidos simultâneos: o outro pedido já criou a pessoa
    if (err.code === '23505' && err.constraint === 'usuarios_email_key') {
      throw new ErroRegra(`${email} acabou de ser convidado em outro pedido. Atualize a página.`);
    }
    throw err;
  } finally {
    db.release();
  }
  const convite_enviado = criado ? await enviarConvite(usuario) : false;
  return { usuario, criado, convite_enviado };
}

/** Libera a vaga. Aluno sem nenhuma outra vaga fica desativado (o progresso dele é guardado). */
async function liberarVaga(contrato, vagaId, atorId = null) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const vaga = (await db.query(
      'SELECT * FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo FOR UPDATE', [vagaId, contrato.id])).rows[0];
    if (!vaga) throw new ErroRegra('Vaga não encontrada.');
    if (!vaga.usuario_id) throw new ErroRegra('A vaga já está livre.');
    await db.query('UPDATE contratos_conector_vagas SET usuario_id = NULL, data_atribuicao = NULL WHERE id = $1', [vaga.id]);
    await db.query(
      `UPDATE usuarios u SET ativo = FALSE
       WHERE u.id = $1 AND u.portal_papel = 'aluno'
         AND NOT EXISTS (SELECT 1 FROM contratos_conector_vagas v WHERE v.usuario_id = u.id AND v.ativo)`, [vaga.usuario_id]);
    await auditoria.registrar({ empresa_id: contrato.empresa_id, usuario_id: atorId, acao: 'vaga.liberada', entidade: 'vaga_conector',
      entidade_id: vaga.id, antes: { contrato_id: contrato.id, perfil: vaga.perfil, usuario_id: vaga.usuario_id, desde: vaga.data_atribuicao } }, db);
    await db.query('COMMIT');
    return vaga.usuario_id;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

// ===== Cobrança do contrato (fluxo novo, fase 1) =====
// As licenças do Conector são cobradas por um contrato financeiro anual (tipo produto) ligado a este contrato.
// Preço sugerido = tabela de Preços Conector SAP (Cadastros), plano anual: valor mensal × 12 por vaga.
// Perfil Ambos usa o preço de Desenvolvimento até a tabela ter um preço próprio para ele.
async function precoAnualSugerido(db, empresaId, q) {
  const { normalizarPrecos } = require('./precificacao-conector');
  const cfg = (await db.query('SELECT prop_precos_conector FROM financeiro_config WHERE empresa_id = $1', [empresaId])).rows[0];
  const { precos } = normalizarPrecos((cfg && cfg.prop_precos_conector) || {});
  const mensal = (q.abap || 0) * precos.dev_anual + (q.ambos || 0) * precos.dev_anual + (q.funcional || 0) * precos.leitura_anual;
  return Math.round(mensal * 12 * 100) / 100;
}

async function quantidadesDoContrato(db, contratoId) {
  const r = await db.query(
    `SELECT perfil, COUNT(*)::int AS n FROM contratos_conector_vagas WHERE contrato_id = $1 AND ativo GROUP BY perfil`, [contratoId]);
  return Object.fromEntries(r.rows.map(x => [x.perfil, x.n]));
}

/**
 * Cria o contrato financeiro anual que cobra as licenças deste contrato do Conector.
 * k = linha de contratos_conector (data_inicio/data_fim). valor vazio = preço sugerido da tabela.
 */
async function criarCobrancaAnual(db, k, { valor, dia_vencimento, usuarioId }) {
  const q = await quantidadesDoContrato(db, k.id);
  const total = Object.values(q).reduce((s, n) => s + n, 0);
  const v = valor !== undefined && valor !== null && String(valor).trim() !== '' ? Number(valor) : await precoAnualSugerido(db, k.empresa_id, q);
  if (!(v > 0)) throw new ErroRegra('Informe o valor anual (a tabela de preços não gerou um valor).');
  const dia = dia_vencimento ? Number(dia_vencimento) : 10;
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) throw new ErroRegra('Dia de vencimento: 1 a 28.');
  const partes = [q.abap && `${q.abap} ABAP`, q.funcional && `${q.funcional} Funcional`, q.ambos && `${q.ambos} Ambos`].filter(Boolean).join(', ');
  const inicio = String(k.data_inicio instanceof Date ? k.data_inicio.toISOString() : k.data_inicio).slice(0, 10);
  const fim = String(k.data_fim instanceof Date ? k.data_fim.toISOString() : k.data_fim).slice(0, 10);
  try {
    const r = await db.query(
      `INSERT INTO contratos (empresa_id, cliente_id, descricao, descricao_servico, valor, dia_vencimento, data_inicio, data_fim,
         tipo, periodicidade, mes_cobranca, contrato_conector_id, itens, emitir_nfse, status, observacoes, criado_por_usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'produto', 'anual', $9, $10, $11, TRUE, 'ativo', $12, $13) RETURNING id`,
      [k.empresa_id, k.cliente_id, `Conector SAP — ${total} licença(s)`,
       `Licenciamento anual do Conector SAP Marsh: ${partes}.`, v, dia, inicio, fim,
       Number(inicio.slice(5, 7)), k.id,
       JSON.stringify(Object.entries(q).map(([perfil, n]) => ({ descricao: `Licença Conector SAP — ${(PERFIS[perfil] || {}).nome || perfil}`, tipo: 'anual', quantidade: n }))),
       `Cobrança do contrato do Conector nº ${k.id}.`, usuarioId]);
    await auditoria.registrar({ empresa_id: k.empresa_id, usuario_id: usuarioId, acao: 'contrato.criado', entidade: 'contrato',
      entidade_id: r.rows[0].id, depois: { tipo: 'produto', periodicidade: 'anual', valor: v, contrato_conector_id: k.id } }, db);
    return { id: r.rows[0].id, valor: v };
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'uq_contratos_conector_vinculo') throw new ErroRegra('Este contrato do Conector já tem cobrança.');
    throw err;
  }
}

module.exports = {
  PERFIS, TRILHAS, PERFIL_COBRE_TRILHA, VAGA_VIGENTE, ErroRegra,
  sqlCursoLiberado, papelPortal, acharOuCriarUsuario, enviarConvite, detalharContrato,
  lerQuantidades, criarVagas, ocuparVaga, liberarVaga,
  precoAnualSugerido, criarCobrancaAnual
};
