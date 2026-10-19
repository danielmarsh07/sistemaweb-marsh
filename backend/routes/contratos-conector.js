/**
 * /api/contratos-conector — contratos do Conector SAP por vagas (requer login). Regras em services/contratos-conector.js.
 *
 * Portal (cliente; "gestor" = administrador corporativo do cliente, tabela clientes_admins):
 *   GET  /eu                                   papel no portal + vagas do próprio usuário (o portal decide o que mostra)
 *   GET  /meus                                 contratos do cliente, para quem é administrador (vagas, ocupantes, progresso, SIDs)
 *   GET|POST /meus-admins, DELETE /meus-admins/:uid   administradores da empresa
 *   POST /meus/:id/convidar                    { perfil, nome, email } ou { perfil, eu: true } — reserva a próxima licença livre
 *   GET  /meus/:id/historico                   quem recebeu, convites, revogações, expirações
 *   POST /meus/:id/vagas/:vid/ocupar           { eu: true } ou { nome, email } (convite por e-mail)
 *   POST /meus/:id/vagas/:vid/liberar          revoga a licença ou cancela o convite
 *   POST /meus/:id/vagas/:vid/convite          reenvia o convite ao ocupante
 *   PUT  /meus/:id/conexoes                    { conexoes: [{ sid, descricao, url, mandante, idioma }] } até max_sids
 * Admin: GET /, GET /:id, POST /, PUT /:id, POST /:id/vagas, DELETE /:id/vagas/:vid, POST /:id/convidar, GET /:id/historico,
 *        POST /:id/vagas/:vid/ocupar|liberar, PUT /:id/conexoes, POST /:id/gestor/convite, GET|POST|DELETE /clientes/:cid/admins
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwt = require('jsonwebtoken');
const cc = require('../services/contratos-conector');
const cert = require('../services/certificacao');
const acessos = require('../services/acessos');
const storage = require('../services/storage');
const { validarConexoes } = require('../services/licenca');

// Link do pacote do instalador: token de uso curto (o navegador baixa direto, sem o cabeçalho de login)
const PACOTE_TTL = '10m';

const ehAdmin = t => t === 'admin_empresa' || t === 'admin_sistema';
const emp = req => req.usuario.empresa_id || 1;
const reais = v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

function responderErro(res, err, msg) {
  if (err instanceof cc.ErroRegra) return res.status(400).json({ erro: err.message });
  res.status(500).json({ erro: msg, detalhe: err.message });
}

// Depois de ocupar: se a pessoa já tinha concluído o perfil, a licença dela volta a valer
// e os cursos do benefício entram no rastro de acessos (o acesso em si é conferido ao vivo)
async function depoisDeOcupar(r) {
  await cert.avaliarUsuario(r.usuario.id).catch(err => console.error('[certificacao] ocupar:', err.message));
  await acessos.sincronizarUsuario(r.usuario.id).catch(err => console.error('[acessos] ocupar:', err.message));
}

// Liberar = a licença e os cursos gratuitos dela acabam; compras próprias e progresso ficam
async function liberarComLicenca(k, vagaId, atorId) {
  const usuarioId = await cc.liberarVaga(k, vagaId, atorId);
  await cert.cancelarLicencaVaga(Number(vagaId), usuarioId);
  await acessos.sincronizarUsuario(usuarioId, { atorId }).catch(err => console.error('[acessos] liberar:', err.message));
}

function mensagemOcupacao(r) {
  if (!r.criado) return `Vaga passada para ${r.usuario.nome}.`;
  return r.convite_enviado
    ? `Vaga passada para ${r.usuario.nome}. Convite enviado para ${r.usuario.email}.`
    : `Vaga passada para ${r.usuario.nome}, mas o convite não pôde ser enviado. Use "Reenviar convite".`;
}

function lerConexoes(body, maxSids) {
  const v = validarConexoes(body && body.conexoes);
  if (v.erro) throw new cc.ErroRegra(v.erro);
  if (v.lista.length > maxSids) throw new cc.ErroRegra(`Este contrato permite até ${maxSids} sistemas SAP (SIDs).`);
  return v.lista;
}

// ============================== PORTAL ==============================
// Vagas do usuário com progresso por trilha, certificado e licença (com a chave, que é dele)
router.get('/eu', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json({ papel: null, gestor: false, vagas: [] });
  try {
    await cert.avaliarUsuario(req.usuario.id); // concluiu tudo e ainda não tinha certificado/licença? emite agora
    const papel = await cc.papelPortal(req.usuario.id);
    // "gestor" = administrador corporativo do cliente (vê e distribui as licenças de todos os contratos do cliente)
    const gestor = await cc.ehAdminCorporativo(req.usuario.id, req.usuario.cliente_id);
    const vagas = (await pool.query(
      `SELECT v.id, v.perfil, k.id AS contrato_id, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
              (${cc.VAGA_VIGENTE}) AS vigente
       FROM contratos_conector_vagas v JOIN contratos_conector k ON k.id = v.contrato_id
       WHERE v.usuario_id = $1 AND v.ativo AND k.status <> 'cancelado' ORDER BY v.id`, [req.usuario.id])).rows;
    for (const v of vagas) {
      v.perfil_nome = cc.PERFIS[v.perfil]?.nome || v.perfil;
      v.progresso = await cert.progressoPerfil(pool, v.perfil, req.usuario.id);
      v.certificado = (await pool.query(
        'SELECT codigo, emitido_em FROM certificados WHERE vaga_id = $1 AND usuario_id = $2', [v.id, req.usuario.id])).rows[0] || null;
      const l = (await pool.query(
        `SELECT l.*, to_char(l.data_fim, 'YYYY-MM-DD') AS data_fim, (l.data_fim >= CURRENT_DATE) AS vigente,
                (SELECT COUNT(*)::int FROM licencas_ativacoes a WHERE a.licenca_id = l.id AND a.revogada = FALSE) AS maquinas_ativas,
                (SELECT a.nome_maquina FROM licencas_ativacoes a WHERE a.licenca_id = l.id AND a.revogada = FALSE
                  ORDER BY a.primeira_ativacao DESC LIMIT 1) AS maquina_nome
         FROM licencas l WHERE l.vaga_id = $1 AND l.usuario_id = $2`, [v.id, req.usuario.id])).rows[0];
      v.licenca = cert.licencaParaPortal(l);
    }
    res.json({ papel, gestor, vagas });
  } catch (err) { responderErro(res, err, 'Erro ao buscar seu acesso'); }
});

// Link do instalador já configurado com a licença da pessoa (licença da vaga, valendo)
router.get('/eu/vagas/:vid/pacote', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.status(403).json({ erro: 'Somente usuários do portal.' });
  try {
    const l = (await pool.query(
      `SELECT l.id FROM licencas l JOIN contratos_conector_vagas v ON v.id = l.vaga_id AND v.usuario_id = l.usuario_id AND v.ativo
       WHERE l.vaga_id = $1 AND l.usuario_id = $2 AND l.ativo AND l.status = 'ativa' AND l.data_fim >= CURRENT_DATE`,
      [req.params.vid, req.usuario.id])).rows[0];
    if (!l) return res.status(403).json({ erro: 'O instalador fica disponível com a licença ativa (conclua os cursos do seu perfil).' });
    const inst = (await pool.query('SELECT versao FROM conector_instaladores ORDER BY id DESC LIMIT 1')).rows[0];
    if (inst && storage.disponivel) {
      const token = jwt.sign({ uso: 'pacote', licenca_id: l.id, usuario_id: req.usuario.id }, process.env.JWT_SECRET, { expiresIn: PACOTE_TTL });
      return res.json({ url: `/api/publico/pacote/${token}`, versao: inst.versao, configurado: true });
    }
    // Sem instalador publicado no storage: link fixo (sem a licença dentro; a pessoa digita a chave)
    res.json({ url: process.env.CONECTOR_DOWNLOAD_URL || null, versao: process.env.CONECTOR_VERSAO || null, configurado: false });
  } catch (err) { responderErro(res, err, 'Erro ao gerar o link do instalador'); }
});

// Contrato do cliente do usuário, desde que ele seja administrador corporativo desse cliente
// (o isolamento entre empresas vem daqui: o cliente_id é o do login, nunca o do pedido)
async function contratoDoGestor(req) {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return null;
  if (!await cc.ehAdminCorporativo(req.usuario.id, req.usuario.cliente_id)) return null;
  const r = await pool.query(
    `SELECT * FROM contratos_conector WHERE id = $1 AND cliente_id = $2 AND status <> 'cancelado'`,
    [req.params.id, req.usuario.cliente_id]);
  return r.rows[0] || null;
}

async function exigirAdminCorporativo(req, res) {
  if (req.usuario.tipo === 'cliente' && await cc.ehAdminCorporativo(req.usuario.id, req.usuario.cliente_id)) return true;
  res.status(403).json({ erro: 'Somente administradores da empresa.' });
  return false;
}

router.get('/meus', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json([]);
  try {
    if (!await cc.ehAdminCorporativo(req.usuario.id, req.usuario.cliente_id)) return res.json([]);
    const ids = (await pool.query(
      `SELECT id FROM contratos_conector WHERE cliente_id = $1 AND status <> 'cancelado' ORDER BY data_fim DESC, id DESC`,
      [req.usuario.cliente_id])).rows;
    res.json(await Promise.all(ids.map(r => cc.detalharContrato(r.id))));
  } catch (err) { responderErro(res, err, 'Erro ao buscar contratos'); }
});

// Administradores da empresa (portal): listar, convidar outro, remover (nunca o último)
router.get('/meus-admins', async (req, res) => {
  try {
    if (!await exigirAdminCorporativo(req, res)) return;
    res.json(await cc.listarAdmins(req.usuario.cliente_id));
  } catch (err) { responderErro(res, err, 'Erro ao buscar administradores'); }
});

router.post('/meus-admins', async (req, res) => {
  try {
    if (!await exigirAdminCorporativo(req, res)) return;
    const b = req.body || {};
    const r = await cc.adicionarAdmin({ clienteId: req.usuario.cliente_id, empresaId: emp(req), nome: b.nome, email: b.email, atorId: req.usuario.id });
    res.status(201).json({ mensagem: `${r.usuario.nome} agora é administrador da empresa.${r.criado ? (r.convite_enviado ? ` Convite enviado para ${r.usuario.email}.` : ' O convite não pôde ser enviado agora.') : ''}` });
  } catch (err) { responderErro(res, err, 'Erro ao adicionar administrador'); }
});

router.delete('/meus-admins/:uid', async (req, res) => {
  try {
    if (!await exigirAdminCorporativo(req, res)) return;
    await cc.removerAdmin({ clienteId: req.usuario.cliente_id, empresaId: emp(req), usuarioId: req.params.uid, atorId: req.usuario.id });
    res.json({ mensagem: 'Administrador removido.' });
  } catch (err) { responderErro(res, err, 'Erro ao remover administrador'); }
});

// Convidar escolhendo só o perfil: o sistema reserva a próxima licença livre (nunca passa do contratado)
router.post('/meus/:id/convidar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const b = req.body || {};
    const r = await cc.ocuparVaga(k, { perfil: b.perfil }, b, req.usuario.id);
    await depoisDeOcupar(r);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado, vaga_id: r.vaga_id, estado: r.estado });
  } catch (err) { responderErro(res, err, 'Erro ao convidar'); }
});

router.get('/meus/:id/historico', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    res.json(await cc.historicoContrato(k.id));
  } catch (err) { responderErro(res, err, 'Erro ao buscar o histórico'); }
});

router.post('/meus/:id/vagas/:vid/ocupar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const r = await cc.ocuparVaga(k, { vagaId: req.params.vid }, req.body || {}, req.usuario.id);
    await depoisDeOcupar(r);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado });
  } catch (err) { responderErro(res, err, 'Erro ao ocupar a vaga'); }
});

router.post('/meus/:id/vagas/:vid/liberar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await liberarComLicenca(k, req.params.vid, req.usuario.id);
    res.json({ mensagem: 'Licença liberada. A pessoa perde o Conector e os cursos desta licença, mas continua com a conta, o progresso e o que comprou.' });
  } catch (err) { responderErro(res, err, 'Erro ao liberar a vaga'); }
});

async function reenviarConvite(k, vagaId, res) {
  const u = (await pool.query(
    `SELECT u.id, u.nome, u.email, u.ativo FROM contratos_conector_vagas v JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.id = $1 AND v.contrato_id = $2 AND v.ativo`, [vagaId, k.id])).rows[0];
  if (!u) return res.status(404).json({ erro: 'Vaga sem ocupante.' });
  if (!await cc.enviarConvite(u)) return res.status(400).json({ erro: 'Não foi possível enviar o e-mail agora. Tente de novo mais tarde.' });
  res.json({ mensagem: `Convite reenviado para ${u.email}.` });
}

router.post('/meus/:id/vagas/:vid/convite', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await reenviarConvite(k, req.params.vid, res);
  } catch (err) { responderErro(res, err, 'Erro ao reenviar o convite'); }
});

router.put('/meus/:id/conexoes', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const lista = lerConexoes(req.body, k.max_sids);
    await pool.query('UPDATE contratos_conector SET conexoes = $1::jsonb, data_atualizacao = NOW() WHERE id = $2',
      [JSON.stringify(lista), k.id]);
    await cert.sincronizarContrato(k.id); // as licenças das vagas passam a usar os sistemas novos
    res.json({ mensagem: 'Sistemas SAP salvos.', conexoes: lista });
  } catch (err) { responderErro(res, err, 'Erro ao salvar os sistemas SAP'); }
});

// ============================== ADMIN ==============================
router.use((req, res, next) => {
  if (!ehAdmin(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores gerenciam contratos do conector.' });
  next();
});

async function contratoDaEmpresa(req) {
  const r = await pool.query(
    `SELECT *, to_char(data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(data_fim, 'YYYY-MM-DD') AS data_fim
     FROM contratos_conector WHERE id = $1 AND empresa_id = $2`, [req.params.id, emp(req)]);
  return r.rows[0] || null;
}

function lerDatas(b, atual = {}) {
  const inicio = b.data_inicio !== undefined ? b.data_inicio : atual.data_inicio;
  const fim = b.data_fim !== undefined ? b.data_fim : atual.data_fim;
  const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10)) && !isNaN(Date.parse(String(v).slice(0, 10)));
  if (b.data_inicio !== undefined && b.data_inicio !== '' && !iso(b.data_inicio)) throw new cc.ErroRegra('Data de início inválida.');
  if (!iso(fim)) throw new cc.ErroRegra('Informe a data de fim do contrato.');
  const i = inicio ? String(inicio).slice(0, 10) : null;
  const f = String(fim).slice(0, 10);
  if (i && f < i) throw new cc.ErroRegra('A data de fim não pode ser antes do início.');
  return { inicio: i, fim: f };
}

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT k.id, k.cliente_id, k.status, k.origem, to_char(k.data_inicio, 'YYYY-MM-DD') AS data_inicio,
              to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
              (k.status = 'ativo' AND k.data_inicio <= CURRENT_DATE AND k.data_fim >= CURRENT_DATE) AS vigente,
              COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente_nome,
              g.nome AS gestor_nome, g.email AS gestor_email,
              jsonb_array_length(k.conexoes) AS total_sids,
              (SELECT COUNT(*)::int FROM contratos_conector_vagas v WHERE v.contrato_id = k.id AND v.ativo) AS vagas,
              (SELECT COUNT(*)::int FROM contratos_conector_vagas v WHERE v.contrato_id = k.id AND v.ativo AND v.usuario_id IS NOT NULL) AS ocupadas,
              (SELECT COUNT(*)::int FROM contratos_conector_vagas v WHERE v.contrato_id = k.id AND v.ativo AND v.perfil = 'abap') AS vagas_abap,
              (SELECT COUNT(*)::int FROM contratos_conector_vagas v WHERE v.contrato_id = k.id AND v.ativo AND v.perfil = 'funcional') AS vagas_funcional,
              (SELECT COUNT(*)::int FROM contratos_conector_vagas v WHERE v.contrato_id = k.id AND v.ativo AND v.perfil = 'ambos') AS vagas_ambos,
              (SELECT ct.id FROM contratos ct WHERE ct.contrato_conector_id = k.id) AS contrato_financeiro_id
       FROM contratos_conector k
       JOIN clientes cl ON cl.id = k.cliente_id
       JOIN usuarios g ON g.id = k.gestor_usuario_id
       WHERE k.empresa_id = $1
       ORDER BY (k.status = 'cancelado'), k.data_fim, k.id`, [emp(req)]);
    res.json(r.rows);
  } catch (err) { responderErro(res, err, 'Erro ao listar contratos'); }
});

// GET /preco-sugerido?abap=&funcional=&ambos=&cliente_id=&ciclo= — conta por perfil e pacote Empresa (antes de /:id).
// Preço de partida: o do último contrato do cliente no mesmo ciclo, se houver; senão a tabela Preços Conector SAP (lista).
router.get('/preco-sugerido', async (req, res) => {
  try {
    const { q } = cc.lerQuantidades({ abap: req.query.abap, funcional: req.query.funcional, ambos: req.query.ambos });
    const ciclo = cc.lerCiclo(req.query.ciclo);
    let ultimo = req.query.cliente_id ? await cc.ultimosPrecosDoCliente(pool, emp(req), req.query.cliente_id) : null;
    if (ultimo && ultimo.ciclo !== ciclo) ultimo = null; // preço mensal e anual não se misturam
    const detalhe = await cc.detalhePrecoAnual(pool, emp(req), q, ultimo && ultimo.precos, ciclo);
    res.json({ ...detalhe, origem: ultimo ? 'cliente' : 'tabela', contrato_referencia: ultimo && ultimo.contrato_id,
      modalidade_referencia: ultimo && ultimo.modalidade });
  } catch (err) { responderErro(res, err, 'Erro ao calcular o preço'); }
});

router.get('/:id', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const detalhe = await cc.detalharContrato(k.id);
    const cob = (await pool.query(
      `SELECT id, valor::float AS valor, status, dia_vencimento, COALESCE(mes_cobranca, EXTRACT(MONTH FROM data_inicio)::int) AS mes_cobranca
       FROM contratos WHERE contrato_conector_id = $1`, [k.id])).rows[0] || null;
    const { precos, lista, origem, modalidade, ciclo } = await cc.precosDoContrato(pool, k);
    res.json({ ...detalhe, cobranca: cob, preco: { precos, lista, origem, modalidade, ciclo } });
  } catch (err) { responderErro(res, err, 'Erro ao buscar contrato'); }
});

// GET /:id/licencas/previa?abap=&funcional=&ambos= — quanto muda a cobrança ao acrescentar essas licenças
router.get('/:id/licencas/previa', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const { q } = cc.lerQuantidades({ abap: req.query.abap, funcional: req.query.funcional, ambos: req.query.ambos });
    res.json(await cc.previaAlteracaoLicencas(pool, k, q));
  } catch (err) { responderErro(res, err, 'Erro ao calcular'); }
});

// PUT /:id/precos { precos: { abap, funcional, ambos } } — preço negociado; vale a partir da próxima anuidade
router.put('/:id/precos', async (req, res) => {
  const db = await pool.connect();
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const precos = cc.lerPrecos((req.body || {}).precos);
    if (!precos) throw new cc.ErroRegra('Informe o preço de ao menos um perfil.');
    await db.query('BEGIN');
    const previa = await cc.previaAlteracaoLicencas(db, k, {}, precos);
    await cc.aplicarNaCobranca(db, k, previa, req.usuario.id);
    await db.query('COMMIT');
    res.json({ mensagem: previa.cobranca && previa.cobranca.status === 'ativo'
      ? `Preço salvo. A ${previa.ciclo === 'mensal' ? 'mensalidade' : 'anuidade'} passa a ${reais(previa.valor_anual_novo)} a partir da próxima cobrança (faturas já geradas não mudam).`
      : 'Preço salvo.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responderErro(res, err, 'Erro ao salvar o preço');
  } finally { db.release(); }
});

// Histórico das licenças do contrato e convite por perfil (admin Marsh)
router.get('/:id/historico', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    res.json(await cc.historicoContrato(k.id));
  } catch (err) { responderErro(res, err, 'Erro ao buscar o histórico'); }
});

router.post('/:id/convidar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const b = req.body || {};
    const r = await cc.ocuparVaga(k, { perfil: b.perfil }, b, k.gestor_usuario_id, req.usuario.id);
    await depoisDeOcupar(r);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado, vaga_id: r.vaga_id, estado: r.estado });
  } catch (err) { responderErro(res, err, 'Erro ao convidar'); }
});

// Administradores corporativos de um cliente (admin Marsh)
async function clienteDaEmpresa(req) {
  return (await pool.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2', [req.params.cid, emp(req)])).rows[0] || null;
}

router.get('/clientes/:cid/admins', async (req, res) => {
  try {
    if (!await clienteDaEmpresa(req)) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json(await cc.listarAdmins(req.params.cid));
  } catch (err) { responderErro(res, err, 'Erro ao buscar administradores'); }
});

router.post('/clientes/:cid/admins', async (req, res) => {
  try {
    if (!await clienteDaEmpresa(req)) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const b = req.body || {};
    const r = await cc.adicionarAdmin({ clienteId: req.params.cid, empresaId: emp(req), nome: b.nome, email: b.email, atorId: req.usuario.id });
    res.status(201).json({ mensagem: `${r.usuario.nome} agora é administrador da empresa.${r.criado ? (r.convite_enviado ? ` Convite enviado para ${r.usuario.email}.` : ' O convite não pôde ser enviado agora.') : ''}` });
  } catch (err) { responderErro(res, err, 'Erro ao adicionar administrador'); }
});

router.delete('/clientes/:cid/admins/:uid', async (req, res) => {
  try {
    if (!await clienteDaEmpresa(req)) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    await cc.removerAdmin({ clienteId: req.params.cid, empresaId: emp(req), usuarioId: req.params.uid, atorId: req.usuario.id });
    res.json({ mensagem: 'Administrador removido.' });
  } catch (err) { responderErro(res, err, 'Erro ao remover administrador'); }
});

// POST /:id/cobranca { valor_anual?, dia_vencimento? } — cria a cobrança (anual ou mensal, pelo ciclo) de um contrato que ainda não tem
router.post('/:id/cobranca', async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  try {
    const k = (await db.query('SELECT * FROM contratos_conector WHERE id = $1 AND empresa_id = $2', [req.params.id, emp(req)])).rows[0];
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await db.query('BEGIN');
    const c = await cc.criarCobranca(db, k, { valor: b.valor_anual, dia_vencimento: b.dia_vencimento, usuarioId: req.usuario.id });
    await db.query('COMMIT');
    res.status(201).json({ mensagem: `Cobrança ${c.ciclo === 'mensal' ? 'mensal' : 'anual'} de ${reais(c.valor)} criada. Veja em Financeiro → Contratos.`, contrato_financeiro_id: c.id });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responderErro(res, err, 'Erro ao criar a cobrança');
  } finally { db.release(); }
});

// POST / — { cliente_id, gestor_nome, gestor_email, vagas: { abap, funcional, ambos }, precos?, modalidade? (licenca | empresa),
//   ciclo? (anual | mensal), data_inicio?, data_fim, max_sids?, observacoes?, cobranca?: { gerar, valor_anual?, dia_vencimento? } }
router.post('/', async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  try {
    const cliente = (await db.query(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo IS NOT FALSE', [b.cliente_id, emp(req)])).rows[0];
    if (!cliente) throw new cc.ErroRegra('Escolha o cliente (comprador).');
    const { q, total } = cc.lerQuantidades(b.vagas);
    if (total < 1) throw new cc.ErroRegra('Informe ao menos 1 vaga.');
    const { inicio, fim } = lerDatas(b);
    const maxSids = b.max_sids === undefined || b.max_sids === '' ? 3 : Number(b.max_sids);
    if (!Number.isInteger(maxSids) || maxSids < 1 || maxSids > 10) throw new cc.ErroRegra('Máximo de SIDs: 1 a 10.');

    await db.query('BEGIN');
    const r = await cc.criarContrato(db, {
      empresaId: emp(req), clienteId: cliente.id, gestorNome: b.gestor_nome, gestorEmail: b.gestor_email, q, inicio, fim, maxSids,
      observacoes: b.observacoes, precos: cc.lerPrecos(b.precos), modalidade: cc.lerModalidade(b.modalidade), ciclo: cc.lerCiclo(b.ciclo),
      cobranca: b.cobranca && b.cobranca.gerar ? { gerar: true, valor: b.cobranca.valor_anual, dia_vencimento: b.cobranca.dia_vencimento } : null,
      usuarioId: req.usuario.id });
    await db.query('COMMIT');

    const { k, gestor, criado, cobranca } = r;
    const enviado = criado ? await cc.enviarConvite(gestor) : false;
    const txtCobranca = cobranca ? ` Cobrança ${cobranca.ciclo === 'mensal' ? 'mensal' : 'anual'} de ${reais(cobranca.valor)} criada em Financeiro → Contratos.` : '';
    res.status(201).json({
      id: k.id, convite_enviado: enviado, contrato_financeiro_id: cobranca && cobranca.id,
      mensagem: (criado
        ? (enviado ? `Contrato criado com ${total} vaga(s). Convite enviado ao gestor (${gestor.email}).`
          : `Contrato criado com ${total} vaga(s), mas o convite ao gestor não pôde ser enviado. Use "Reenviar convite".`)
        : `Contrato criado com ${total} vaga(s). ${gestor.nome} já tinha acesso ao portal e agora é o gestor.`) + txtCobranca
    });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responderErro(res, err, 'Erro ao criar contrato');
  } finally {
    db.release();
  }
});

// PUT /:id — { status?, data_inicio?, data_fim?, max_sids?, observacoes? }
router.put('/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    if (b.status !== undefined && !['ativo', 'suspenso', 'cancelado'].includes(b.status)) {
      throw new cc.ErroRegra('Status inválido (ativo, suspenso ou cancelado).');
    }
    const { inicio, fim } = lerDatas(b, k);
    const maxSids = b.max_sids === undefined || b.max_sids === '' ? k.max_sids : Number(b.max_sids);
    if (!Number.isInteger(maxSids) || maxSids < 1 || maxSids > 10) throw new cc.ErroRegra('Máximo de SIDs: 1 a 10.');
    if (maxSids < (k.conexoes || []).length) throw new cc.ErroRegra(`O contrato já tem ${k.conexoes.length} SIDs cadastrados; remova antes de baixar o limite.`);
    await pool.query(
      // Mudou o status à mão: a suspensão automática por atraso deixa de valer (o admin decidiu)
      `UPDATE contratos_conector SET status = $1::varchar, data_inicio = COALESCE($2::date, data_inicio), data_fim = $3, max_sids = $4, observacoes = $5,
         suspenso_por_fatura_id = CASE WHEN status <> $1::varchar THEN NULL ELSE suspenso_por_fatura_id END,
         data_atualizacao = NOW() WHERE id = $6`,
      [b.status || k.status, inicio, fim, maxSids,
       b.observacoes !== undefined ? (String(b.observacoes).trim() || null) : k.observacoes, k.id]);
    await cert.sincronizarContrato(k.id);
    // Suspender, cancelar, vencer ou renovar o contrato muda os cursos gratuitos de todas as vagas
    await acessos.sincronizarTodos({ contratoId: k.id }).catch(err => console.error('[acessos] contrato:', err.message));
    res.json({ mensagem: 'Contrato atualizado.' });
  } catch (err) { responderErro(res, err, 'Erro ao atualizar contrato'); }
});

// POST /:id/vagas — { abap?, funcional?, ambos? } acrescenta licenças. Com cobrança ativa: anuidade nova e
// fatura proporcional aos meses que faltam (rascunho no Faturamento), pelo preço do contrato.
router.post('/:id/vagas', async (req, res) => {
  const db = await pool.connect();
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const { q, total } = cc.lerQuantidades(req.body || {});
    if (total < 1) throw new cc.ErroRegra('Informe quantas licenças acrescentar.');
    await db.query('BEGIN');
    await db.query('SELECT id FROM contratos_conector WHERE id = $1 FOR UPDATE', [k.id]);
    const previa = await cc.previaAlteracaoLicencas(db, k, q);
    await cc.criarVagas(db, k.id, q);
    const { fatura_id } = await cc.aplicarNaCobranca(db, k, previa, req.usuario.id);
    await db.query('COMMIT');
    const cob = previa.cobranca && previa.cobranca.status === 'ativo';
    res.status(201).json({ fatura_id, mensagem: `${total} licença(s) acrescentada(s).`
      + (cob ? ` ${previa.ciclo === 'mensal' ? 'Mensalidade' : 'Anuidade'}: ${reais(previa.valor_anual_atual)} → ${reais(previa.valor_anual_novo)}.` : '')
      + (fatura_id ? ` Fatura proporcional de ${reais(previa.valor_proporcional)} criada em rascunho no Faturamento (aprove para enviar).` : '') });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responderErro(res, err, 'Erro ao acrescentar licenças');
  } finally { db.release(); }
});

// DELETE /:id/vagas/:vid — só licença livre. Com cobrança ativa, a próxima anuidade diminui (sem estorno).
router.delete('/:id/vagas/:vid', async (req, res) => {
  const db = await pool.connect();
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await db.query('BEGIN');
    const v = (await db.query(
      `SELECT perfil FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo AND usuario_id IS NULL FOR UPDATE`,
      [req.params.vid, k.id])).rows[0];
    if (!v) throw new cc.ErroRegra('Só dá para remover uma licença livre. Libere a licença antes.');
    const previa = await cc.previaAlteracaoLicencas(db, k, { [v.perfil]: -1 });
    await db.query('UPDATE contratos_conector_vagas SET ativo = FALSE WHERE id = $1', [req.params.vid]);
    await cc.aplicarNaCobranca(db, k, previa, req.usuario.id);
    await db.query('COMMIT');
    const cob = previa.cobranca && previa.cobranca.status === 'ativo';
    res.json({ mensagem: 'Licença removida.' + (cob ? ` A próxima ${previa.ciclo === 'mensal' ? 'mensalidade' : 'anuidade'} passa a ${reais(previa.valor_anual_novo)}.` : '') });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responderErro(res, err, 'Erro ao remover licença');
  } finally { db.release(); }
});

// GET /:id/vagas/:vid/perfil/previa?para= — quanto muda a cobrança ao trocar o perfil desta licença
router.get('/:id/vagas/:vid/perfil/previa', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const para = String(req.query.para || '');
    const v = (await pool.query('SELECT perfil FROM contratos_conector_vagas WHERE id = $1 AND contrato_id = $2 AND ativo', [req.params.vid, k.id])).rows[0];
    if (!v) return res.status(404).json({ erro: 'Licença não encontrada.' });
    if (!cc.PERFIS[para] || para === v.perfil) throw new cc.ErroRegra('Escolha um perfil diferente do atual.');
    res.json(await cc.previaAlteracaoLicencas(pool, k, { [v.perfil]: -1, [para]: 1 }, null, { troca: { de: v.perfil, para } }));
  } catch (err) { responderErro(res, err, 'Erro ao calcular'); }
});

// POST /:id/vagas/:vid/perfil { perfil } — muda o perfil da licença (a pessoa continua na vaga, com os cursos do perfil novo)
router.post('/:id/vagas/:vid/perfil', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const r = await cc.mudarPerfilVaga(k, req.params.vid, String((req.body || {}).perfil || ''), req.usuario.id);
    if (r.usuario_id) {
      await acessos.sincronizarUsuario(r.usuario_id, { atorId: req.usuario.id }).catch(err => console.error('[acessos] perfil:', err.message));
      await cert.avaliarUsuario(r.usuario_id).catch(err => console.error('[certificacao] perfil:', err.message));
    }
    const p = r.previa;
    const cob = p.cobranca && p.cobranca.status === 'ativo';
    res.json({ fatura_id: r.fatura_id || null,
      mensagem: `Licença mudou de ${cc.PERFIS[r.de].nome} para ${cc.PERFIS[r.para].nome}.`
        + (r.usuario_id ? ' A pessoa já vê os cursos do perfil novo.' : '')
        + (cob && p.valor_anual_novo !== p.valor_anual_atual ? ` ${p.ciclo === 'mensal' ? 'Mensalidade' : 'Anuidade'}: ${reais(p.valor_anual_atual)} → ${reais(p.valor_anual_novo)}.` : '')
        + (r.fatura_id ? ` Fatura proporcional de ${reais(p.valor_proporcional)} criada em rascunho no Faturamento (aprove para enviar).` : '') });
  } catch (err) { responderErro(res, err, 'Erro ao mudar o perfil'); }
});

router.post('/:id/vagas/:vid/ocupar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const corpo = { ...(req.body || {}) };
    const r = await cc.ocuparVaga(k, { vagaId: req.params.vid }, corpo, k.gestor_usuario_id, req.usuario.id); // "eu" = o gestor do contrato
    await depoisDeOcupar(r);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado });
  } catch (err) { responderErro(res, err, 'Erro ao ocupar a vaga'); }
});

router.post('/:id/vagas/:vid/liberar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await liberarComLicenca(k, req.params.vid, req.usuario.id);
    res.json({ mensagem: 'Vaga liberada.' });
  } catch (err) { responderErro(res, err, 'Erro ao liberar a vaga'); }
});

router.post('/:id/vagas/:vid/convite', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await reenviarConvite(k, req.params.vid, res);
  } catch (err) { responderErro(res, err, 'Erro ao reenviar o convite'); }
});

router.put('/:id/conexoes', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const lista = lerConexoes(req.body, k.max_sids);
    await pool.query('UPDATE contratos_conector SET conexoes = $1::jsonb, data_atualizacao = NOW() WHERE id = $2',
      [JSON.stringify(lista), k.id]);
    await cert.sincronizarContrato(k.id); // as licenças das vagas passam a usar os sistemas novos
    res.json({ mensagem: 'Sistemas SAP salvos.', conexoes: lista });
  } catch (err) { responderErro(res, err, 'Erro ao salvar os sistemas SAP'); }
});

router.post('/:id/gestor/convite', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const u = (await pool.query('SELECT id, nome, email FROM usuarios WHERE id = $1', [k.gestor_usuario_id])).rows[0];
    if (!await cc.enviarConvite(u)) return res.status(400).json({ erro: 'Não foi possível enviar o e-mail (envio desligado ou falhou).' });
    res.json({ mensagem: `Convite reenviado para ${u.email}.` });
  } catch (err) { responderErro(res, err, 'Erro ao reenviar o convite'); }
});

module.exports = router;
