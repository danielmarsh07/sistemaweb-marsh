/**
 * Agente ABAP — Claude Code agendado na máquina da Marsh que analisa os chamados abertos pelo Conector SAP.
 *
 * /api/agente-servico (chave do agente no cabeçalho Authorization: Bearer MRSH-AG-..., sem login):
 *   GET  /chamados/pendentes            chamados do Conector em aberto e ainda sem análise (até 10, mais antigos primeiro)
 *   GET  /chamados/:id/anexos/:aid      link temporário para baixar um anexo do chamado
 *   POST /chamados/:id/analise          { analise (markdown), resumo?: { complexidade, horas, risco, cerebro } }
 *                                       grava (ou substitui) a análise interna e avisa os administradores por e-mail
 * /api/agente (login da equipe):
 *   GET|POST /chaves, DELETE /chaves/:id   (administrador) a chave aparece em texto só na criação
 *   GET  /chamados/:id/analise          análise interna do chamado (a equipe vê; o cliente nunca)
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const storage = require('../services/storage');
const email = require('../services/email');

const hashChave = c => crypto.createHash('sha256').update(String(c || '').trim()).digest('hex');
const ehAdmin = t => t === 'admin_empresa' || t === 'admin_sistema';
const COMPLEXIDADES = ['baixa', 'media', 'alta'];
const STATUS_ABERTOS = ['aberto', 'em_andamento', 'aguardando_cliente'];

// ============================== SERVIÇO (chave do agente) ==============================
const servico = express.Router();
servico.use(express.json({ limit: '1mb' }));
servico.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas requisições do agente. Tente em instantes.' } }));

servico.use(async (req, res, next) => {
  const m = /^Bearer\s+MRSH-AG-([a-f0-9]{32})$/i.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ erro: 'Chave do agente ausente ou inválida.' });
  try {
    const k = (await pool.query(
      'UPDATE agente_chaves SET ultimo_uso = NOW() WHERE chave_hash = $1 AND revogada = FALSE RETURNING id, empresa_id',
      [hashChave(`MRSH-AG-${m[1].toLowerCase()}`)])).rows[0];
    if (!k) return res.status(401).json({ erro: 'Chave do agente revogada ou desconhecida.' });
    req.agente = k;
    next();
  } catch (err) { next(err); }
});

async function chamadoDoAgente(req) {
  return (await pool.query(
    `SELECT ch.id, ch.empresa_id, ch.titulo FROM chamados ch
     WHERE ch.id = $1 AND ch.empresa_id = $2 AND ch.origem = 'conector' AND ch.ativo = TRUE`,
    [req.params.id, req.agente.empresa_id])).rows[0] || null;
}

servico.get('/chamados/pendentes', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ch.id, ch.titulo, ch.status, ch.prioridade, ch.sid, ch.modulo, ch.tipo_demanda, ch.aprovacao_cliente,
              ch.pedido_original, ch.especificacao, ch.objetos_sap, ch.solicitante_nome, ch.data_abertura,
              COALESCE(cl.razao_social, cl.nome) AS cliente_nome, ch.cliente_id,
              COALESCE((SELECT json_agg(json_build_object('id', a.id, 'nome', a.nome_original, 'tipo', a.mime_type,
                        'bytes', a.tamanho_bytes) ORDER BY a.id) FROM chamados_anexos a WHERE a.chamado_id = ch.id), '[]') AS anexos
       FROM chamados ch JOIN clientes cl ON cl.id = ch.cliente_id
       WHERE ch.empresa_id = $1 AND ch.origem = 'conector' AND ch.ativo = TRUE AND ch.status = ANY($2)
         AND ch.aprovacao_cliente IS DISTINCT FROM 'recusado'
         AND NOT EXISTS (SELECT 1 FROM chamados_analises x WHERE x.chamado_id = ch.id)
       ORDER BY ch.data_abertura, ch.id LIMIT 10`, [req.agente.empresa_id, STATUS_ABERTOS]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar chamados pendentes', detalhe: err.message });
  }
});

servico.get('/chamados/:id/anexos/:aid', async (req, res) => {
  try {
    if (!(await chamadoDoAgente(req))) return res.status(404).json({ erro: 'Chamado não encontrado.' });
    const a = (await pool.query('SELECT storage_key, nome_original FROM chamados_anexos WHERE id = $1 AND chamado_id = $2',
      [req.params.aid, req.params.id])).rows[0];
    if (!a) return res.status(404).json({ erro: 'Anexo não encontrado.' });
    if (!storage.disponivel) return res.status(503).json({ erro: 'Storage indisponível.' });
    res.json({ url: await storage.getDownloadUrl(a.storage_key, a.nome_original), nome: a.nome_original });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar o link do anexo', detalhe: err.message });
  }
});

servico.post('/chamados/:id/analise', async (req, res) => {
  const analise = typeof req.body?.analise === 'string' ? req.body.analise.trim() : '';
  if (analise.length < 20 || analise.length > 200000) return res.status(400).json({ erro: 'analise: markdown de 20 a 200.000 caracteres.' });
  const r0 = req.body?.resumo && typeof req.body.resumo === 'object' ? req.body.resumo : {};
  const resumo = {
    complexidade: COMPLEXIDADES.includes(String(r0.complexidade || '').toLowerCase()) ? String(r0.complexidade).toLowerCase() : null,
    horas: Number.isFinite(Number(r0.horas)) && Number(r0.horas) >= 0 && Number(r0.horas) <= 2000 ? Math.round(Number(r0.horas) * 10) / 10 : null,
    risco: r0.risco ? String(r0.risco).slice(0, 300) : null,
    cerebro: r0.cerebro && /^[A-Za-z0-9 _.\-]{1,80}$/.test(String(r0.cerebro)) ? String(r0.cerebro) : null
  };
  try {
    const ch = await chamadoDoAgente(req);
    if (!ch) return res.status(404).json({ erro: 'Chamado do Conector não encontrado.' });
    const r = await pool.query(
      `INSERT INTO chamados_analises (chamado_id, empresa_id, analise, resumo, agente_chave_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (chamado_id) DO UPDATE SET analise = EXCLUDED.analise, resumo = EXCLUDED.resumo,
         agente_chave_id = EXCLUDED.agente_chave_id, atualizado_em = NOW()
       RETURNING (xmax = 0) AS nova`,
      [ch.id, ch.empresa_id, analise, JSON.stringify(resumo), req.agente.id]);
    const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
    email.notificarAdminsComercial({
      empresa_id: ch.empresa_id,
      assunto: `Agente ABAP: análise do chamado #${ch.id} — ${ch.titulo}`,
      titulo: `Análise do chamado #${ch.id}`,
      linhas: [['Chamado', `#${ch.id} — ${ch.titulo}`], ['Complexidade', resumo.complexidade],
        ['Estimativa', resumo.horas != null ? `${String(resumo.horas).replace('.', ',')} h` : null],
        ['Risco', resumo.risco], ['Cérebro', resumo.cerebro],
        ['Resumo', analise.replace(/[#*`>|]/g, '').slice(0, 700) + (analise.length > 700 ? '…' : '')]],
      link: `${base}/dashboard.html`
    }).catch(() => {});
    res.status(r.rows[0].nova ? 201 : 200).json({ mensagem: `Análise do chamado #${ch.id} gravada.` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gravar a análise', detalhe: err.message });
  }
});

// ============================== EQUIPE (login) ==============================
const equipe = express.Router();

equipe.get('/chamados/:id/analise', async (req, res) => {
  try {
    const r = (await pool.query(
      `SELECT x.analise, x.resumo, x.criado_em, x.atualizado_em, k.nome AS agente
       FROM chamados_analises x LEFT JOIN agente_chaves k ON k.id = x.agente_chave_id
       WHERE x.chamado_id = $1 AND x.empresa_id = $2`, [req.params.id, req.usuario.empresa_id || 1])).rows[0];
    res.json(r || null);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar a análise', detalhe: err.message });
  }
});

equipe.use('/chaves', (req, res, next) => {
  if (!ehAdmin(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores gerenciam a chave do agente.' });
  next();
});

equipe.get('/chaves', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nome, prefixo, criado_em, ultimo_uso, revogada FROM agente_chaves
       WHERE empresa_id = $1 ORDER BY revogada, criado_em DESC`, [req.usuario.empresa_id || 1]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar as chaves do agente', detalhe: err.message });
  }
});

equipe.post('/chaves', async (req, res) => {
  const nome = String(req.body?.nome || '').trim().slice(0, 100) || 'Agente ABAP';
  const chave = `MRSH-AG-${crypto.randomBytes(16).toString('hex')}`;
  try {
    await pool.query(
      `INSERT INTO agente_chaves (empresa_id, nome, chave_hash, prefixo, criado_por_usuario_id) VALUES ($1, $2, $3, $4, $5)`,
      [req.usuario.empresa_id || 1, nome, hashChave(chave), chave.slice(0, 14), req.usuario.id]);
    res.status(201).json({ mensagem: 'Chave criada. Copie agora: ela não será exibida de novo.', chave });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar a chave do agente', detalhe: err.message });
  }
});

equipe.delete('/chaves/:id', async (req, res) => {
  try {
    const r = await pool.query('UPDATE agente_chaves SET revogada = TRUE WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [req.params.id, req.usuario.empresa_id || 1]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Chave não encontrada.' });
    res.json({ mensagem: 'Chave revogada: o agente para de acessar na hora.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao revogar a chave', detalhe: err.message });
  }
});

module.exports = { servico, equipe, hashChave };
