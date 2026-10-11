/**
 * /api/treinamentos — cursos em vídeo do portal Marsh (requer login).
 *
 * Cliente:  GET /meus, GET /meus/:id, POST /aulas/:id/concluir  (só cursos publicados e liberados
 *           para o cliente dele, dentro da validade).
 * Admin:    CRUD de cursos e aulas, liberação por cliente, progresso dos alunos.
 * Vídeo: só players reconhecidos (YouTube -> youtube-nocookie, Vimeo, Panda, Bunny), em HTTPS.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');

const CAPAS = ['abap', 'func', 'fiori', 'cpi', 'geral'];
const STATUS = ['rascunho', 'publicado'];

function normalizarVideo(url) {
  const bruto = String(url || '').trim();
  if (!bruto) return null;
  let u;
  try { u = new URL(bruto); } catch { throw new Error('Link de vídeo inválido.'); }
  if (u.protocol !== 'https:') throw new Error('O link do vídeo precisa ser HTTPS.');
  const host = u.hostname.toLowerCase();

  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(host)) {
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/); id = m && m[2]; }
    if (!id || !/^[\w-]{6,20}$/.test(id)) throw new Error('Não encontrei o ID do vídeo do YouTube no link.');
    return `https://www.youtube-nocookie.com/embed/${id}`;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d{6,12})/);
    if (!m) throw new Error('Não encontrei o ID do vídeo do Vimeo no link.');
    const h = u.searchParams.get('h'); // vídeos privados "não listados"
    return `https://player.vimeo.com/video/${m[1]}${h ? `?h=${encodeURIComponent(h)}` : ''}`;
  }
  if (host.endsWith('.pandavideo.com.br') || host.endsWith('.pandavideo.com') ||
      host === 'iframe.mediadelivery.net' || host === 'player.mediadelivery.net') {
    return u.toString();
  }
  throw new Error('Player não suportado. Use YouTube, Vimeo, Panda Video ou Bunny Stream.');
}

function normalizarMaterial(url) {
  const bruto = String(url || '').trim();
  if (!bruto) return null;
  let u;
  try { u = new URL(bruto); } catch { throw new Error('Link do material inválido.'); }
  if (u.protocol !== 'https:') throw new Error('O link do material precisa ser HTTPS.');
  return u.toString();
}

// Curso liberado para o cliente: publicado, ativo e liberação vigente
const LIBERADO = `
  c.ativo = TRUE AND c.status = 'publicado' AND EXISTS (
    SELECT 1 FROM cursos_liberacoes lb
    WHERE lb.curso_id = c.id AND lb.cliente_id = $1 AND (lb.data_fim IS NULL OR lb.data_fim >= CURRENT_DATE))`;

// ============================== CLIENTE ==============================
router.get('/meus', async (req, res) => {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT c.id, c.titulo, c.descricao, c.capa, c.carga_horaria,
         (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo) AS total_aulas,
         (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
           WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS concluidas,
         (SELECT MAX(p.concluida_em) FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
           WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS ultima_conclusao
       FROM cursos c WHERE ${LIBERADO}
       ORDER BY c.ordem, c.titulo`,
      [req.usuario.cliente_id, req.usuario.id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar cursos', detalhe: err.message });
  }
});

router.get('/meus/:id', async (req, res) => {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return res.status(404).json({ erro: 'Curso não encontrado' });
  try {
    const c = await pool.query(
      `SELECT c.id, c.titulo, c.descricao, c.capa, c.carga_horaria FROM cursos c
       WHERE ${LIBERADO} AND c.id = $2`, [req.usuario.cliente_id, req.params.id]);
    if (!c.rows.length) return res.status(404).json({ erro: 'Curso não encontrado ou não liberado.' });
    const aulas = await pool.query(
      `SELECT a.id, a.modulo, a.titulo, a.descricao, a.video_url, a.material_url, a.duracao_min,
              (p.aula_id IS NOT NULL) AS concluida
       FROM cursos_aulas a
       LEFT JOIN cursos_progresso p ON p.aula_id = a.id AND p.usuario_id = $2
       WHERE a.curso_id = $1 AND a.ativo ORDER BY a.ordem, a.id`, [req.params.id, req.usuario.id]);
    res.json({ ...c.rows[0], aulas: aulas.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar curso', detalhe: err.message });
  }
});

router.post('/aulas/:id/concluir', async (req, res) => {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return res.status(403).json({ erro: 'Somente alunos.' });
  try {
    const ok = await pool.query(
      `SELECT a.id FROM cursos_aulas a JOIN cursos c ON c.id = a.curso_id
       WHERE a.id = $2 AND a.ativo AND ${LIBERADO}`, [req.usuario.cliente_id, req.params.id]);
    if (!ok.rows.length) return res.status(404).json({ erro: 'Aula não encontrada.' });
    if (req.body?.concluida === false) {
      await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = $1 AND aula_id = $2', [req.usuario.id, req.params.id]);
    } else {
      await pool.query(`INSERT INTO cursos_progresso (usuario_id, aula_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.usuario.id, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar progresso', detalhe: err.message });
  }
});

// ============================== ADMIN ==============================
router.use((req, res, next) => {
  const t = req.usuario.tipo;
  if (t !== 'admin_empresa' && t !== 'admin_sistema') {
    return res.status(403).json({ erro: 'Apenas administradores podem gerenciar treinamentos.' });
  }
  next();
});

const emp = req => req.usuario.empresa_id || 1;

async function cursoDaEmpresa(req, id) {
  const r = await pool.query('SELECT * FROM cursos WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE', [id, emp(req)]);
  return r.rows[0] || null;
}

function validarCurso(b, parcial) {
  if (!parcial || b.titulo !== undefined) {
    if (!String(b.titulo || '').trim()) return 'Título é obrigatório.';
  }
  if (b.capa !== undefined && !CAPAS.includes(b.capa)) return 'Capa inválida.';
  if (b.status !== undefined && !STATUS.includes(b.status)) return 'Status inválido (rascunho ou publicado).';
  return null;
}

router.get('/cursos', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*,
         (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo) AS total_aulas,
         (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo AND a.video_url IS NOT NULL) AS aulas_com_video,
         (SELECT COUNT(*)::int FROM cursos_liberacoes l WHERE l.curso_id = c.id) AS total_clientes
       FROM cursos c WHERE c.empresa_id = $1 AND c.ativo = TRUE ORDER BY c.ordem, c.titulo`, [emp(req)]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar cursos', detalhe: err.message });
  }
});

router.get('/cursos/:id', async (req, res) => {
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const aulas = await pool.query(
      'SELECT * FROM cursos_aulas WHERE curso_id = $1 AND ativo ORDER BY ordem, id', [c.id]);
    const lib = await pool.query('SELECT cliente_id, data_fim FROM cursos_liberacoes WHERE curso_id = $1', [c.id]);
    res.json({ ...c, aulas: aulas.rows, liberacoes: lib.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar curso', detalhe: err.message });
  }
});

router.post('/cursos', async (req, res) => {
  const erro = validarCurso(req.body, false);
  if (erro) return res.status(400).json({ erro });
  const { titulo, descricao, capa, carga_horaria, status } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO cursos (empresa_id, titulo, descricao, capa, carga_horaria, status, criado_por_usuario_id,
         ordem) VALUES ($1, $2, $3, $4, $5, $6, $7,
         (SELECT COALESCE(MAX(ordem), 0) + 1 FROM cursos WHERE empresa_id = $1)) RETURNING id`,
      [emp(req), titulo.trim(), descricao || null, capa || 'geral', carga_horaria || null, status || 'rascunho', req.usuario.id]);
    res.status(201).json({ mensagem: 'Curso criado!', id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar curso', detalhe: err.message });
  }
});

router.put('/cursos/:id', async (req, res) => {
  const erro = validarCurso(req.body, true);
  if (erro) return res.status(400).json({ erro });
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const b = req.body;
    await pool.query(
      `UPDATE cursos SET titulo = $1, descricao = $2, capa = $3, carga_horaria = $4, status = $5,
         data_atualizacao = NOW() WHERE id = $6`,
      [b.titulo ?? c.titulo, b.descricao ?? c.descricao, b.capa ?? c.capa,
       b.carga_horaria ?? c.carga_horaria, b.status ?? c.status, c.id]);
    res.json({ mensagem: 'Curso atualizado!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar curso', detalhe: err.message });
  }
});

router.delete('/cursos/:id', async (req, res) => {
  try {
    const r = await pool.query('UPDATE cursos SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Curso não encontrado' });
    res.json({ mensagem: 'Curso removido.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover curso', detalhe: err.message });
  }
});

router.post('/cursos/:id/aulas', async (req, res) => {
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const b = req.body || {};
    if (!String(b.titulo || '').trim()) return res.status(400).json({ erro: 'Título da aula é obrigatório.' });
    const r = await pool.query(
      `INSERT INTO cursos_aulas (curso_id, modulo, titulo, descricao, video_url, material_url, duracao_min, ordem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(ordem), -1) + 1 FROM cursos_aulas WHERE curso_id = $1))
       RETURNING id`,
      [c.id, b.modulo || null, b.titulo.trim(), b.descricao || null, normalizarVideo(b.video_url),
       normalizarMaterial(b.material_url), b.duracao_min ? Number(b.duracao_min) : null]);
    res.status(201).json({ mensagem: 'Aula criada!', id: r.rows[0].id });
  } catch (err) {
    res.status(err.message.startsWith('Erro') ? 500 : 400).json({ erro: err.message });
  }
});

router.put('/aulas/:id', async (req, res) => {
  try {
    const a = await pool.query(
      `SELECT a.* FROM cursos_aulas a JOIN cursos c ON c.id = a.curso_id
       WHERE a.id = $1 AND c.empresa_id = $2 AND a.ativo`, [req.params.id, emp(req)]);
    if (!a.rows.length) return res.status(404).json({ erro: 'Aula não encontrada' });
    const at = a.rows[0];
    const b = req.body || {};
    await pool.query(
      `UPDATE cursos_aulas SET modulo = $1, titulo = $2, descricao = $3, video_url = $4, material_url = $5,
         duracao_min = $6, ordem = $7 WHERE id = $8`,
      [b.modulo ?? at.modulo, (b.titulo ?? at.titulo).trim(), b.descricao ?? at.descricao,
       b.video_url !== undefined ? normalizarVideo(b.video_url) : at.video_url,
       b.material_url !== undefined ? normalizarMaterial(b.material_url) : at.material_url,
       b.duracao_min !== undefined ? (b.duracao_min ? Number(b.duracao_min) : null) : at.duracao_min,
       b.ordem !== undefined ? Number(b.ordem) : at.ordem, at.id]);
    res.json({ mensagem: 'Aula atualizada!' });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.delete('/aulas/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE cursos_aulas a SET ativo = FALSE FROM cursos c
       WHERE a.id = $1 AND c.id = a.curso_id AND c.empresa_id = $2 RETURNING a.id`, [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Aula não encontrada' });
    res.json({ mensagem: 'Aula removida.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover aula', detalhe: err.message });
  }
});

// Substitui o conjunto de clientes com acesso ao curso
router.put('/cursos/:id/liberacoes', async (req, res) => {
  const ids = Array.isArray(req.body?.cliente_ids) ? req.body.cliente_ids.map(Number).filter(Number.isInteger) : null;
  if (!ids) return res.status(400).json({ erro: 'Informe cliente_ids (lista).' });
  const client = await pool.connect();
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const validos = ids.length ? (await client.query(
      'SELECT id FROM clientes WHERE id = ANY($1) AND empresa_id = $2 AND ativo = TRUE', [ids, emp(req)])).rows.map(r => r.id) : [];
    await client.query('BEGIN');
    await client.query('DELETE FROM cursos_liberacoes WHERE curso_id = $1 AND NOT (cliente_id = ANY($2))', [c.id, validos]);
    for (const id of validos) {
      await client.query(`INSERT INTO cursos_liberacoes (curso_id, cliente_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [c.id, id]);
    }
    await client.query('COMMIT');
    res.json({ mensagem: `Curso liberado para ${validos.length} cliente(s).` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ erro: 'Erro ao liberar curso', detalhe: err.message });
  } finally {
    client.release();
  }
});

// Progresso dos alunos (usuários cliente das empresas liberadas)
router.get('/cursos/:id/progresso', async (req, res) => {
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const r = await pool.query(
      `SELECT u.nome, COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente,
         (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
           WHERE p.usuario_id = u.id AND a.curso_id = $1 AND a.ativo) AS concluidas,
         (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = $1 AND a.ativo) AS total
       FROM cursos_liberacoes lb
       JOIN clientes cl ON cl.id = lb.cliente_id
       JOIN usuarios u ON u.cliente_id = lb.cliente_id AND u.tipo = 'cliente' AND u.ativo IS NOT FALSE
       WHERE lb.curso_id = $1
       ORDER BY cliente, u.nome`, [c.id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar progresso', detalhe: err.message });
  }
});

module.exports = router;
module.exports.normalizarVideo = normalizarVideo;
