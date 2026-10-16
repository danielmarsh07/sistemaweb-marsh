/**
 * /api/contratos-conector — contratos do Conector SAP por vagas (requer login). Regras em services/contratos-conector.js.
 *
 * Portal (cliente):
 *   GET  /eu                                   papel no portal + vagas do próprio usuário (o portal decide o que mostra)
 *   GET  /meus                                 contratos em que o usuário é gestor (vagas, ocupantes, progresso, SIDs)
 *   POST /meus/:id/vagas/:vid/ocupar           { eu: true } ou { nome, email } (convite por e-mail)
 *   POST /meus/:id/vagas/:vid/liberar
 *   POST /meus/:id/vagas/:vid/convite          reenvia o convite ao ocupante
 *   PUT  /meus/:id/conexoes                    { conexoes: [{ sid, descricao, url, mandante, idioma }] } até max_sids
 * Admin: GET /, GET /:id, POST /, PUT /:id, POST /:id/vagas, DELETE /:id/vagas/:vid,
 *        POST /:id/vagas/:vid/ocupar|liberar, PUT /:id/conexoes, POST /:id/gestor/convite
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const cc = require('../services/contratos-conector');
const { validarConexoes } = require('../services/licenca');

const ehAdmin = t => t === 'admin_empresa' || t === 'admin_sistema';
const emp = req => req.usuario.empresa_id || 1;

function responderErro(res, err, msg) {
  if (err instanceof cc.ErroRegra) return res.status(400).json({ erro: err.message });
  res.status(500).json({ erro: msg, detalhe: err.message });
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
router.get('/eu', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json({ papel: null, gestor: false, vagas: [] });
  try {
    const papel = await cc.papelPortal(req.usuario.id);
    const gestor = (await pool.query(
      `SELECT 1 FROM contratos_conector WHERE gestor_usuario_id = $1 AND status <> 'cancelado' LIMIT 1`, [req.usuario.id])).rows.length > 0;
    const vagas = (await pool.query(
      `SELECT v.id, v.perfil, k.id AS contrato_id, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
              (${cc.VAGA_VIGENTE}) AS vigente
       FROM contratos_conector_vagas v JOIN contratos_conector k ON k.id = v.contrato_id
       WHERE v.usuario_id = $1 AND v.ativo AND k.status <> 'cancelado' ORDER BY v.id`, [req.usuario.id])).rows
      .map(v => ({ ...v, perfil_nome: cc.PERFIS[v.perfil]?.nome || v.perfil }));
    res.json({ papel, gestor, vagas });
  } catch (err) { responderErro(res, err, 'Erro ao buscar seu acesso'); }
});

async function contratoDoGestor(req) {
  if (req.usuario.tipo !== 'cliente') return null;
  const r = await pool.query(
    `SELECT * FROM contratos_conector WHERE id = $1 AND gestor_usuario_id = $2 AND status <> 'cancelado'`,
    [req.params.id, req.usuario.id]);
  return r.rows[0] || null;
}

router.get('/meus', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json([]);
  try {
    const ids = (await pool.query(
      `SELECT id FROM contratos_conector WHERE gestor_usuario_id = $1 AND status <> 'cancelado' ORDER BY data_fim DESC, id DESC`,
      [req.usuario.id])).rows;
    res.json(await Promise.all(ids.map(r => cc.detalharContrato(r.id))));
  } catch (err) { responderErro(res, err, 'Erro ao buscar contratos'); }
});

router.post('/meus/:id/vagas/:vid/ocupar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const r = await cc.ocuparVaga(k, req.params.vid, req.body || {}, req.usuario.id);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado });
  } catch (err) { responderErro(res, err, 'Erro ao ocupar a vaga'); }
});

router.post('/meus/:id/vagas/:vid/liberar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await cc.liberarVaga(k, req.params.vid);
    res.json({ mensagem: 'Vaga liberada. A pessoa perde o acesso aos cursos desta vaga.' });
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
              (SELECT COUNT(*)::int FROM contratos_conector_vagas v WHERE v.contrato_id = k.id AND v.ativo AND v.perfil = 'ambos') AS vagas_ambos
       FROM contratos_conector k
       JOIN clientes cl ON cl.id = k.cliente_id
       JOIN usuarios g ON g.id = k.gestor_usuario_id
       WHERE k.empresa_id = $1
       ORDER BY (k.status = 'cancelado'), k.data_fim, k.id`, [emp(req)]);
    res.json(r.rows);
  } catch (err) { responderErro(res, err, 'Erro ao listar contratos'); }
});

router.get('/:id', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    res.json(await cc.detalharContrato(k.id));
  } catch (err) { responderErro(res, err, 'Erro ao buscar contrato'); }
});

// POST / — { cliente_id, gestor_nome, gestor_email, vagas: { abap, funcional, ambos }, data_inicio?, data_fim, max_sids?, observacoes? }
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
    const { usuario: gestor, criado } = await cc.acharOuCriarUsuario(db, {
      clienteId: cliente.id, empresaId: emp(req), nome: b.gestor_nome, email: b.gestor_email, papel: 'gestor' });
    const k = (await db.query(
      `INSERT INTO contratos_conector (empresa_id, cliente_id, gestor_usuario_id, data_inicio, data_fim, max_sids, observacoes, criado_por_usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      // Sem início: hoje no horário de Brasília (o CURRENT_DATE do banco é UTC e viraria o dia às 21h)
      [emp(req), cliente.id, gestor.id, inicio || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }), fim, maxSids, String(b.observacoes || '').trim() || null, req.usuario.id])).rows[0];
    await cc.criarVagas(db, k.id, q);
    await db.query('COMMIT');

    const enviado = criado ? await cc.enviarConvite(gestor) : false;
    res.status(201).json({
      id: k.id, convite_enviado: enviado,
      mensagem: criado
        ? (enviado ? `Contrato criado com ${total} vaga(s). Convite enviado ao gestor (${gestor.email}).`
          : `Contrato criado com ${total} vaga(s), mas o convite ao gestor não pôde ser enviado. Use "Reenviar convite".`)
        : `Contrato criado com ${total} vaga(s). ${gestor.nome} já tinha acesso ao portal e agora é o gestor.`
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
      `UPDATE contratos_conector SET status = $1, data_inicio = COALESCE($2::date, data_inicio), data_fim = $3, max_sids = $4, observacoes = $5,
         data_atualizacao = NOW() WHERE id = $6`,
      [b.status || k.status, inicio, fim, maxSids,
       b.observacoes !== undefined ? (String(b.observacoes).trim() || null) : k.observacoes, k.id]);
    res.json({ mensagem: 'Contrato atualizado.' });
  } catch (err) { responderErro(res, err, 'Erro ao atualizar contrato'); }
});

// POST /:id/vagas — { abap?, funcional?, ambos? } acrescenta vagas
router.post('/:id/vagas', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const { q, total } = cc.lerQuantidades(req.body || {});
    if (total < 1) throw new cc.ErroRegra('Informe quantas vagas acrescentar.');
    await cc.criarVagas(pool, k.id, q);
    res.status(201).json({ mensagem: `${total} vaga(s) acrescentada(s).` });
  } catch (err) { responderErro(res, err, 'Erro ao acrescentar vagas'); }
});

// DELETE /:id/vagas/:vid — só vaga livre
router.delete('/:id/vagas/:vid', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const r = await pool.query(
      `UPDATE contratos_conector_vagas SET ativo = FALSE WHERE id = $1 AND contrato_id = $2 AND ativo AND usuario_id IS NULL RETURNING id`,
      [req.params.vid, k.id]);
    if (!r.rows.length) throw new cc.ErroRegra('Só dá para remover uma vaga livre. Libere a vaga antes.');
    res.json({ mensagem: 'Vaga removida.' });
  } catch (err) { responderErro(res, err, 'Erro ao remover vaga'); }
});

router.post('/:id/vagas/:vid/ocupar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const corpo = { ...(req.body || {}) };
    const r = await cc.ocuparVaga(k, req.params.vid, corpo, k.gestor_usuario_id); // "eu" = o gestor do contrato
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado });
  } catch (err) { responderErro(res, err, 'Erro ao ocupar a vaga'); }
});

router.post('/:id/vagas/:vid/liberar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await cc.liberarVaga(k, req.params.vid);
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
