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

// Vaga ativa (convite aceito) de contrato vigente
const VAGA_VIGENTE = `v.ativo AND v.estado = 'ativa' AND k.status = 'ativo' AND k.data_inicio <= CURRENT_DATE AND k.data_fim >= CURRENT_DATE`;

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
    `SELECT v.id, v.perfil, v.usuario_id, v.data_atribuicao, v.estado, v.convidado_em, u.nome AS usuario_nome, u.email AS usuario_email,
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
 * Ocupa uma vaga: { eu: true } (quem administra ocupa para si) ou { nome, email } (convite).
 * alvo = { vagaId } (vaga escolhida) ou { perfil } (o sistema reserva a próxima vaga livre do perfil).
 * Estado da atribuição: pessoa nova = 'convidada' (reserva a vaga até aceitar o convite);
 * quem já tem acesso ao portal = 'ativa'. contrato = linha de contratos_conector.
 * Devolve { usuario, criado, convite_enviado, vaga_id, estado }.
 */
async function ocuparVaga(contrato, alvo, { eu, nome, email }, gestorId, atorId = gestorId) {
  if (contrato.status !== 'ativo') throw new ErroRegra('Contrato não está ativo.');
  if (typeof alvo !== 'object' || alvo === null) alvo = { vagaId: alvo };
  const db = await pool.connect();
  let usuario, criado = false, vaga, estado;
  try {
    await db.query('BEGIN');
    if (alvo.perfil) {
      if (!PERFIS[alvo.perfil]) throw new ErroRegra('Perfil inválido.');
      // SKIP LOCKED: convites simultâneos pegam vagas diferentes; sem vaga livre, recusa (nunca passa do contratado)
      vaga = (await db.query(
        `SELECT * FROM contratos_conector_vagas WHERE contrato_id = $1 AND perfil = $2 AND ativo AND usuario_id IS NULL
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [contrato.id, alvo.perfil])).rows[0];
      if (!vaga) throw new ErroRegra(`Não há licença ${PERFIS[alvo.perfil].nome} disponível neste contrato. Libere uma ou contrate mais.`);
    } else {
      vaga = (await db.query(
        'SELECT * FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo FOR UPDATE', [alvo.vagaId, contrato.id])).rows[0];
      if (!vaga) throw new ErroRegra('Vaga não encontrada.');
      if (vaga.usuario_id) throw new ErroRegra('Esta vaga já está ocupada. Libere-a antes de passar para outra pessoa.');
    }
    if (eu) {
      usuario = (await db.query('SELECT id, nome, email, portal_papel FROM usuarios WHERE id = $1', [gestorId])).rows[0];
    } else {
      ({ usuario, criado } = await acharOuCriarUsuario(db, {
        clienteId: contrato.cliente_id, empresaId: contrato.empresa_id, nome, email, papel: 'aluno' }));
    }
    const outra = await db.query(
      'SELECT 1 FROM contratos_conector_vagas WHERE contrato_id = $1 AND usuario_id = $2 AND ativo', [contrato.id, usuario.id]);
    if (outra.rows.length) throw new ErroRegra(`${usuario.nome} já ocupa uma vaga deste contrato.`);
    estado = criado ? 'convidada' : 'ativa';
    await db.query(
      `UPDATE contratos_conector_vagas SET usuario_id = $1, data_atribuicao = NOW(), estado = $2::varchar,
         convidado_em = CASE WHEN $2::varchar = 'convidada' THEN NOW() END WHERE id = $3`, [usuario.id, estado, vaga.id]);
    await auditoria.registrar({ empresa_id: contrato.empresa_id, usuario_id: atorId, acao: 'vaga.ocupada', entidade: 'vaga_conector',
      entidade_id: vaga.id, depois: { contrato_id: contrato.id, perfil: vaga.perfil, usuario_id: usuario.id, email: usuario.email, estado } }, db);
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
  return { usuario, criado, convite_enviado, vaga_id: vaga.id, estado };
}

/**
 * Libera a vaga (revoga a licença ou cancela o convite). A pessoa continua com a conta: perde só o que vinha
 * desta vaga (licença e cursos do perfil); progresso, certificado e compras próprias ficam.
 * Convite ainda não aceito: o link deixa de valer. acao: 'vaga.liberada' | 'vaga.convite_cancelado' | 'vaga.convite_expirado'.
 */
async function liberarVaga(contrato, vagaId, atorId = null, { acao } = {}) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const vaga = (await db.query(
      'SELECT * FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo FOR UPDATE', [vagaId, contrato.id])).rows[0];
    if (!vaga) throw new ErroRegra('Vaga não encontrada.');
    if (!vaga.usuario_id) throw new ErroRegra('A vaga já está livre.');
    await db.query(`UPDATE contratos_conector_vagas SET usuario_id = NULL, data_atribuicao = NULL, estado = 'livre', convidado_em = NULL WHERE id = $1`, [vaga.id]);
    if (vaga.estado === 'convidada') {
      // Sem outra vaga esperando aceite, o link de convite pendente deixa de valer
      await db.query(
        `UPDATE usuarios_tokens t SET usado_em = NOW() WHERE t.usuario_id = $1 AND t.tipo = 'convite' AND t.usado_em IS NULL
           AND NOT EXISTS (SELECT 1 FROM contratos_conector_vagas v WHERE v.usuario_id = $1 AND v.ativo AND v.estado = 'convidada')`,
        [vaga.usuario_id]);
    }
    await auditoria.registrar({ empresa_id: contrato.empresa_id, usuario_id: atorId,
      acao: acao || (vaga.estado === 'convidada' ? 'vaga.convite_cancelado' : 'vaga.liberada'), entidade: 'vaga_conector',
      entidade_id: vaga.id, antes: { contrato_id: contrato.id, perfil: vaga.perfil, usuario_id: vaga.usuario_id, estado: vaga.estado, desde: vaga.data_atribuicao } }, db);
    await db.query('COMMIT');
    return vaga.usuario_id;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** A pessoa aceitou o convite (criou a senha) ou entrou no portal: as vagas reservadas para ela passam a valer. */
async function ativarConvites(usuarioId) {
  const r = await pool.query(
    `UPDATE contratos_conector_vagas v SET estado = 'ativa', convidado_em = NULL
     FROM contratos_conector k WHERE k.id = v.contrato_id AND v.usuario_id = $1 AND v.ativo AND v.estado = 'convidada'
     RETURNING v.id, v.contrato_id, v.perfil, k.empresa_id`, [usuarioId]);
  for (const v of r.rows) {
    await auditoria.registrar({ empresa_id: v.empresa_id, usuario_id: usuarioId, acao: 'vaga.convite_aceito', entidade: 'vaga_conector',
      entidade_id: v.id, depois: { contrato_id: v.contrato_id, perfil: v.perfil, usuario_id: usuarioId, estado: 'ativa' } });
  }
  return r.rowCount;
}

/**
 * Convites que expiraram sem aceite: a vaga reservada volta a ficar livre.
 * Expira quando a pessoa não tem mais nenhum link de convite válido (72 h; reenviar renova) e já passou o prazo.
 */
async function expirarConvites() {
  const r = await pool.query(
    `SELECT v.id AS vaga_id, v.contrato_id FROM contratos_conector_vagas v
     WHERE v.ativo AND v.estado = 'convidada' AND v.convidado_em < NOW() - make_interval(hours => $1)
       AND NOT EXISTS (SELECT 1 FROM usuarios_tokens t WHERE t.usuario_id = v.usuario_id AND t.tipo = 'convite'
                         AND t.usado_em IS NULL AND t.expira_em > NOW())
     LIMIT 200`, [senhas.PRAZO_H.convite]);
  let n = 0;
  for (const { vaga_id, contrato_id } of r.rows) {
    const k = (await pool.query('SELECT * FROM contratos_conector WHERE id = $1', [contrato_id])).rows[0];
    try { await liberarVaga(k, vaga_id, null, { acao: 'vaga.convite_expirado' }); n++; } catch (err) {
      if (!(err instanceof ErroRegra)) throw err; // já liberada por alguém: segue
    }
  }
  return n;
}

// ===== Administradores corporativos =====
// Cada cliente (empresa ou pessoa compradora) tem um ou mais administradores no portal: veem os contratos do Conector
// do cliente, convidam pessoas, revogam e redistribuem licenças. Ser administrador NÃO ocupa licença.
async function ehAdminCorporativo(usuarioId, clienteId, db = pool) {
  if (!usuarioId || !clienteId) return false;
  const r = await db.query('SELECT 1 FROM clientes_admins WHERE usuario_id = $1 AND cliente_id = $2', [usuarioId, clienteId]);
  return r.rows.length > 0;
}

async function listarAdmins(clienteId) {
  return (await pool.query(
    `SELECT u.id, u.nome, u.email, u.ativo, a.criado_em,
            EXISTS (SELECT 1 FROM usuarios_tokens t WHERE t.usuario_id = u.id AND t.tipo = 'convite' AND t.usado_em IS NULL AND t.expira_em > NOW()) AS convite_pendente
     FROM clientes_admins a JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.cliente_id = $1 ORDER BY u.nome`, [clienteId])).rows;
}

/** Torna a pessoa (achada ou criada pelo e-mail) administradora do cliente. Devolve { usuario, criado, convite_enviado }. */
async function adicionarAdmin({ clienteId, empresaId, nome, email, atorId }) {
  const db = await pool.connect();
  let usuario, criado;
  try {
    await db.query('BEGIN');
    ({ usuario, criado } = await acharOuCriarUsuario(db, { clienteId, empresaId, nome, email, papel: 'gestor' }));
    const ins = await db.query(
      `INSERT INTO clientes_admins (cliente_id, usuario_id, criado_por_usuario_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [clienteId, usuario.id, atorId]);
    if (!ins.rowCount) throw new ErroRegra(`${usuario.nome} já é administrador.`);
    await auditoria.registrar({ empresa_id: empresaId, usuario_id: atorId, acao: 'admin_corporativo.adicionado', entidade: 'cliente',
      entidade_id: Number(clienteId), depois: { usuario_id: usuario.id, email: usuario.email } }, db);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { db.release(); }
  const convite_enviado = criado ? await enviarConvite(usuario) : false;
  return { usuario, criado, convite_enviado };
}

/** Tira a função de administrador (a conta continua; se ocupa licença, segue como usuário da licença). */
async function removerAdmin({ clienteId, empresaId, usuarioId, atorId }) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Trava os admins do cliente: duas remoções simultâneas não deixam a empresa sem nenhum
    const admins = (await db.query('SELECT usuario_id FROM clientes_admins WHERE cliente_id = $1 FOR UPDATE', [clienteId])).rows;
    if (!admins.some(a => Number(a.usuario_id) === Number(usuarioId))) throw new ErroRegra('Esta pessoa não é administradora.');
    if (admins.length <= 1) throw new ErroRegra('A empresa precisa de pelo menos um administrador. Adicione outro antes de remover este.');
    await db.query('DELETE FROM clientes_admins WHERE cliente_id = $1 AND usuario_id = $2', [clienteId, usuarioId]);
    // Sem a função, o acesso amplo ao portal acaba: fica só o que é dele (licença e cursos)
    await db.query(`UPDATE usuarios SET portal_papel = 'aluno' WHERE id = $1 AND portal_papel = 'gestor'
      AND NOT EXISTS (SELECT 1 FROM clientes_admins WHERE usuario_id = $1)`, [usuarioId]);
    await auditoria.registrar({ empresa_id: empresaId, usuario_id: atorId, acao: 'admin_corporativo.removido', entidade: 'cliente',
      entidade_id: Number(clienteId), antes: { usuario_id: Number(usuarioId) } }, db);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { db.release(); }
}

/** Histórico das licenças de um contrato: quem recebeu, quem foi convidado, revogações e expirações. */
async function historicoContrato(contratoId) {
  return (await pool.query(
    `SELECT a.acao, a.criado_em, a.entidade_id AS vaga_id, COALESCE(a.depois, a.antes) AS dados,
            ator.nome AS feito_por, p.nome AS pessoa_nome, p.email AS pessoa_email
     FROM auditoria a
     LEFT JOIN usuarios ator ON ator.id = a.usuario_id
     LEFT JOIN usuarios p ON p.id = (COALESCE(a.depois, a.antes)->>'usuario_id')::int
     WHERE a.entidade = 'vaga_conector' AND (COALESCE(a.depois, a.antes)->>'contrato_id')::int = $1
     ORDER BY a.criado_em DESC, a.id DESC LIMIT 300`, [contratoId])).rows;
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
  lerQuantidades, criarVagas, ocuparVaga, liberarVaga, ativarConvites, expirarConvites,
  ehAdminCorporativo, listarAdmins, adicionarAdmin, removerAdmin, historicoContrato,
  precoAnualSugerido, criarCobrancaAnual
};
