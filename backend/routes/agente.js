/**
 * Agente ABAP — Claude Code agendado na máquina da Marsh que analisa os chamados abertos pelo Conector SAP.
 *
 * /api/agente-servico (chave do agente no cabeçalho Authorization: Bearer MRSH-AG-..., sem login):
 *   GET  /chamados/pendentes            chamados do Conector em aberto e ainda sem análise (até 10, mais antigos primeiro)
 *   GET  /chamados/:id/anexos/:aid      link temporário para baixar um anexo do chamado
 *   POST /chamados/:id/analise          { analise (markdown), resumo?: { complexidade, horas, risco, cerebro },
 *                                         resposta?: texto ao solicitante (RASCUNHO; só sai quando a equipe envia) }
 *                                       grava (ou substitui) a análise interna e avisa os administradores por e-mail
 *   GET  /chamados/preparar             chamados com request SAP informada e sem preparo para ela
 *   POST /chamados/:id/preparo          { request, preparo (markdown) } preparo interno do desenvolvimento
 * /api/agente (login da equipe):
 *   GET|POST /chaves, DELETE /chaves/:id   (administrador) a chave aparece em texto só na criação
 *   GET  /chamados/:id/analise          análise interna, rascunho/resposta enviada e preparo (a equipe vê; o cliente nunca)
 *   POST /chamados/:id/resposta         { texto, reply_to } envia a resposta ao solicitante: vira atendimento e e-mail
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
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_REQUEST = /^[A-Z0-9]{3}K\d{6}$/;
const textoOpcional = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

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
  const resposta = textoOpcional(req.body?.resposta, 20000);
  try {
    const ch = await chamadoDoAgente(req);
    if (!ch) return res.status(404).json({ erro: 'Chamado do Conector não encontrado.' });
    // Reanálise sem resposta nova mantém o rascunho anterior
    const r = await pool.query(
      `INSERT INTO chamados_analises (chamado_id, empresa_id, analise, resumo, agente_chave_id, resposta_rascunho)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (chamado_id) DO UPDATE SET analise = EXCLUDED.analise, resumo = EXCLUDED.resumo,
         agente_chave_id = EXCLUDED.agente_chave_id, atualizado_em = NOW(),
         resposta_rascunho = COALESCE(EXCLUDED.resposta_rascunho, chamados_analises.resposta_rascunho)
       RETURNING (xmax = 0) AS nova`,
      [ch.id, ch.empresa_id, analise, JSON.stringify(resumo), req.agente.id, resposta]);
    const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
    email.notificarAdminsComercial({
      empresa_id: ch.empresa_id,
      assunto: `Agente ABAP: análise do chamado #${ch.id} — ${ch.titulo}`,
      titulo: `Análise do chamado #${ch.id}`,
      linhas: [['Chamado', `#${ch.id} — ${ch.titulo}`], ['Complexidade', resumo.complexidade],
        ['Estimativa', resumo.horas != null ? `${String(resumo.horas).replace('.', ',')} h` : null],
        ['Risco', resumo.risco], ['Cérebro', resumo.cerebro],
        ['Resposta ao solicitante', resposta ? 'Rascunho pronto: revise e envie no detalhe do chamado.' : null],
        ['Resumo', analise.replace(/[#*`>|]/g, '').slice(0, 700) + (analise.length > 700 ? '…' : '')]],
      link: `${base}/dashboard.html`
    }).catch(() => {});
    res.status(r.rows[0].nova ? 201 : 200).json({ mensagem: `Análise do chamado #${ch.id} gravada.` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gravar a análise', detalhe: err.message });
  }
});

// Request SAP informada no chamado e ainda sem preparo para ELA (trocar a request pede novo preparo)
servico.get('/chamados/preparar', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ch.id, ch.titulo, ch.sid, ch.modulo, ch.tipo_demanda, ch.request_sap, ch.objetos_sap, ch.especificacao,
              COALESCE(cl.razao_social, cl.nome) AS cliente_nome, x.analise, x.resumo
       FROM chamados ch JOIN clientes cl ON cl.id = ch.cliente_id JOIN chamados_analises x ON x.chamado_id = ch.id
       WHERE ch.empresa_id = $1 AND ch.origem = 'conector' AND ch.ativo = TRUE AND ch.status = ANY($2)
         AND ch.aprovacao_cliente IS DISTINCT FROM 'recusado' AND ch.request_sap IS NOT NULL
         AND x.preparo_request IS DISTINCT FROM ch.request_sap
       ORDER BY ch.request_sap_em, ch.id LIMIT 10`, [req.agente.empresa_id, STATUS_ABERTOS]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar chamados para preparar', detalhe: err.message });
  }
});

servico.post('/chamados/:id/preparo', async (req, res) => {
  const preparo = typeof req.body?.preparo === 'string' ? req.body.preparo.trim() : '';
  const request = String(req.body?.request || '').trim().toUpperCase();
  if (preparo.length < 20 || preparo.length > 200000) return res.status(400).json({ erro: 'preparo: markdown de 20 a 200.000 caracteres.' });
  if (!RE_REQUEST.test(request)) return res.status(400).json({ erro: 'request inválida (ex.: UPDK955200).' });
  try {
    const ch = await chamadoDoAgente(req);
    if (!ch) return res.status(404).json({ erro: 'Chamado do Conector não encontrado.' });
    const r = await pool.query(
      `UPDATE chamados_analises x SET preparo = $1, preparo_request = $2, preparo_em = NOW()
       FROM chamados ch WHERE x.chamado_id = $3 AND ch.id = x.chamado_id AND ch.request_sap = $2
       RETURNING x.chamado_id`, [preparo, request, ch.id]);
    if (!r.rows.length) return res.status(409).json({ erro: 'A request do chamado mudou ou o chamado ainda não tem análise.' });
    const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
    email.notificarAdminsComercial({
      empresa_id: ch.empresa_id,
      assunto: `Agente ABAP: desenvolvimento do chamado #${ch.id} preparado (${request})`,
      titulo: `Preparo do chamado #${ch.id}`,
      linhas: [['Chamado', `#${ch.id} — ${ch.titulo}`], ['Request', request],
        ['Próximo passo', 'Revisar o diff e gravar no DEV (conector sap, com a request).'],
        ['Resumo', preparo.replace(/[#*`>|]/g, '').slice(0, 700) + (preparo.length > 700 ? '…' : '')]],
      link: `${base}/dashboard.html`
    }).catch(() => {});
    res.json({ mensagem: `Preparo do chamado #${ch.id} gravado.` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gravar o preparo', detalhe: err.message });
  }
});

// ============================== EQUIPE (login) ==============================
const equipe = express.Router();

equipe.get('/chamados/:id/analise', async (req, res) => {
  try {
    const r = (await pool.query(
      `SELECT x.analise, x.resumo, x.criado_em, x.atualizado_em, k.nome AS agente,
              x.resposta_rascunho, x.resposta_enviada, x.resposta_enviada_em, ue.nome AS resposta_enviada_por_nome,
              x.preparo, x.preparo_request, x.preparo_em,
              ch.solicitante_email, cl.email_resposta_marsh,
              COALESCE(ch.solicitante_email, (SELECT u.email FROM licencas l JOIN usuarios u ON u.id = l.usuario_id
                WHERE l.id = ch.licenca_id)) AS destino_email
       FROM chamados_analises x LEFT JOIN agente_chaves k ON k.id = x.agente_chave_id
       JOIN chamados ch ON ch.id = x.chamado_id JOIN clientes cl ON cl.id = ch.cliente_id
       LEFT JOIN usuarios ue ON ue.id = x.resposta_enviada_por
       WHERE x.chamado_id = $1 AND x.empresa_id = $2`, [req.params.id, req.usuario.empresa_id || 1])).rows[0];
    res.json(r || null);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar a análise', detalhe: err.message });
  }
});

// Envia a resposta (revisada) ao solicitante: atendimento visível no portal + e-mail com Reply-To do consultor
// no cliente (guardado no cliente para o próximo envio). Vai SÓ para quem abriu o chamado: o e-mail do
// solicitante ou, sem ele, o do dono da licença do Conector que abriu. Nunca para os demais usuários do
// cliente (por isso não usa notificarNovoAtendimento). Sem nenhum dos dois, não envia.
equipe.post('/chamados/:id/resposta', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const texto = typeof req.body?.texto === 'string' ? req.body.texto.trim() : '';
  const replyTo = String(req.body?.reply_to || '').trim().toLowerCase();
  if (texto.length < 20 || texto.length > 20000) return res.status(400).json({ erro: 'Resposta de 20 a 20.000 caracteres.' });
  if (replyTo && (!RE_EMAIL.test(replyTo) || replyTo.length > 150)) return res.status(400).json({ erro: 'E-mail de resposta inválido.' });
  try {
    const ch = (await pool.query(
      `SELECT ch.*, x.chamado_id AS tem_analise FROM chamados ch LEFT JOIN chamados_analises x ON x.chamado_id = ch.id
       WHERE ch.id = $1 AND ch.empresa_id = $2 AND ch.ativo = TRUE AND ch.origem = 'conector'`, [req.params.id, empresa_id])).rows[0];
    if (!ch) return res.status(404).json({ erro: 'Chamado do Conector não encontrado.' });
    if (!ch.tem_analise) return res.status(409).json({ erro: 'O chamado ainda não tem análise do agente.' });
    const nome = (await pool.query('SELECT nome FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0]?.nome || 'Equipe Marsh';
    const dono = ch.solicitante_email ? null : (await pool.query(
      `SELECT u.email FROM licencas l JOIN usuarios u ON u.id = l.usuario_id WHERE l.id = $1`, [ch.licenca_id])).rows[0]?.email;
    const destino = ch.solicitante_email || dono;
    if (!destino) {
      return res.status(409).json({ erro: 'Não há e-mail de quem abriu o chamado (nem no chamado, nem na licença do Conector). Nada foi enviado.' });
    }
    const para = [destino];

    const statusNovo = ch.status === 'aberto' ? 'em_andamento' : ch.status;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, data_atendimento) VALUES ($1, $2, 'comentario', $3, NOW())`,
        [ch.id, req.usuario.id, texto]);
      await client.query(
        `UPDATE chamados_analises SET resposta_enviada = $1, resposta_enviada_em = NOW(), resposta_enviada_por = $2 WHERE chamado_id = $3`,
        [texto, req.usuario.id, ch.id]);
      if (statusNovo !== ch.status) {
        await client.query(`UPDATE chamados SET status = $1, atualizado_por_usuario_id = $2, data_atualizacao = NOW() WHERE id = $3`,
          [statusNovo, req.usuario.id, ch.id]);
        await client.query(
          `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
           VALUES ($1, $2, $3, $4, $5, 'Resposta da análise enviada ao solicitante')`, [ch.id, empresa_id, req.usuario.id, ch.status, statusNovo]);
      }
      if (replyTo) await client.query('UPDATE clientes SET email_resposta_marsh = $1 WHERE id = $2', [replyTo, ch.cliente_id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const enviado = await email.enviarRespostaSolicitante({
      para, chamado: ch, assinatura: nome, replyTo: replyTo || null, texto, request: ch.request_sap
    }).catch(() => false);
    res.json({ mensagem: enviado ? `Resposta enviada a ${para.join(', ')}.`
      : 'Resposta gravada no chamado, mas o e-mail não saiu (veja Alertas).', enviado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao enviar a resposta', detalhe: err.message });
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
