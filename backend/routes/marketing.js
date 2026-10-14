/**
 * /api/marketing — calendário de posts do Instagram, publicação automática, métricas e conta (só administradores).
 *
 * Posts: status rascunho → agendado → publicando → publicado | erro | cancelado.
 *   Rascunho pode ficar sem data. Publicado e "publicando" são só leitura.
 *   1 imagem = tipo imagem; 2 a 10 = carrossel (o tipo segue a quantidade de imagens).
 * Imagens: PNG/JPEG/WebP até 8 MB, convertidas para JPEG sRGB no upload, proporção de 4:5 a 1,91:1.
 *   Guardadas no storage em marketing/<post_id>/<nn>-<nome>.jpg; o painel recebe links assinados.
 * Conta: o token de longa duração do Instagram é gravado cifrado (MARKETING_CHAVE_CIFRA) e nunca é devolvido.
 * A publicação na hora marcada é da rotina backend/services/marketing-jobs.js (a cada 5 min).
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const storage = require('../services/storage');
const mk = require('../services/marketing');

const uploadImagens = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: mk.IMAGEM_MAX_BYTES, files: mk.IMAGENS_MAX }
});
// Importar agenda: agenda.json + as imagens de vários posts numa requisição
const uploadAgenda = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: mk.IMAGEM_MAX_BYTES, files: 150 }
});

const ehAdmin = tipo => tipo === 'admin_empresa' || tipo === 'admin_sistema';
router.use((req, res, next) => {
  if (!ehAdmin(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores acessam o marketing.' });
  next();
});

const empresaDe = req => req.usuario.empresa_id || 1;
const EDITAVEIS = ['rascunho', 'agendado', 'erro', 'cancelado'];
const STATUS = ['rascunho', 'agendado', 'publicando', 'publicado', 'erro', 'cancelado'];

const semStorage = res => res.status(503).json({
  erro: 'Storage (S3/R2) não configurado no servidor: configure as variáveis S3_* no Render para enviar imagens.' });

// Data/hora do agendamento e as regras para agendar ficam em services/marketing.js (a Ivy usa as mesmas)
const { lerData, erroParaAgendar } = mk;

// Erro do multer em mensagem legível
function erroUpload(err, res) {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ erro: 'Imagem maior que 8 MB.' });
  if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ erro: 'Arquivos demais nesta requisição.' });
  return res.status(400).json({ erro: 'Erro no upload', detalhe: err.message });
}

// Lista: links assinados da capa de cada post
async function comCapa(rows) {
  for (const p of rows) {
    p.capa_url = null;
    if (p.capa_key && storage.disponivel) {
      try { p.capa_url = await storage.getDownloadUrl(p.capa_key, null, 3600); } catch { /* sem miniatura */ }
    }
    delete p.capa_key;
    p.hashtags = mk.contarHashtags(p.legenda);
  }
  return rows;
}

async function postCompleto(id, empresaId) {
  const p = await mk.carregarPost(id, empresaId);
  if (!p) return null;
  p.midias = await mk.midiasDoPost(id);
  p.hashtags = mk.contarHashtags(p.legenda);
  const m = await pool.query(
    `SELECT data, alcance, curtidas, comentarios, salvamentos, compartilhamentos, interacoes, visualizacoes
     FROM marketing_metricas WHERE post_id = $1 ORDER BY data DESC LIMIT 1`, [id]);
  p.metricas = m.rows[0] || null;
  delete p.empresa_id;
  return p;
}

// ===================== POSTS =====================

// GET /posts?de=AAAA-MM-DD&ate=AAAA-MM-DD&status=agendado,publicado&sem_data=1
// Data de referência: a da publicação (publicado) ou a agendada, no dia de São Paulo.
router.get('/posts', async (req, res) => {
  const { de, ate } = req.query;
  const reData = /^\d{4}-\d{2}-\d{2}$/;
  if ((de && !reData.test(de)) || (ate && !reData.test(ate))) return res.status(400).json({ erro: 'Período inválido (AAAA-MM-DD).' });
  const status = String(req.query.status || '').split(',').map(s => s.trim()).filter(Boolean);
  if (status.some(s => !STATUS.includes(s))) return res.status(400).json({ erro: 'Status inválido.' });
  const semData = req.query.sem_data === '1' || req.query.sem_data === 'true';
  try {
    const r = await pool.query(
      `SELECT * FROM (
         SELECT p.id, p.tipo, p.titulo, p.legenda, p.data_agendada, p.status, p.tentativas, p.ultimo_erro,
                p.permalink, p.data_publicacao, p.data_atualizacao,
                to_char(COALESCE(p.data_publicacao, p.data_agendada) AT TIME ZONE '${mk.FUSO}', 'YYYY-MM-DD') AS dia,
                (SELECT COUNT(*)::int FROM marketing_midias m WHERE m.post_id = p.id) AS n_midias,
                (SELECT m.storage_key FROM marketing_midias m WHERE m.post_id = p.id ORDER BY m.ordem, m.id LIMIT 1) AS capa_key
         FROM marketing_posts p WHERE p.empresa_id = $1
       ) x
       WHERE (cardinality($2::text[]) = 0 OR x.status = ANY($2))
         AND ( ($3::text IS NULL AND $4::text IS NULL)
               OR (x.dia IS NOT NULL AND ($3::text IS NULL OR x.dia >= $3) AND ($4::text IS NULL OR x.dia <= $4))
               OR ($5 AND x.dia IS NULL) )
       ORDER BY x.dia NULLS LAST, COALESCE(x.data_publicacao, x.data_agendada), x.id`,
      [empresaDe(req), status, de || null, ate || null, semData]);
    res.json(await comCapa(r.rows));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar posts', detalhe: err.message });
  }
});

router.get('/posts/:id', async (req, res) => {
  try {
    const p = await postCompleto(req.params.id, empresaDe(req));
    if (!p) return res.status(404).json({ erro: 'Post não encontrado' });
    res.json(p);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar post', detalhe: err.message });
  }
});

// Valida os campos editáveis; devolve { erro } ou { campos }
function validarCampos(body) {
  const campos = {};
  if (body.titulo !== undefined) {
    const t = body.titulo == null ? '' : String(body.titulo).trim();
    if (t.length > 150) return { erro: 'O título interno deve ter até 150 caracteres.' };
    campos.titulo = t || null;
  }
  if (body.legenda !== undefined) {
    const l = body.legenda == null ? '' : String(body.legenda).replace(/\r\n/g, '\n');
    const e = mk.validarLegenda(l);
    if (e) return { erro: e };
    campos.legenda = l;
  }
  if (body.data_agendada !== undefined) {
    const d = lerData(body.data_agendada);
    if (d === 'invalida') return { erro: 'Data/hora inválida.' };
    campos.data_agendada = d;
  }
  if (body.status !== undefined && !['rascunho', 'agendado'].includes(body.status)) {
    return { erro: 'Status inválido: use rascunho ou agendado (para publicar já, use Publicar agora).' };
  }
  return { campos };
}


// POST /posts — cria (rascunho por padrão; status 'agendado' exige imagem, então só faz sentido depois do upload)
router.post('/posts', async (req, res) => {
  const v = validarCampos(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  if (req.body.status === 'agendado') return res.status(400).json({ erro: 'Envie as imagens antes de agendar.' });
  const c = v.campos;
  try {
    const r = await pool.query(
      `INSERT INTO marketing_posts (empresa_id, canal, tipo, titulo, legenda, data_agendada, status, criado_por)
       VALUES ($1, 'instagram', 'imagem', $2, $3, $4, 'rascunho', $5) RETURNING id`,
      [empresaDe(req), c.titulo ?? null, c.legenda ?? '', c.data_agendada ?? null, req.usuario.id]);
    res.status(201).json(await postCompleto(r.rows[0].id, empresaDe(req)));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar post', detalhe: err.message });
  }
});

// PUT /posts/:id — edita título, legenda, data e status (rascunho | agendado)
router.put('/posts/:id', async (req, res) => {
  const v = validarCampos(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const empresaId = empresaDe(req);
  try {
    const atual = await mk.carregarPost(req.params.id, empresaId);
    if (!atual) return res.status(404).json({ erro: 'Post não encontrado' });
    if (!EDITAVEIS.includes(atual.status)) return res.status(409).json({ erro: 'Post publicado (ou em publicação) não pode ser alterado.' });
    const c = v.campos;
    const novo = {
      titulo: c.titulo !== undefined ? c.titulo : atual.titulo,
      legenda: c.legenda !== undefined ? c.legenda : atual.legenda,
      data_agendada: c.data_agendada !== undefined ? c.data_agendada : atual.data_agendada,
      status: req.body.status || (atual.status === 'agendado' ? 'agendado' : atual.status)
    };
    if (novo.status === 'agendado') {
      const e = await erroParaAgendar(atual.id, novo.data_agendada);
      if (e) return res.status(400).json({ erro: e });
    }
    const reiniciar = novo.status === 'agendado' && atual.status !== 'agendado';
    await pool.query(
      `UPDATE marketing_posts SET titulo = $2, legenda = $3, data_agendada = $4, status = $5::varchar,
         tentativas = CASE WHEN $6::boolean THEN 0 ELSE tentativas END,
         ultimo_erro = CASE WHEN $6::boolean OR $5::varchar = 'rascunho' THEN NULL ELSE ultimo_erro END,
         data_atualizacao = NOW()
       WHERE id = $1 AND status = ANY($7)`,
      [atual.id, novo.titulo, novo.legenda, novo.data_agendada, novo.status, reiniciar, EDITAVEIS]);
    res.json(await postCompleto(atual.id, empresaId));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar post', detalhe: err.message });
  }
});

// POST /posts/:id/cancelar — não publica mais (continua na lista como cancelado)
router.post('/posts/:id/cancelar', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE marketing_posts SET status = 'cancelado', data_atualizacao = NOW()
       WHERE id = $1 AND empresa_id = $2 AND status IN ('rascunho', 'agendado', 'erro') RETURNING id`,
      [req.params.id, empresaDe(req)]);
    if (!r.rows.length) return res.status(409).json({ erro: 'Só rascunho, agendado ou com erro podem ser cancelados.' });
    res.json(await postCompleto(req.params.id, empresaDe(req)));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cancelar post', detalhe: err.message });
  }
});

// POST /posts/:id/duplicar — cópia em rascunho, sem data, com cópias das imagens
router.post('/posts/:id/duplicar', async (req, res) => {
  const empresaId = empresaDe(req);
  try {
    const o = await mk.carregarPost(req.params.id, empresaId);
    if (!o) return res.status(404).json({ erro: 'Post não encontrado' });
    const midias = (await pool.query('SELECT * FROM marketing_midias WHERE post_id = $1 ORDER BY ordem, id', [o.id])).rows;
    if (midias.length && !storage.disponivel) return semStorage(res);
    const titulo = `${o.titulo || 'Post #' + o.id} (cópia)`.slice(0, 150);
    const novo = (await pool.query(
      `INSERT INTO marketing_posts (empresa_id, canal, tipo, titulo, legenda, status, criado_por)
       VALUES ($1, 'instagram', $2, $3, $4, 'rascunho', $5) RETURNING id`,
      [empresaId, o.tipo, titulo, o.legenda, req.usuario.id])).rows[0].id;
    for (const m of midias) {
      const key = `marketing/${novo}/${m.storage_key.split('/').pop()}`;
      await storage.copiar(m.storage_key, key);
      await pool.query(
        `INSERT INTO marketing_midias (post_id, ordem, storage_key, nome_arquivo, largura, altura, tamanho_bytes, mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [novo, m.ordem, key, m.nome_arquivo, m.largura, m.altura, m.tamanho_bytes, m.mime]);
    }
    res.status(201).json(await postCompleto(novo, empresaId));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao duplicar post', detalhe: err.message });
  }
});

// DELETE /posts/:id — exclui de vez (só rascunho, cancelado ou erro) com as imagens do storage
router.delete('/posts/:id', async (req, res) => {
  try {
    const keys = (await pool.query(
      `SELECT m.storage_key FROM marketing_midias m JOIN marketing_posts p ON p.id = m.post_id
       WHERE p.id = $1 AND p.empresa_id = $2`, [req.params.id, empresaDe(req)])).rows.map(r => r.storage_key);
    const r = await pool.query(
      `DELETE FROM marketing_posts WHERE id = $1 AND empresa_id = $2 AND status IN ('rascunho', 'cancelado', 'erro') RETURNING id`,
      [req.params.id, empresaDe(req)]);
    if (!r.rows.length) return res.status(409).json({ erro: 'Só rascunho, cancelado ou com erro podem ser excluídos.' });
    if (storage.disponivel) await mk.removerArquivos(keys);
    res.json({ mensagem: 'Post excluído.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir post', detalhe: err.message });
  }
});

// POST /posts/:id/publicar-agora — publica na hora (mesmo fluxo da rotina, com a mesma trava)
router.post('/posts/:id/publicar-agora', async (req, res) => {
  const empresaId = empresaDe(req);
  try {
    const p = await mk.carregarPost(req.params.id, empresaId);
    if (!p) return res.status(404).json({ erro: 'Post não encontrado' });
    if (!['rascunho', 'agendado', 'erro', 'cancelado'].includes(p.status)) {
      return res.status(409).json({ erro: p.status === 'publicado' ? 'Este post já foi publicado.' : 'Este post já está sendo publicado.' });
    }
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM marketing_midias WHERE post_id = $1', [p.id])).rows[0].n;
    if (!n) return res.status(400).json({ erro: 'Envie ao menos uma imagem antes de publicar.' });
    const e = mk.validarLegenda(p.legenda);
    if (e) return res.status(400).json({ erro: e });
    if (!mk.cifraConfigurada()) return res.status(503).json({ erro: 'Configure MARKETING_CHAVE_CIFRA no servidor para publicar.' });
    const conta = await mk.dadosConta(empresaId);
    if (!conta || !conta.conectada) return res.status(400).json({ erro: 'Conecte a conta do Instagram em Marketing → Conta antes de publicar.' });
    if (!storage.disponivel) return semStorage(res);

    await pool.query(
      `UPDATE marketing_posts SET status = 'agendado', data_agendada = NOW(), tentativas = 0, ultimo_erro = NULL,
         data_atualizacao = NOW() WHERE id = $1 AND status = $2`, [p.id, p.status]);
    const travado = await mk.travarPost(p.id);
    if (!travado) return res.status(409).json({ erro: 'Este post já está sendo publicado.' });
    await mk.executarPublicacao(travado);
    const final = await postCompleto(p.id, empresaId);
    if (final.status === 'publicado') return res.json({ mensagem: 'Publicado no Instagram!', post: final });
    res.status(422).json({ erro: `O Instagram recusou a publicação: ${final.ultimo_erro || 'motivo desconhecido'}`, post: final });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao publicar', detalhe: err.message });
  }
});

// ===================== IMAGENS =====================

async function postEditavel(req, res) {
  const p = await mk.carregarPost(req.params.id, empresaDe(req));
  if (!p) { res.status(404).json({ erro: 'Post não encontrado' }); return null; }
  if (!EDITAVEIS.includes(p.status)) { res.status(409).json({ erro: 'Post publicado (ou em publicação) não pode ser alterado.' }); return null; }
  return p;
}

// POST /posts/:id/midias — campo "imagens" (1 a 10 arquivos); entram no fim, na ordem enviada
router.post('/posts/:id/midias', (req, res) => {
  if (!storage.disponivel) return semStorage(res);
  uploadImagens.array('imagens', mk.IMAGENS_MAX)(req, res, async (err) => {
    if (err) return erroUpload(err, res);
    try {
      const p = await postEditavel(req, res);
      if (!p) return;
      const arquivos = req.files || [];
      if (!arquivos.length) return res.status(400).json({ erro: 'Nenhuma imagem enviada.' });
      const n = (await pool.query('SELECT COUNT(*)::int AS n FROM marketing_midias WHERE post_id = $1', [p.id])).rows[0].n;
      if (n + arquivos.length > mk.IMAGENS_MAX) {
        return res.status(400).json({ erro: `O post já tem ${n} imagem(ns): o limite é ${mk.IMAGENS_MAX} por post.` });
      }
      const convertidas = [];
      for (const f of arquivos) {
        convertidas.push({ nome: f.originalname, ...(await mk.processarImagem(f.buffer, f.originalname)) });
      }
      await mk.adicionarMidias(p.id, convertidas);
      res.status(201).json(await postCompleto(p.id, empresaDe(req)));
    } catch (e) {
      if (e instanceof mk.ErroValidacao) return res.status(400).json({ erro: e.message });
      res.status(500).json({ erro: 'Erro ao enviar imagens', detalhe: e.message });
    }
  });
});

// PUT /posts/:id/midias/ordem — { ids: [mid, mid, ...] } na ordem nova (todas as imagens do post)
router.put('/posts/:id/midias/ordem', async (req, res) => {
  try {
    const p = await postEditavel(req, res);
    if (!p) return;
    const ids = (req.body.ids || []).map(Number);
    const atuais = (await pool.query('SELECT id FROM marketing_midias WHERE post_id = $1', [p.id])).rows.map(r => r.id);
    if (ids.length !== atuais.length || ids.some(i => !atuais.includes(i)) || new Set(ids).size !== ids.length) {
      return res.status(400).json({ erro: 'Informe todas as imagens do post, cada uma uma vez.' });
    }
    for (const [i, id] of ids.entries()) {
      await pool.query('UPDATE marketing_midias SET ordem = $1 WHERE id = $2 AND post_id = $3', [i + 1, id, p.id]);
    }
    await pool.query('UPDATE marketing_posts SET data_atualizacao = NOW() WHERE id = $1', [p.id]);
    res.json(await postCompleto(p.id, empresaDe(req)));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reordenar imagens', detalhe: err.message });
  }
});

// DELETE /posts/:id/midias/:mid
router.delete('/posts/:id/midias/:mid', async (req, res) => {
  try {
    const p = await postEditavel(req, res);
    if (!p) return;
    const r = await pool.query('DELETE FROM marketing_midias WHERE id = $1 AND post_id = $2 RETURNING storage_key',
      [req.params.mid, p.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Imagem não encontrada' });
    if (storage.disponivel) await mk.removerArquivos([r.rows[0].storage_key]);
    // renumera a ordem (1..n) e o tipo
    await pool.query(
      `UPDATE marketing_midias m SET ordem = x.n FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ordem, id) AS n FROM marketing_midias WHERE post_id = $1) x
       WHERE m.id = x.id`, [p.id]);
    await mk.atualizarTipo(p.id);
    const final = await postCompleto(p.id, empresaDe(req));
    // agendado sem imagem não publica: volta a rascunho
    if (final.status === 'agendado' && !final.midias.length) {
      await pool.query(`UPDATE marketing_posts SET status = 'rascunho' WHERE id = $1`, [p.id]);
      final.status = 'rascunho';
    }
    res.json(final);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover imagem', detalhe: err.message });
  }
});

// ===================== IMPORTAR AGENDA =====================
// POST /importar — multipart: "agenda" (texto JSON ou arquivo agenda.json) + "imagens" (os arquivos citados).
// Formato: { "posts": [ { "titulo", "data": "2026-10-19T12:30:00-03:00", "imagens": ["post-01.png"], "legenda" } ] }
// Valida tudo antes de gravar: se algo falhar, nada é criado. Data no passado = rascunho.
// Post igual (mesmo título e data, não cancelado) já existente é ignorado (importar duas vezes não duplica).
router.post('/importar', (req, res) => {
  if (!storage.disponivel) return semStorage(res);
  uploadAgenda.fields([{ name: 'agenda', maxCount: 1 }, { name: 'imagens', maxCount: 149 }])(req, res, async (err) => {
    if (err) return erroUpload(err, res);
    const empresaId = empresaDe(req);
    let agenda;
    try {
      const texto = req.files && req.files.agenda ? req.files.agenda[0].buffer.toString('utf8') : req.body.agenda;
      agenda = JSON.parse(String(texto || '').replace(/^﻿/, ''));
    } catch {
      return res.status(400).json({ erro: 'agenda.json ausente ou inválido (JSON).' });
    }
    const lista = agenda && Array.isArray(agenda.posts) ? agenda.posts : null;
    if (!lista || !lista.length) return res.status(400).json({ erro: 'O agenda.json não tem a lista "posts".' });
    if (lista.length > 100) return res.status(400).json({ erro: 'Importe no máximo 100 posts por vez.' });

    const arquivos = new Map();
    for (const f of (req.files && req.files.imagens) || []) arquivos.set(f.originalname.split(/[\\/]/).pop().toLowerCase(), f);

    const erros = [];
    const convertidas = new Map();
    const preparados = [];
    for (const [i, item] of lista.entries()) {
      const rotulo = `Post ${i + 1}${item && item.titulo ? ` (${item.titulo})` : ''}`;
      if (!item || typeof item !== 'object') { erros.push(`${rotulo}: item inválido.`); continue; }
      const titulo = item.titulo == null ? null : String(item.titulo).trim().slice(0, 150) || null;
      const data = lerData(item.data);
      if (!data || data === 'invalida') erros.push(`${rotulo}: data inválida ("${item.data ?? ''}").`);
      const legenda = item.legenda == null ? '' : String(item.legenda).replace(/\r\n/g, '\n');
      const eLeg = mk.validarLegenda(legenda);
      if (eLeg) erros.push(`${rotulo}: ${eLeg}`);
      const imgs = Array.isArray(item.imagens) ? item.imagens.map(String) : [];
      if (!imgs.length || imgs.length > mk.IMAGENS_MAX) erros.push(`${rotulo}: informe de 1 a ${mk.IMAGENS_MAX} imagens.`);
      for (const nome of imgs) {
        const chave = nome.split(/[\\/]/).pop().toLowerCase();
        const f = arquivos.get(chave);
        if (!f) { erros.push(`${rotulo}: imagem ${nome} não enviada.`); continue; }
        if (!convertidas.has(chave)) {
          try { convertidas.set(chave, { nome: f.originalname, ...(await mk.processarImagem(f.buffer, f.originalname)) }); }
          catch (e) {
            if (!(e instanceof mk.ErroValidacao)) return res.status(500).json({ erro: 'Erro ao converter imagem', detalhe: e.message });
            erros.push(`${rotulo}: ${e.message}`); convertidas.set(chave, null);
          }
        }
      }
      preparados.push({ titulo, data, legenda, imgs: imgs.map(n => n.split(/[\\/]/).pop().toLowerCase()) });
    }
    if (erros.length) return res.status(400).json({ erro: `A agenda tem ${erros.length} problema(s); nada foi importado.`, erros });

    const criados = [], ignorados = [];
    try {
      for (const p of preparados) {
        const existe = await pool.query(
          `SELECT id FROM marketing_posts WHERE empresa_id = $1 AND titulo IS NOT DISTINCT FROM $2 AND data_agendada = $3
             AND status <> 'cancelado' LIMIT 1`, [empresaId, p.titulo, p.data]);
        if (existe.rows.length) { ignorados.push({ titulo: p.titulo, data: p.data, id: existe.rows[0].id }); continue; }
        const status = p.data.getTime() > Date.now() + 60000 ? 'agendado' : 'rascunho';
        const id = (await pool.query(
          `INSERT INTO marketing_posts (empresa_id, canal, tipo, titulo, legenda, data_agendada, status, criado_por)
           VALUES ($1, 'instagram', 'imagem', $2, $3, $4, $5, $6) RETURNING id`,
          [empresaId, p.titulo, p.legenda, p.data, status, req.usuario.id])).rows[0].id;
        criados.push({ id, titulo: p.titulo, status });
        await mk.adicionarMidias(id, p.imgs.map(k => convertidas.get(k)));
      }
    } catch (e) {
      // desfaz o que entrou nesta importação
      for (const c of criados) {
        const keys = (await pool.query('SELECT storage_key FROM marketing_midias WHERE post_id = $1', [c.id])).rows.map(r => r.storage_key);
        await pool.query('DELETE FROM marketing_posts WHERE id = $1', [c.id]);
        await mk.removerArquivos(keys);
      }
      return res.status(500).json({ erro: 'Erro ao importar a agenda (nada foi gravado)', detalhe: e.message });
    }
    const agendados = criados.filter(c => c.status === 'agendado').length;
    res.status(201).json({
      mensagem: `${criados.length} post(s) importado(s): ${agendados} agendado(s)` +
        `${criados.length - agendados ? `, ${criados.length - agendados} como rascunho (data já passou)` : ''}` +
        `${ignorados.length ? `; ${ignorados.length} já existia(m) e foi(ram) ignorado(s)` : ''}.`,
      criados, ignorados
    });
  });
});

// ===================== MÉTRICAS =====================

router.get('/metricas', async (req, res) => {
  const empresaId = empresaDe(req);
  try {
    const conta = await mk.dadosConta(empresaId);
    const hist = (await pool.query(
      `SELECT to_char(data, 'YYYY-MM-DD') AS data, seguidores FROM marketing_seguidores
       WHERE empresa_id = $1 AND data >= CURRENT_DATE - 90 ORDER BY data`, [empresaId])).rows;
    const atual = conta && conta.seguidores != null ? conta.seguidores : (hist.length ? hist[hist.length - 1].seguidores : null);
    // Variação: seguidores de hoje menos o último registro de N dias atrás (ou antes)
    const variacao = async dias => {
      const r = await pool.query(
        `SELECT seguidores FROM marketing_seguidores WHERE empresa_id = $1
           AND data <= (NOW() AT TIME ZONE '${mk.FUSO}')::date - $2::int ORDER BY data DESC LIMIT 1`, [empresaId, dias]);
      return r.rows.length && atual != null ? atual - r.rows[0].seguidores : null;
    };
    const posts = (await pool.query(
      `SELECT p.id, p.tipo, p.titulo, p.legenda, p.permalink, p.data_publicacao,
              (SELECT m.storage_key FROM marketing_midias m WHERE m.post_id = p.id ORDER BY m.ordem, m.id LIMIT 1) AS capa_key,
              mt.data AS metricas_em, mt.alcance, mt.curtidas, mt.comentarios, mt.salvamentos, mt.compartilhamentos,
              mt.interacoes, mt.visualizacoes
       FROM marketing_posts p
       LEFT JOIN LATERAL (SELECT * FROM marketing_metricas x WHERE x.post_id = p.id ORDER BY x.data DESC LIMIT 1) mt ON TRUE
       WHERE p.empresa_id = $1 AND p.status = 'publicado'
       ORDER BY p.data_publicacao DESC NULLS LAST LIMIT 60`, [empresaId])).rows;
    const mes = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM marketing_posts WHERE empresa_id = $1 AND status = 'publicado'
         AND date_trunc('month', data_publicacao AT TIME ZONE '${mk.FUSO}') = date_trunc('month', NOW() AT TIME ZONE '${mk.FUSO}')`,
      [empresaId])).rows[0].n;
    const ult30 = posts.filter(p => p.data_publicacao && new Date(p.data_publicacao) >= new Date(Date.now() - 30 * 86400000));
    const soma = campo => ult30.reduce((s, p) => s + (Number(p[campo]) || 0), 0);
    res.json({
      conta: conta ? { username: conta.username, conectada: conta.conectada, seguidores: conta.seguidores, atualizado_em: conta.atualizado_em } : null,
      seguidores: atual,
      variacao_7d: await variacao(7),
      variacao_30d: await variacao(30),
      publicados_mes: mes,
      posts_30d: ult30.length,
      alcance_30d: soma('alcance'),
      interacoes_30d: soma('interacoes'),
      historico_seguidores: hist,
      posts: await comCapa(posts)
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar métricas', detalhe: err.message });
  }
});

// POST /metricas/atualizar — roda agora a parte diária (seguidores + métricas dos últimos 30 dias)
router.post('/metricas/atualizar', async (req, res) => {
  const empresaId = empresaDe(req);
  try {
    if (!mk.cifraConfigurada()) return res.status(503).json({ erro: 'Configure MARKETING_CHAVE_CIFRA no servidor.' });
    const conta = await mk.dadosConta(empresaId);
    if (!conta || !conta.conectada) return res.status(400).json({ erro: 'Conecte a conta do Instagram primeiro.' });
    const seguidores = await mk.atualizarSeguidores(empresaId);
    const posts = await mk.atualizarMetricas(empresaId);
    res.json({ mensagem: `Métricas atualizadas: ${posts} post(s).`, seguidores, posts });
  } catch (err) {
    res.status(422).json({ erro: `Não foi possível atualizar: ${err.message}` });
  }
});

// ===================== CONTA =====================

router.get('/conta', async (req, res) => {
  try {
    const c = await mk.dadosConta(empresaDe(req));
    res.json({
      cifra_configurada: mk.cifraConfigurada(),
      storage: storage.disponivel,
      conectada: !!(c && c.conectada),
      ig_user_id: c ? c.ig_user_id : null,
      username: c ? c.username : null,
      seguidores: c ? c.seguidores : null,
      token_expira_em: c ? c.token_expira_em : null,
      atualizado_em: c ? c.atualizado_em : null
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar a conta', detalhe: err.message });
  }
});

// POST /conta — { token }: valida no Instagram e grava cifrado (troca a conta, se já houver)
router.post('/conta', async (req, res) => {
  if (!mk.cifraConfigurada()) {
    return res.status(503).json({ erro: 'Configure MARKETING_CHAVE_CIFRA no servidor (32 bytes em hex ou base64) para conectar a conta.' });
  }
  try {
    const c = await mk.conectarConta(empresaDe(req), req.body && req.body.token);
    res.json({ mensagem: `Conta @${c.username} conectada.`, username: c.username, seguidores: c.seguidores,
               token_expira_em: c.token_expira_em });
  } catch (err) {
    if (err instanceof mk.ErroValidacao) return res.status(400).json({ erro: err.message });
    if (err.name === 'ErroGraph') return res.status(400).json({ erro: `O Instagram recusou o token: ${err.message}` });
    res.status(500).json({ erro: 'Erro ao conectar a conta', detalhe: err.message });
  }
});

// POST /conta/testar — chama o Instagram com o token gravado e atualiza os seguidores
router.post('/conta/testar', async (req, res) => {
  const empresaId = empresaDe(req);
  try {
    if (!mk.cifraConfigurada()) return res.status(503).json({ erro: 'Configure MARKETING_CHAVE_CIFRA no servidor.' });
    const c = await mk.dadosConta(empresaId);
    if (!c || !c.conectada) return res.status(400).json({ erro: 'Nenhuma conta conectada.' });
    const seguidores = await mk.atualizarSeguidores(empresaId);
    const d = await mk.dadosConta(empresaId);
    res.json({ ok: true, mensagem: `Conexão OK: @${d.username}, ${seguidores ?? '?'} seguidores.`, username: d.username, seguidores });
  } catch (err) {
    res.status(422).json({ ok: false, erro: `Falha ao falar com o Instagram: ${err.message}` });
  }
});

// DELETE /conta — desconecta (apaga o token; o histórico de seguidores e métricas fica)
router.delete('/conta', async (req, res) => {
  try {
    await pool.query(
      `UPDATE marketing_conta SET token_cifrado = NULL, token_expira_em = NULL, atualizado_em = NOW() WHERE empresa_id = $1`,
      [empresaDe(req)]);
    res.json({ mensagem: 'Conta desconectada. Posts agendados não serão publicados até conectar de novo.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao desconectar', detalhe: err.message });
  }
});

module.exports = router;
