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
const cc = require('../services/contratos-conector');
const cert = require('../services/certificacao');
const acessos = require('../services/acessos');
const auditoria = require('../services/auditoria');

const CAPAS = ['abap', 'func', 'fiori', 'cpi', 'geral'];
const STATUS = ['rascunho', 'publicado'];
const TRILHAS = Object.keys(cc.TRILHAS); // perfil da vaga do Conector → trilhas que o aluno vê

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

// Curso liberado para o usuário: publicado, ativo e (liberação vigente da empresa ou vaga do Conector
// cujo perfil cobre a trilha). $1 = cliente, $2 = usuário em todas as consultas do cliente.
const LIBERADO = cc.sqlCursoLiberado('$1', '$2');

// ============================== CLIENTE ==============================
// Cada curso traz as origens do acesso (pode haver mais de uma; perder uma não tira o curso se outra valer)
router.get('/meus', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json([]);
  try {
    const r = await pool.query(
      `SELECT c.id, c.titulo, c.descricao, c.capa, c.carga_horaria, c.trilha,
         ${cc.sqlViaLiberacao('$1', '$2')} AS via_liberacao,
         ${cc.sqlViaContratoCursos('$2')} AS via_contrato,
         ${cc.sqlViaBeneficio('$2')} AS via_beneficio,
         ${cc.sqlViaCompra('$2')} AS via_compra,
         (SELECT to_char(MAX(d.fim), 'YYYY-MM-DD') FROM direitos_acesso d WHERE d.usuario_id = $2 AND d.curso_id = c.id
           AND d.origem IN ('compra', 'manual') AND d.status = 'ativo') AS compra_fim,
         (SELECT bool_or(d.fim IS NULL) FROM direitos_acesso d WHERE d.usuario_id = $2 AND d.curso_id = c.id
           AND d.origem IN ('compra', 'manual') AND d.status = 'ativo') AS compra_sem_fim,
         (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = c.id AND a.ativo) AS total_aulas,
         (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
           WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS concluidas,
         (SELECT MAX(p.concluida_em) FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
           WHERE a.curso_id = c.id AND a.ativo AND p.usuario_id = $2) AS ultima_conclusao
       FROM cursos c WHERE ${LIBERADO}
       ORDER BY c.ordem, c.titulo`,
      [req.usuario.cliente_id || null, req.usuario.id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar cursos', detalhe: err.message });
  }
});

router.get('/meus/:id', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.status(404).json({ erro: 'Curso não encontrado' });
  try {
    const c = await pool.query(
      `SELECT c.id, c.titulo, c.descricao, c.capa, c.carga_horaria FROM cursos c
       WHERE ${LIBERADO} AND c.id = $3`, [req.usuario.cliente_id || null, req.usuario.id, req.params.id]);
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
  if (req.usuario.tipo !== 'cliente') return res.status(403).json({ erro: 'Somente alunos.' });
  try {
    const ok = await pool.query(
      `SELECT a.id, a.curso_id FROM cursos_aulas a JOIN cursos c ON c.id = a.curso_id
       WHERE a.id = $3 AND a.ativo AND ${LIBERADO}`, [req.usuario.cliente_id || null, req.usuario.id, req.params.id]);
    if (!ok.rows.length) return res.status(404).json({ erro: 'Aula não encontrada.' });
    if (req.body?.concluida === false) {
      await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = $1 AND aula_id = $2', [req.usuario.id, req.params.id]);
    } else {
      await pool.query(`INSERT INTO cursos_progresso (usuario_id, aula_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.usuario.id, req.params.id]);
    }
    await acessos.atualizarConclusao(req.usuario.id, ok.rows[0].curso_id); // histórico acadêmico (matrícula)
    // Última aula do perfil da vaga? Emite o certificado e a licença do Conector
    const emitidos = req.body?.concluida === false ? [] : await cert.avaliarUsuario(req.usuario.id)
      .catch(err => { console.error('[certificacao] concluir:', err.message); return []; });
    res.json({ ok: true, certificados: emitidos.map(c => c.codigo) });
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
  if (b.trilha !== undefined && b.trilha !== '' && b.trilha !== null && !TRILHAS.includes(b.trilha)) {
    return `Trilha inválida (${TRILHAS.join(', ')} ou vazio).`;
  }
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
    const lib = await pool.query('SELECT cliente_id, data_fim, contrato_cursos_id FROM cursos_liberacoes WHERE curso_id = $1', [c.id]);
    res.json({ ...c, aulas: aulas.rows, liberacoes: lib.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar curso', detalhe: err.message });
  }
});

router.post('/cursos', async (req, res) => {
  const erro = validarCurso(req.body, false);
  if (erro) return res.status(400).json({ erro });
  const { titulo, descricao, capa, carga_horaria, status, trilha } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO cursos (empresa_id, titulo, descricao, capa, carga_horaria, status, criado_por_usuario_id,
         ordem, trilha) VALUES ($1, $2, $3, $4, $5, $6, $7,
         (SELECT COALESCE(MAX(ordem), 0) + 1 FROM cursos WHERE empresa_id = $1), $8) RETURNING id`,
      [emp(req), titulo.trim(), descricao || null, capa || 'geral', carga_horaria || null, status || 'rascunho', req.usuario.id,
       trilha || null]);
    // Curso com trilha entra no benefício dos perfis da trilha (Cadastros → Benefícios do Conector ajusta)
    if (trilha) await acessos.incluirNoBeneficioPelaTrilha(r.rows[0].id, trilha, emp(req));
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
      `UPDATE cursos SET titulo = $1, descricao = $2, capa = $3, carga_horaria = $4, status = $5, trilha = $6,
         data_atualizacao = NOW() WHERE id = $7`,
      [b.titulo ?? c.titulo, b.descricao ?? c.descricao, b.capa ?? c.capa,
       b.carga_horaria ?? c.carga_horaria, b.status ?? c.status,
       b.trilha !== undefined ? (b.trilha || null) : c.trilha, c.id]);
    if (b.trilha && b.trilha !== c.trilha) await acessos.incluirNoBeneficioPelaTrilha(c.id, b.trilha, emp(req));
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
    // Liberação que veio de um contrato de cursos só sai pelo contrato (encerrar ou tirar o curso dele)
    await client.query('DELETE FROM cursos_liberacoes WHERE curso_id = $1 AND NOT (cliente_id = ANY($2)) AND contrato_cursos_id IS NULL', [c.id, validos]);
    for (const id of validos) {
      await client.query(`INSERT INTO cursos_liberacoes (curso_id, cliente_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [c.id, id]);
    }
    await client.query('COMMIT');
    // Rastro de quem ganhou/perdeu o curso pela liberação da empresa (o acesso em si já vale na hora)
    acessos.sincronizarTodos().catch(err => console.error('[acessos] liberações:', err.message));
    res.json({ mensagem: `Curso liberado para ${validos.length} cliente(s).` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ erro: 'Erro ao liberar curso', detalhe: err.message });
  } finally {
    client.release();
  }
});

// ===== Benefícios do Conector: cursos gratuitos incluídos em cada perfil de licença =====
router.get('/beneficios', async (req, res) => {
  try {
    const cursos = (await pool.query(
      `SELECT id, titulo, status, trilha FROM cursos WHERE empresa_id = $1 AND ativo ORDER BY ordem, titulo`, [emp(req)])).rows;
    const marcados = (await pool.query(
      `SELECT b.perfil, b.curso_id FROM beneficios b JOIN cursos c ON c.id = b.curso_id
       WHERE b.produto = 'conector' AND b.ativo AND c.empresa_id = $1`, [emp(req)])).rows;
    res.json({ perfis: Object.entries(cc.PERFIS).map(([id, p]) => ({ id, nome: p.nome })), cursos, marcados });
  } catch (err) { res.status(500).json({ erro: 'Erro ao buscar benefícios', detalhe: err.message }); }
});

// PUT { itens: [{ perfil, curso_id }] } — substitui o conjunto; quem perde um curso perde na hora (conferido ao vivo)
router.put('/beneficios', async (req, res) => {
  const itens = Array.isArray(req.body?.itens) ? req.body.itens : null;
  if (!itens) return res.status(400).json({ erro: 'Informe itens (lista de { perfil, curso_id }).' });
  if (itens.some(i => !cc.PERFIS[i.perfil] || !Number.isInteger(Number(i.curso_id)))) return res.status(400).json({ erro: 'Perfil ou curso inválido.' });
  const client = await pool.connect();
  try {
    const validos = new Set((await client.query('SELECT id FROM cursos WHERE empresa_id = $1 AND ativo', [emp(req)])).rows.map(r => r.id));
    const novos = itens.filter(i => validos.has(Number(i.curso_id))).map(i => `${i.perfil}|${Number(i.curso_id)}`);
    await client.query('BEGIN');
    const antes = (await client.query(
      `SELECT b.perfil, b.curso_id FROM beneficios b JOIN cursos c ON c.id = b.curso_id WHERE b.produto = 'conector' AND b.ativo AND c.empresa_id = $1 FOR UPDATE OF b`,
      [emp(req)])).rows.map(r => `${r.perfil}|${r.curso_id}`);
    const sai = antes.filter(x => !novos.includes(x)), entra = novos.filter(x => !antes.includes(x));
    for (const x of sai) {
      const [perfil, curso] = x.split('|');
      await client.query(`DELETE FROM beneficios WHERE produto = 'conector' AND perfil = $1 AND curso_id = $2`, [perfil, curso]);
    }
    for (const x of entra) {
      const [perfil, curso] = x.split('|');
      await client.query(`INSERT INTO beneficios (empresa_id, produto, perfil, curso_id) VALUES ($1, 'conector', $2, $3)
        ON CONFLICT (produto, perfil, curso_id) DO UPDATE SET ativo = TRUE`, [emp(req), perfil, curso]);
    }
    if (sai.length || entra.length) {
      await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'beneficios.alterados', entidade: 'beneficio',
        antes: { removidos: sai }, depois: { incluidos: entra } }, client);
    }
    await client.query('COMMIT');
    acessos.sincronizarTodos().catch(err => console.error('[acessos] benefícios:', err.message));
    res.json({ mensagem: `Benefícios salvos (${entra.length} incluído(s), ${sai.length} removido(s)). Vale na hora para quem tem licença.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ erro: 'Erro ao salvar benefícios', detalhe: err.message });
  } finally { client.release(); }
});

// ===== Acessos de um curso: quem tem/teve, por qual origem, até quando e por que acabou =====
router.get('/cursos/:id/acessos', async (req, res) => {
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const r = await pool.query(
      `SELECT d.id, d.origem, d.origem_descricao, d.status, d.inicio, to_char(d.fim, 'YYYY-MM-DD') AS fim, d.revogado_em, d.motivo,
              u.nome, u.email, COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente
       FROM direitos_acesso d JOIN usuarios u ON u.id = d.usuario_id LEFT JOIN clientes cl ON cl.id = u.cliente_id
       WHERE d.curso_id = $1 ORDER BY d.status = 'ativo' DESC, u.nome, d.origem`, [c.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro ao buscar acessos', detalhe: err.message }); }
});

// POST { email, fim? } — concessão manual a um usuário do portal (cortesia, parceiro...). Vale sem licença.
router.post('/cursos/:id/acessos', async (req, res) => {
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const email = String(req.body?.email || '').trim();
    const fim = req.body?.fim ? String(req.body.fim).slice(0, 10) : null;
    if (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim)) return res.status(400).json({ erro: 'Data de fim inválida.' });
    const u = (await pool.query(`SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) AND tipo = 'cliente' AND empresa_id = $2`, [email, emp(req)])).rows[0];
    if (!u) return res.status(400).json({ erro: 'Nenhum usuário do portal com esse e-mail.' });
    const acao = await acessos.conceder({ usuarioId: u.id, cursoId: c.id, origem: 'manual', descricao: `Liberado por ${req.usuario.nome || 'administrador'}`,
      fim, atorId: req.usuario.id, empresaId: emp(req) });
    res.status(201).json({ mensagem: acao ? 'Acesso liberado.' : 'A pessoa já tinha esse acesso (validade atualizada).' });
  } catch (err) { res.status(500).json({ erro: 'Erro ao liberar acesso', detalhe: err.message }); }
});

// DELETE /acessos/:id — revoga um acesso próprio (manual ou compra). Benefício acaba pela licença, não por aqui.
router.delete('/acessos/:id', async (req, res) => {
  try {
    const d = (await pool.query(
      `SELECT d.* FROM direitos_acesso d JOIN cursos c ON c.id = d.curso_id WHERE d.id = $1 AND c.empresa_id = $2`, [req.params.id, emp(req)])).rows[0];
    if (!d) return res.status(404).json({ erro: 'Acesso não encontrado.' });
    if (!['manual', 'compra'].includes(d.origem)) return res.status(400).json({ erro: 'Acesso por licença ou liberação da empresa acaba pela licença ou pela liberação.' });
    await acessos.revogarDireito({ usuarioId: d.usuario_id, cursoId: d.curso_id, origem: d.origem, origemId: d.origem_id,
      motivo: `Revogado por ${req.usuario.nome || 'administrador'}`, atorId: req.usuario.id });
    res.json({ mensagem: 'Acesso revogado. O progresso fica guardado.' });
  } catch (err) { res.status(500).json({ erro: 'Erro ao revogar acesso', detalhe: err.message }); }
});

// Progresso dos alunos: quem tem acesso agora (qualquer origem) e quem já se matriculou e perdeu o acesso
// (o histórico acadêmico fica). acesso_atual diz se ainda pode abrir o curso.
router.get('/cursos/:id/progresso', async (req, res) => {
  try {
    const c = await cursoDaEmpresa(req, req.params.id);
    if (!c) return res.status(404).json({ erro: 'Curso não encontrado' });
    const acessoAgora = `EXISTS (SELECT 1 FROM cursos c WHERE c.id = $1 AND ${cc.sqlCursoLiberado('u.cliente_id', 'u.id')})`;
    const r = await pool.query(
      `SELECT u.nome, COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente,
         (SELECT COUNT(*)::int FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
           WHERE p.usuario_id = u.id AND a.curso_id = $1 AND a.ativo) AS concluidas,
         (SELECT COUNT(*)::int FROM cursos_aulas a WHERE a.curso_id = $1 AND a.ativo) AS total,
         m.criado_em AS matriculado_em, m.concluido_em, ${acessoAgora} AS acesso_atual
       FROM usuarios u
       LEFT JOIN clientes cl ON cl.id = u.cliente_id
       LEFT JOIN matriculas m ON m.usuario_id = u.id AND m.curso_id = $1
       WHERE u.tipo = 'cliente' AND u.ativo IS NOT FALSE AND (m.id IS NOT NULL OR ${acessoAgora})
       ORDER BY cliente, u.nome`, [c.id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar progresso', detalhe: err.message });
  }
});

module.exports = router;
module.exports.normalizarVideo = normalizarVideo;
