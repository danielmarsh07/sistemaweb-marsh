require('./_ambiente-local');
// Marketing (Instagram): conta com token cifrado, upload PNG→JPEG, proporção, posts (criar/agendar/editar/cancelar/
// duplicar), importar agenda, publicação de imagem e carrossel num servidor FALSO do Graph, trava contra publicar
// duas vezes, erro → retentativa → erro final + alerta, limite → reagenda, métricas, seguidores, renovação do token
// e permissões (técnico/cliente 403).
//
// O servidor local precisa apontar para o Graph falso que este teste sobe (porta 3999, ou MARKETING_GRAPH_PORTA),
// usar a mesma chave de cifra e ter storage S3 (adobe/s3mock). No Git Bash:
//   docker run -d --name marsh-s3mock -p 9090:9090 -e initialBuckets=marsh-teste adobe/s3mock   (se não estiver rodando)
//   INSTAGRAM_GRAPH_URL=http://localhost:3999 MARKETING_CHAVE_CIFRA=abababababababababababababababababababababababababababababababab \
//   MARKETING_JOBS=off S3_BUCKET=marsh-teste S3_ENDPOINT=http://localhost:9090 S3_REGION=us-east-1 \
//   S3_ACCESS_KEY_ID=teste S3_SECRET_ACCESS_KEY=teste npm run dev:local
// Uso: node testes/marketing.js
// A rotina (publicar pendentes, diária) é chamada direto daqui, sem esperar os 5 minutos.
const http = require('http');
const jwt = require('jsonwebtoken');

const PORTA_GRAPH = Number(process.env.MARKETING_GRAPH_PORTA || 3999);
const CHAVE_TESTE = 'ab'.repeat(32);
// Mesmas variáveis do servidor, para as funções da rotina rodarem neste processo
process.env.INSTAGRAM_GRAPH_URL = process.env.INSTAGRAM_GRAPH_URL || `http://localhost:${PORTA_GRAPH}`;
process.env.MARKETING_CHAVE_CIFRA = process.env.MARKETING_CHAVE_CIFRA || CHAVE_TESTE;
process.env.MARKETING_STATUS_ESPERA_MS = '30';
for (const [k, v] of Object.entries({ S3_BUCKET: 'marsh-teste', S3_ENDPOINT: 'http://localhost:9090', S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'teste', S3_SECRET_ACCESS_KEY: 'teste' })) process.env[k] = process.env[k] || v;

const sharp = require('sharp');
const pool = require('../backend/db');
const storage = require('../backend/services/storage');
const mk = require('../backend/services/marketing');
const jobs = require('../backend/services/marketing-jobs');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const respostas = []; // todo corpo recebido da API (para conferir que o token nunca volta)

// ===================== Graph falso =====================
const TOKEN_VALIDO = 'IGAAteste' + 'X'.repeat(40) + 'longaduracao';
const IG_USER = '17841400000000001';
const fake = {
  chamadas: [], tokens: new Set([TOKEN_VALIDO]), seq: 0, renovacoes: 0,
  containers: {}, midias: {}, seguidores: 100, falharMedia: 0, limite: false, limitePorErro: false, imagensBaixadas: []
};
function responder(res, status, corpo) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corpo)); }
const erroGraph = (res, message, code, sub) => responder(res, 400, { error: { message, type: 'OAuthException', code, error_subcode: sub, fbtrace_id: 'x' } });

const servidorGraph = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', c => { corpo += c; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const p = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') Object.assign(p, Object.fromEntries(new URLSearchParams(corpo)));
    const caminho = url.pathname.replace(/^\/v23\.0/, '');
    const token = p.access_token;
    delete p.access_token;
    fake.chamadas.push({ metodo: req.method, caminho, params: p, versao: url.pathname.startsWith('/v23.0') });
    if (!fake.tokens.has(token)) return erroGraph(res, 'Invalid OAuth access token - Cannot parse access token', 190);

    if (caminho === '/refresh_access_token') {
      const novo = `IGAArenovado${++fake.renovacoes}` + 'Y'.repeat(40);
      fake.tokens.add(novo);
      return responder(res, 200, { access_token: novo, token_type: 'bearer', expires_in: 5184000 });
    }
    if (caminho === '/me') {
      return responder(res, 200, { id: 'app-scoped-1', user_id: IG_USER, username: 'marsh_teste', account_type: 'BUSINESS', followers_count: fake.seguidores });
    }
    if (caminho === `/${IG_USER}/content_publishing_limit`) {
      return responder(res, 200, { data: [{ quota_usage: fake.limite ? 100 : 3, config: { quota_total: 100, quota_duration: 86400 } }] });
    }
    if (caminho === `/${IG_USER}/media` && req.method === 'POST') {
      if (fake.falharMedia > 0) { fake.falharMedia--; return erroGraph(res, 'Only photo or video can be accepted as media type (teste).', 9004, 2207052); }
      if (p.media_type === 'CAROUSEL') {
        const filhos = String(p.children || '').split(',');
        if (filhos.length < 2 || filhos.some(f => !fake.containers[f] || !fake.containers[f].item)) return erroGraph(res, 'children inválidos', 100);
        const id = `K${++fake.seq}`;
        fake.containers[id] = { tipo: 'CAROUSEL', filhos, legenda: p.caption, consultas: 0 };
        return responder(res, 200, { id });
      }
      // imagem: baixa pela URL assinada (como o Instagram faz) e confere que é JPEG
      try {
        const r = await fetch(p.image_url);
        const b = Buffer.from(await r.arrayBuffer());
        fake.imagensBaixadas.push({ ok: r.ok, jpeg: b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, url: p.image_url });
        if (!r.ok) return erroGraph(res, 'Media download has failed (teste).', 9004, 2207052);
      } catch { return erroGraph(res, 'Media download has failed (teste).', 9004, 2207052); }
      const item = p.is_carousel_item === 'true';
      const id = `${item ? 'C' : 'I'}${++fake.seq}`;
      fake.containers[id] = { tipo: 'IMAGE', item, legenda: p.caption, url: p.image_url, consultas: 0 };
      return responder(res, 200, { id });
    }
    if (caminho === `/${IG_USER}/media_publish` && req.method === 'POST') {
      const c = fake.containers[p.creation_id];
      if (!c || c.consultas < 2) return erroGraph(res, 'Media ID is not available', 9007, 2207027);
      if (fake.limitePorErro) return erroGraph(res, 'Application request limit reached (teste).', 9, 2207042);
      if (c.publicado) return erroGraph(res, 'Contêiner já publicado (teste).', 100);
      c.publicado = true;
      const id = `M${++fake.seq}`;
      fake.midias[id] = { container: p.creation_id, tipo: c.tipo };
      return responder(res, 200, { id });
    }
    const mIns = /^\/([A-Z]\d+)\/insights$/.exec(caminho);
    if (mIns) {
      if (!fake.midias[mIns[1]]) return erroGraph(res, 'mídia não existe', 100);
      const metricas = String(p.metric || '').split(',');
      if (metricas.includes('views')) return erroGraph(res, '(#100) The Media Insights API does not support the views metric for this media product type', 100);
      const valores = { reach: 250, likes: 31, comments: 4, saved: 7, shares: 3, total_interactions: 45 };
      return responder(res, 200, { data: metricas.map(m => ({ name: m, period: 'lifetime', values: [{ value: valores[m] }], title: m, id: `${mIns[1]}/insights/${m}/lifetime` })) });
    }
    const mObj = /^\/([A-Z]\d+)$/.exec(caminho);
    if (mObj && req.method === 'GET') {
      const id = mObj[1];
      if (fake.containers[id]) {
        const c = fake.containers[id];
        c.consultas++;
        return responder(res, 200, { status_code: c.consultas < 2 ? 'IN_PROGRESS' : (c.publicado ? 'PUBLISHED' : 'FINISHED'), id });
      }
      if (fake.midias[id]) return responder(res, 200, { permalink: `https://www.instagram.com/p/FAKE${id}/`, timestamp: new Date().toISOString().replace('Z', '+0000'), id });
    }
    erroGraph(res, `Rota falsa não implementada: ${req.method} ${caminho}`, 100);
  });
});

// ===================== helpers =====================
const tok = p => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokAdmin = tok({ id: 1, tipo: 'admin_empresa', empresa_id: 1 });
const tokTecnico = tok({ id: 1, tipo: 'tecnico', empresa_id: 1 });
const tokCliente = tok({ id: 999990, tipo: 'cliente', empresa_id: 1, cliente_id: 1 });

async function api(metodo, caminho, corpo, t = tokAdmin) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${t}`, ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined
  });
  const texto = await r.text();
  respostas.push(texto);
  let body = null; try { body = JSON.parse(texto); } catch { /* não JSON */ }
  return { status: r.status, body };
}
async function enviarImagens(postId, arquivos, t = tokAdmin) {
  const form = new FormData();
  for (const a of arquivos) form.append('imagens', new Blob([a.buffer], { type: a.tipo || 'image/png' }), a.nome);
  const r = await fetch(`${BASE}/marketing/posts/${postId}/midias`, { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: form });
  const texto = await r.text(); respostas.push(texto);
  return { status: r.status, body: JSON.parse(texto) };
}
const png = (w, h, cor = '#1d6fd8') => sharp({ create: { width: w, height: h, channels: 4, background: cor } }).png().toBuffer();
const futuro = dias => new Date(Date.now() + dias * 86400000).toISOString();
const vencer = id => pool.query(`UPDATE marketing_posts SET data_agendada = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
const chamadasDe = filtro => fake.chamadas.filter(filtro);
const perto = (data, minutos) => Math.abs(new Date(data) - Date.now() - minutos * 60000) < 2 * 60000;

(async () => {
  await new Promise((r, rej) => servidorGraph.listen(PORTA_GRAPH, r).on('error', rej));
  const criados = new Set();
  const contaAntes = (await pool.query('SELECT * FROM marketing_conta WHERE empresa_id = 1')).rows[0] || null;
  const seguidoresAntes = (await pool.query('SELECT data, seguidores FROM marketing_seguidores WHERE empresa_id = 1')).rows;
  const alertaAntes = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM alertas_sistema')).rows[0].m;
  const novoPost = async (titulo, extra = {}) => {
    const r = await api('POST', '/marketing/posts', { titulo: `TESTE MKT ${titulo}`, legenda: `Legenda de ${titulo} #SAP #IA`, ...extra });
    if (r.body && r.body.id) criados.add(r.body.id);
    return r;
  };

  try {
    // ---------- ambiente ----------
    let r = await api('GET', '/marketing/conta');
    ok(r.status === 200 && r.body.cifra_configurada && r.body.storage, `GET /conta: cifra e storage configurados no servidor (${r.status})`);
    if (!r.body || !r.body.cifra_configurada || !r.body.storage) { console.log('     Suba o servidor com as variáveis do topo deste arquivo.'); return; }

    // ---------- permissões ----------
    r = await api('GET', '/marketing/posts', undefined, tokTecnico);
    ok(r.status === 403, `técnico não acessa o marketing (${r.status})`);
    r = await api('GET', '/marketing/metricas', undefined, tokCliente);
    ok(r.status === 403, `cliente do portal não acessa o marketing (${r.status})`);
    r = await api('POST', '/marketing/conta', { token: TOKEN_VALIDO }, tokTecnico);
    ok(r.status === 403, `técnico não conecta a conta (${r.status})`);
    r = await fetch(`${BASE}/marketing/posts`);
    ok(r.status === 401, `sem login: 401 (${r.status})`);

    // ---------- conectar conta ----------
    r = await api('POST', '/marketing/conta', { token: 'IGAAtokeninvalido' + 'Z'.repeat(30) });
    ok(r.status === 400 && /recusou o token/.test(r.body.erro), `token inválido recusado: ${r.body && r.body.erro}`);
    if (!chamadasDe(c => c.caminho === '/me').length) { ok(false, 'o servidor não chamou o Graph falso: suba com INSTAGRAM_GRAPH_URL=' + process.env.INSTAGRAM_GRAPH_URL); return; }
    r = await api('POST', '/marketing/conta', { token: TOKEN_VALIDO });
    ok(r.status === 200 && r.body.username === 'marsh_teste' && r.body.seguidores === 100, `conta conectada: ${r.body && r.body.mensagem}`);
    let conta = (await pool.query('SELECT * FROM marketing_conta WHERE empresa_id = 1')).rows[0];
    ok(conta.ig_user_id === IG_USER && /^v1:/.test(conta.token_cifrado) && !conta.token_cifrado.includes('IGAA'),
      'token gravado cifrado (AES-256-GCM, formato v1:iv:tag:dados), sem o texto do token');
    ok(mk.decifrar(conta.token_cifrado) === 'IGAArenovado1' + 'Y'.repeat(40), 'ao conectar, o token foi renovado e a versão nova é a gravada');
    ok(perto(conta.token_expira_em, 60 * 24 * 60), `validade do token = 60 dias (${new Date(conta.token_expira_em).toISOString().slice(0, 10)})`);
    r = await api('GET', '/marketing/conta');
    ok(r.body.conectada && r.body.username === 'marsh_teste' && !('token' in r.body) && !('token_cifrado' in r.body), 'GET /conta mostra a conta sem token');
    r = await api('POST', '/marketing/conta/testar');
    ok(r.status === 200 && r.body.ok, `testar conexão: ${r.body && r.body.mensagem}`);

    // ---------- upload e validações ----------
    r = await novoPost('imagem');
    ok(r.status === 201 && r.body.status === 'rascunho' && r.body.data_agendada === null, 'cria rascunho sem data');
    const postA = r.body.id;
    r = await enviarImagens(postA, [{ nome: 'Arte Final.png', buffer: await png(1080, 1350) }]);
    ok(r.status === 201 && r.body.midias.length === 1 && r.body.midias[0].mime === 'image/jpeg' && r.body.midias[0].largura === 1080,
      `upload PNG 1080×1350 → JPEG (${r.body.midias && r.body.midias[0] && r.body.midias[0].tamanho_bytes} bytes)`);
    const key = (await pool.query('SELECT storage_key FROM marketing_midias WHERE post_id = $1', [postA])).rows[0].storage_key;
    ok(key === `marketing/${postA}/01-Arte_Final.jpg`, `key no storage: ${key}`);
    const baixada = Buffer.from(await (await fetch(r.body.midias[0].url)).arrayBuffer());
    const meta = await sharp(baixada).metadata();
    ok(meta.format === 'jpeg' && meta.space === 'srgb' && !meta.exif && !meta.icc, `arquivo no storage é JPEG sRGB sem metadados (${meta.width}×${meta.height})`);

    r = await enviarImagens(postA, [{ nome: 'story.png', buffer: await png(1080, 1920) }]);
    ok(r.status === 400 && /9:16/.test(r.body.erro), `proporção 9:16 recusada: ${r.body.erro}`);
    r = await enviarImagens(postA, [{ nome: 'panorama.png', buffer: await png(2000, 1000) }]);
    ok(r.status === 400 && /4:5/.test(r.body.erro), 'proporção 2:1 recusada');
    r = await enviarImagens(postA, [{ nome: 'texto.png', buffer: Buffer.from('não sou imagem'), tipo: 'image/png' }]);
    ok(r.status === 400 && /não é uma imagem/.test(r.body.erro), 'arquivo que não é imagem recusado');
    r = await enviarImagens(postA, [{ nome: 'quadrada.webp', buffer: await sharp(await png(1080, 1080)).webp().toBuffer(), tipo: 'image/webp' },
      { nome: 'paisagem.jpg', buffer: await sharp(await png(1080, 566)).jpeg().toBuffer(), tipo: 'image/jpeg' }]);
    ok(r.status === 201 && r.body.midias.length === 3 && r.body.tipo === 'carrossel', 'WebP 1:1 e JPEG 1,91:1 aceitos; 3 imagens = carrossel');
    const [m1, m2, m3] = r.body.midias.map(m => m.id);
    r = await api('PUT', `/marketing/posts/${postA}/midias/ordem`, { ids: [m3, m1, m2] });
    ok(r.status === 200 && r.body.midias.map(m => m.id).join() === [m3, m1, m2].join(), 'reordenar imagens');
    r = await api('DELETE', `/marketing/posts/${postA}/midias/${m3}`);
    r = await api('DELETE', `/marketing/posts/${postA}/midias/${m2}`);
    ok(r.status === 200 && r.body.midias.length === 1 && r.body.tipo === 'imagem' && r.body.midias[0].ordem === 1, 'remover imagens: volta a 1 imagem (tipo imagem)');

    r = await api('PUT', `/marketing/posts/${postA}`, { legenda: 'x'.repeat(2201) });
    ok(r.status === 400 && /2200/.test(r.body.erro), 'legenda com mais de 2.200 caracteres recusada');
    r = await api('PUT', `/marketing/posts/${postA}`, { legenda: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ') });
    ok(r.status === 400 && /31 hashtags/.test(r.body.erro), 'legenda com 31 hashtags recusada');

    // ---------- agendar / editar / cancelar / duplicar ----------
    r = await api('PUT', `/marketing/posts/${postA}`, { status: 'agendado' });
    ok(r.status === 400 && /data/.test(r.body.erro), 'agendar sem data: 400');
    r = await api('PUT', `/marketing/posts/${postA}`, { status: 'agendado', data_agendada: new Date(Date.now() - 3600000).toISOString() });
    ok(r.status === 400 && /passou/.test(r.body.erro), 'agendar no passado: 400');
    r = await api('PUT', `/marketing/posts/${postA}`, { status: 'agendado', data_agendada: '2030-01-15T12:30' });
    ok(r.status === 200 && r.body.status === 'agendado' && new Date(r.body.data_agendada).toISOString() === '2030-01-15T15:30:00.000Z',
      'agendado; data sem fuso entende horário de Brasília (12:30 → 15:30 UTC)');
    r = await api('PUT', `/marketing/posts/${postA}`, { legenda: 'Legenda editada #SAP' });
    ok(r.status === 200 && r.body.status === 'agendado' && r.body.legenda === 'Legenda editada #SAP' && r.body.hashtags === 1, 'editar mantém agendado');
    r = await api('POST', `/marketing/posts/${postA}/cancelar`);
    ok(r.status === 200 && r.body.status === 'cancelado', 'cancelar');
    r = await api('PUT', `/marketing/posts/${postA}`, { status: 'agendado', data_agendada: futuro(3) });
    ok(r.status === 200 && r.body.status === 'agendado' && r.body.tentativas === 0, 'reagendar post cancelado');
    r = await api('POST', `/marketing/posts/${postA}/duplicar`);
    ok(r.status === 201 && r.body.status === 'rascunho' && r.body.data_agendada === null && r.body.midias.length === 1 && /\(cópia\)$/.test(r.body.titulo),
      'duplicar: rascunho sem data com cópia da imagem');
    const dup = r.body.id; criados.add(dup);
    const keyDup = (await pool.query('SELECT storage_key FROM marketing_midias WHERE post_id = $1', [dup])).rows[0].storage_key;
    ok(keyDup.startsWith(`marketing/${dup}/`) && (await fetch(r.body.midias[0].url)).ok, `imagem copiada no storage (${keyDup})`);
    r = await api('DELETE', `/marketing/posts/${dup}`);
    ok(r.status === 200 && !(await pool.query('SELECT 1 FROM marketing_midias WHERE post_id = $1', [dup])).rows.length, 'excluir o rascunho duplicado');
    ok(!(await fetch(await storage.getDownloadUrl(keyDup))).ok, 'arquivo do duplicado removido do storage');
    r = await api('DELETE', `/marketing/posts/${postA}`);
    ok(r.status === 409, 'post agendado não é excluído (cancele antes)');

    // ---------- importar agenda ----------
    const agenda = { posts: [
      { titulo: 'TESTE MKT importado carrossel', data: futuro(10).replace('Z', '+00:00'), imagens: ['imp-1.png', 'imp-2.png'], legenda: 'Carrossel importado\n\n#SAP #IA' },
      { titulo: 'TESTE MKT importado passado', data: '2020-01-01T12:30:00-03:00', imagens: ['imp-3.png'], legenda: 'Antigo #SAP' }
    ] };
    const formAgenda = async (arquivos) => {
      const f = new FormData();
      f.append('agenda', JSON.stringify(agenda));
      for (const [nome, cor] of arquivos) f.append('imagens', new Blob([await png(1080, 1350, cor)], { type: 'image/png' }), nome);
      const resp = await fetch(`${BASE}/marketing/importar`, { method: 'POST', headers: { Authorization: `Bearer ${tokAdmin}` }, body: f });
      const texto = await resp.text(); respostas.push(texto);
      return { status: resp.status, body: JSON.parse(texto) };
    };
    const antesImport = (await pool.query(`SELECT COUNT(*)::int AS n FROM marketing_posts WHERE titulo LIKE 'TESTE MKT importado%'`)).rows[0].n;
    r = await formAgenda([['imp-1.png', '#ff0000'], ['imp-2.png', '#00ff00']]);
    const depoisFalha = (await pool.query(`SELECT COUNT(*)::int AS n FROM marketing_posts WHERE titulo LIKE 'TESTE MKT importado%'`)).rows[0].n;
    ok(r.status === 400 && r.body.erros.some(e => /imp-3\.png não enviada/.test(e)) && depoisFalha === antesImport, `imagem faltando: 400 e nada criado (${r.body.erros && r.body.erros[0]})`);
    r = await formAgenda([['imp-1.png', '#ff0000'], ['imp-2.png', '#00ff00'], ['imp-3.png', '#0000ff']]);
    (r.body.criados || []).forEach(c => criados.add(c.id));
    ok(r.status === 201 && r.body.criados.length === 2 && r.body.criados[0].status === 'agendado' && r.body.criados[1].status === 'rascunho',
      `importar: ${r.body.mensagem}`);
    const imp = r.body.criados && r.body.criados[0] ? (await api('GET', `/marketing/posts/${r.body.criados[0].id}`)).body : null;
    ok(imp && imp.tipo === 'carrossel' && imp.midias.length === 2 && imp.legenda === 'Carrossel importado\n\n#SAP #IA', 'post importado: carrossel com 2 imagens e legenda completa');
    r = await formAgenda([['imp-1.png', '#ff0000'], ['imp-2.png', '#00ff00'], ['imp-3.png', '#0000ff']]);
    ok(r.status === 201 && r.body.criados.length === 0 && r.body.ignorados.length === 2, 'importar de novo não duplica (2 ignorados)');
    const de = new Date(Date.now() + 10 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    r = await api('GET', `/marketing/posts?de=${de}&ate=${de}&status=agendado`);
    ok(r.status === 200 && r.body.some(p => p.id === imp.id && p.capa_url && p.n_midias === 2 && p.dia === de), 'calendário do dia lista o post com miniatura');
    r = await api('GET', '/marketing/posts?de=2020-01-01&ate=2020-01-31&sem_data=1');
    ok(r.status === 200 && r.body.some(p => p.titulo === 'TESTE MKT importado passado'), 'filtro por período + rascunhos sem data');

    // ---------- publicar imagem (rotina) e não publicar duas vezes ----------
    fake.chamadas = [];
    await pool.query(`UPDATE marketing_posts SET status = 'agendado', data_agendada = NOW() + INTERVAL '1 day' WHERE id = $1`, [postA]);
    await vencer(postA);
    const [x1, x2] = await Promise.all([jobs.publicarPendentes(), jobs.publicarPendentes()]);
    const pubA = (await api('GET', `/marketing/posts/${postA}`)).body;
    ok(pubA.status === 'publicado' && /^M\d+$/.test(pubA.ig_media_id) && /instagram\.com\/p\/FAKE/.test(pubA.permalink) && pubA.data_publicacao,
      `imagem publicada (${pubA.ig_media_id}, ${pubA.permalink})`);
    const seqA = fake.chamadas.map(c => `${c.metodo} ${c.caminho.replace(/\/[A-Z]\d+$/, '/{id}')}`);
    ok(JSON.stringify(seqA) === JSON.stringify([`GET /${IG_USER}/content_publishing_limit`, `POST /${IG_USER}/media`, 'GET /{id}', 'GET /{id}',
      `POST /${IG_USER}/media_publish`, 'GET /{id}']), `sequência certa no Graph: ${seqA.join(' → ')}`);
    const criacao = fake.chamadas.find(c => c.caminho === `/${IG_USER}/media`);
    ok(criacao.params.caption === 'Legenda editada #SAP' && /X-Amz-Expires=3600/.test(criacao.params.image_url) && criacao.versao,
      'contêiner com legenda e image_url assinada de 1 h, na versão v23.0');
    ok(fake.imagensBaixadas.length && fake.imagensBaixadas.every(i => i.ok && i.jpeg), 'o "Instagram" baixou a imagem pela URL e é JPEG');
    ok(x1.length + x2.length === 1 && chamadasDe(c => c.caminho.endsWith('/media_publish')).length === 1, 'duas rotinas ao mesmo tempo: publicou uma vez só');
    await jobs.publicarPendentes();
    ok(chamadasDe(c => c.caminho.endsWith('/media_publish')).length === 1, 'rodar a rotina de novo não republica');
    r = await api('POST', `/marketing/posts/${postA}/publicar-agora`);
    ok(r.status === 409, 'publicar agora num post publicado: 409');
    r = await api('PUT', `/marketing/posts/${postA}`, { legenda: 'mudar' });
    ok(r.status === 409, 'post publicado é só leitura (409)');

    // ---------- publicar carrossel ----------
    r = await novoPost('carrossel');
    const postB = r.body.id;
    r = await enviarImagens(postB, [{ nome: 'c1.png', buffer: await png(1080, 1350, '#111111') }, { nome: 'c2.png', buffer: await png(1080, 1350, '#222222') },
      { nome: 'c3.png', buffer: await png(1080, 1350, '#333333') }]);
    const idsB = r.body.midias.map(m => m.id);
    await api('PUT', `/marketing/posts/${postB}/midias/ordem`, { ids: [idsB[2], idsB[0], idsB[1]] });
    await api('PUT', `/marketing/posts/${postB}`, { status: 'agendado', data_agendada: futuro(1) });
    await vencer(postB);
    fake.chamadas = [];
    await jobs.publicarPendentes();
    const pubB = (await api('GET', `/marketing/posts/${postB}`)).body;
    const seqB = fake.chamadas.map(c => `${c.metodo} ${c.caminho.replace(/\/[A-Z]\d+$/, '/{id}')}`);
    const itens = fake.chamadas.filter(c => c.params.is_carousel_item === 'true');
    const pai = fake.chamadas.find(c => c.params.media_type === 'CAROUSEL');
    ok(pubB.status === 'publicado' && pubB.tipo === 'carrossel', `carrossel publicado (${pubB.ig_media_id})`);
    ok(itens.length === 3 && pai && pai.params.caption === pubB.legenda && !itens.some(i => i.params.caption) &&
      seqB.indexOf(`POST /${IG_USER}/media_publish`) > seqB.lastIndexOf(`POST /${IG_USER}/media`),
      `sequência do carrossel: 3 itens (is_carousel_item) → CAROUSEL com legenda → status → publish`);
    const filhosIds = pai.params.children.split(',');
    const ordemUrls = filhosIds.map(id => decodeURIComponent(fake.containers[id].url.split('?')[0].split('/').pop()));
    ok(ordemUrls.join() === ['03-c3.jpg', '01-c1.jpg', '02-c2.jpg'].join(), `children na ordem do editor: ${ordemUrls.join(', ')}`);

    // ---------- erro → retentativa → erro final + alerta ----------
    r = await novoPost('com erro');
    const postC = r.body.id;
    await enviarImagens(postC, [{ nome: 'e.png', buffer: await png(1080, 1350) }]);
    await api('PUT', `/marketing/posts/${postC}`, { status: 'agendado', data_agendada: futuro(1) });
    fake.falharMedia = 99;
    await vencer(postC); await jobs.publicarPendentes();
    let c = (await api('GET', `/marketing/posts/${postC}`)).body;
    ok(c.status === 'agendado' && c.tentativas === 1 && /photo or video/.test(c.ultimo_erro) && perto(c.data_agendada, 5),
      `1ª falha: volta a agendado em 5 min (${c.ultimo_erro})`);
    await vencer(postC); await jobs.publicarPendentes();
    c = (await api('GET', `/marketing/posts/${postC}`)).body;
    ok(c.status === 'agendado' && c.tentativas === 2 && perto(c.data_agendada, 15), '2ª falha: nova tentativa em 15 min (espera crescente)');
    await vencer(postC); await jobs.publicarPendentes();
    c = (await api('GET', `/marketing/posts/${postC}`)).body;
    const alertaC = (await pool.query(`SELECT titulo, detalhe FROM alertas_sistema WHERE chave = $1 AND NOT lido`, [`marketing:post:${postC}`])).rows[0];
    ok(c.status === 'erro' && c.tentativas === 3 && /3 tentativas/.test(c.ultimo_erro), `3ª falha: status erro (${c.ultimo_erro})`);
    ok(alertaC && /não publicado/.test(alertaC.titulo), `alerta no sistema: ${alertaC && alertaC.titulo}`);
    fake.falharMedia = 0;
    r = await api('PUT', `/marketing/posts/${postC}`, { status: 'agendado', data_agendada: futuro(1) });
    ok(r.status === 200 && r.body.tentativas === 0 && !r.body.ultimo_erro, 'reagendar post com erro zera as tentativas');
    await pool.query(`UPDATE marketing_posts SET status = 'cancelado' WHERE id = $1`, [postC]);

    // ---------- limite → reagenda sem contar tentativa ----------
    r = await novoPost('limite');
    const postD = r.body.id;
    await enviarImagens(postD, [{ nome: 'l.png', buffer: await png(1080, 1350) }]);
    await api('PUT', `/marketing/posts/${postD}`, { status: 'agendado', data_agendada: futuro(1) });
    fake.limite = true; fake.chamadas = [];
    await vencer(postD); await jobs.publicarPendentes();
    let d = (await api('GET', `/marketing/posts/${postD}`)).body;
    ok(d.status === 'agendado' && d.tentativas === 0 && perto(d.data_agendada, 60) && /Limite/.test(d.ultimo_erro) &&
      !chamadasDe(x => x.caminho.endsWith('/media')).length, `cota de 24 h cheia: reagendado +1 h sem tentativa (${d.ultimo_erro})`);
    fake.limite = false; fake.limitePorErro = true;
    await vencer(postD); await jobs.publicarPendentes();
    d = (await api('GET', `/marketing/posts/${postD}`)).body;
    ok(d.status === 'agendado' && d.tentativas === 0 && perto(d.data_agendada, 60), 'erro de limite no publish (subcódigo 2207042): reagendado +1 h');
    fake.limitePorErro = false;

    // ---------- publicar agora (pela rota, no servidor) ----------
    await vencer(postD);
    await pool.query(`UPDATE marketing_posts SET status = 'rascunho' WHERE id = $1`, [postD]);
    r = await api('POST', `/marketing/posts/${postD}/publicar-agora`);
    ok(r.status === 200 && r.body.post.status === 'publicado' && r.body.post.permalink, `publicar agora pela tela: ${r.body.mensagem || r.body.erro}`);

    // ---------- post travado em "publicando" ----------
    r = await novoPost('travado');
    await pool.query(`UPDATE marketing_posts SET status = 'publicando', data_atualizacao = NOW() - INTERVAL '20 minutes' WHERE id = $1`, [r.body.id]);
    await jobs.liberarTravados();
    ok((await api('GET', `/marketing/posts/${r.body.id}`)).body.status === 'erro', 'post parado em "publicando" há 20 min vira erro (não republica sozinho)');

    // ---------- rotina diária: seguidores, métricas e renovação do token ----------
    await pool.query(`INSERT INTO marketing_seguidores (empresa_id, data, seguidores) VALUES (1, (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 7, 120)
                      ON CONFLICT (empresa_id, data) DO UPDATE SET seguidores = 120`);
    fake.seguidores = 150; fake.chamadas = [];
    let resumo = await jobs.rotinaDiaria();
    ok(resumo.length === 1 && resumo[0].seguidores === 150 && resumo[0].metricas >= 3 && !resumo[0].token_renovado && !resumo[0].erro,
      `rotina diária: ${JSON.stringify(resumo[0])}`);
    ok(!chamadasDe(x => x.caminho === '/refresh_access_token').length, 'token com 60 dias: não renova');
    const segHoje = (await pool.query(`SELECT seguidores FROM marketing_seguidores WHERE empresa_id = 1 AND data = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`)).rows[0];
    ok(segHoje && segHoje.seguidores === 150, 'seguidores do dia gravados no histórico');
    const met = (await pool.query('SELECT * FROM marketing_metricas WHERE post_id = $1', [postA])).rows[0];
    ok(met && met.alcance === 250 && met.curtidas === 31 && met.comentarios === 4 && met.salvamentos === 7 && met.compartilhamentos === 3 &&
      met.interacoes === 45 && met.visualizacoes === null, 'métricas gravadas; "views" indisponível vira null sem quebrar');
    ok(chamadasDe(x => /insights$/.test(x.caminho) && !x.params.metric.includes(',')).length >= 7, 'combinada falhou: pediu as métricas uma a uma');
    r = await api('GET', '/marketing/metricas');
    ok(r.status === 200 && r.body.seguidores === 150 && r.body.variacao_7d === 30 && r.body.publicados_mes >= 3 &&
      r.body.alcance_30d >= 750 && r.body.posts.some(p => p.id === postA && p.alcance === 250 && p.capa_url) && r.body.historico_seguidores.length >= 2,
      `GET /metricas: ${r.body.seguidores} seguidores (+${r.body.variacao_7d} em 7 dias), ${r.body.publicados_mes} no mês, alcance ${r.body.alcance_30d}`);

    await pool.query(`UPDATE marketing_conta SET token_expira_em = NOW() + INTERVAL '5 days' WHERE empresa_id = 1`);
    fake.chamadas = [];
    resumo = await jobs.rotinaDiaria();
    conta = (await pool.query('SELECT * FROM marketing_conta WHERE empresa_id = 1')).rows[0];
    ok(resumo[0].token_renovado && perto(conta.token_expira_em, 60 * 24 * 60) && mk.decifrar(conta.token_cifrado) === `IGAArenovado${fake.renovacoes}` + 'Y'.repeat(40),
      'token a 5 dias de vencer: renovado (60 dias) e regravado cifrado');
    const ref = chamadasDe(x => x.caminho === '/refresh_access_token')[0];
    ok(ref && !ref.versao && ref.params.grant_type === 'ig_refresh_token', 'refresh_access_token sem versão, grant_type=ig_refresh_token');

    // token revogado: alerta e erro legível
    fake.tokens.clear();
    resumo = await jobs.rotinaDiaria();
    const alertaTok = (await pool.query(`SELECT titulo FROM alertas_sistema WHERE chave IN ('marketing:diaria', 'marketing:token') AND NOT lido AND id > $1`, [alertaAntes])).rows;
    ok(resumo[0].erro && /Invalid OAuth/.test(resumo[0].erro) && alertaTok.length, `token revogado: rotina avisa (${alertaTok.map(a => a.titulo).join('; ')})`);
    r = await api('POST', '/marketing/conta/testar');
    ok(r.status === 422 && /Invalid OAuth/.test(r.body.erro), 'testar conexão com token revogado: mensagem do Instagram');

    // ---------- o token nunca sai nas respostas ----------
    const vazou = respostas.some(t => t.includes(TOKEN_VALIDO) || /IGAArenovado/.test(t) || /token_cifrado|v1:[A-Za-z0-9+/=]{10,}:/.test(t));
    ok(!vazou, `nenhuma das ${respostas.length} respostas da API traz o token (nem cifrado)`);
  } catch (e) {
    ok(false, 'erro inesperado: ' + (e.stack || e.message));
  } finally {
    // limpeza: posts do teste (e imagens no storage), conta e histórico de seguidores como estavam, alertas novos
    const ids = (await pool.query(`SELECT id FROM marketing_posts WHERE titulo LIKE 'TESTE MKT%' OR id = ANY($1)`, [[...criados]])).rows.map(x => x.id);
    const keys = (await pool.query('SELECT storage_key FROM marketing_midias WHERE post_id = ANY($1)', [ids])).rows.map(x => x.storage_key);
    await pool.query('DELETE FROM marketing_posts WHERE id = ANY($1)', [ids]);
    await mk.removerArquivos(keys);
    await pool.query('DELETE FROM marketing_conta WHERE empresa_id = 1');
    if (contaAntes) {
      const cols = Object.keys(contaAntes);
      await pool.query(`INSERT INTO marketing_conta (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map(k => contaAntes[k]));
    }
    await pool.query('DELETE FROM marketing_seguidores WHERE empresa_id = 1');
    for (const s of seguidoresAntes) await pool.query('INSERT INTO marketing_seguidores (empresa_id, data, seguidores) VALUES (1, $1, $2)', [s.data, s.seguidores]);
    await pool.query(`DELETE FROM alertas_sistema WHERE id > $1 AND (chave LIKE 'marketing:%' OR chave LIKE 'http:%marketing%')`, [alertaAntes]);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'} · ${ids.length} post(s) de teste e ${keys.length} imagem(ns) removidos`);
    await pool.end();
    servidorGraph.close();
    process.exit(falhas ? 1 : 0);
  }
})();
