// Marketing (Instagram): conta conectada com token cifrado, imagens do post, publicação, métricas e seguidores.
// A rotina periódica (marketing-jobs.js) e as rotas (/api/marketing) usam estas funções.
//
// Token: AES-256-GCM com a chave da env MARKETING_CHAVE_CIFRA (32 bytes em hex ou base64).
// Sem a chave a conta não é configurada e nada é publicado. O token nunca sai em rota, log ou alerta.
const crypto = require('crypto');
const pool = require('../db');
const storage = require('./storage');
const ig = require('./instagram');
const { registrarAlerta } = require('./alertas');

const FUSO = 'America/Sao_Paulo';
const MAX_TENTATIVAS = 3;
const ESPERAS_RETENTATIVA_MIN = [5, 15];   // depois da 1ª e da 2ª falha (espera crescente)
const REAGENDAR_LIMITE_MIN = 60;           // limite de publicação atingido: +1 h, sem contar tentativa
const RENOVAR_TOKEN_DIAS = 10;             // renova o token quando faltar menos que isso
const TTL_URL_INSTAGRAM = 3600;            // o Instagram busca a imagem pela URL assinada (1 h)
const TTL_URL_PAINEL = 3600;               // miniaturas no painel

const LEGENDA_MAX = 2200;
const HASHTAGS_MAX = 30;
const IMAGENS_MAX = 10;
const IMAGEM_MAX_BYTES = 8 * 1024 * 1024;
const PROPORCAO_MIN = 4 / 5;               // retrato 4:5 (padrão Marsh 1080×1350)
const PROPORCAO_MAX = 1.91;                // paisagem 1,91:1
const LARGURA_MAX = 1440;                  // o Instagram exibe até 1440 px; acima disso só pesa

class ErroValidacao extends Error {}

// ===== Cifra do token =====
function chaveCifra() {
  const v = (process.env.MARKETING_CHAVE_CIFRA || '').trim();
  if (!v) return null;
  let b = null;
  if (/^[0-9a-f]{64}$/i.test(v)) b = Buffer.from(v, 'hex');
  else { try { b = Buffer.from(v, 'base64'); } catch { b = null; } }
  return b && b.length === 32 ? b : null;
}
const cifraConfigurada = () => !!chaveCifra();

function cifrar(texto) {
  const chave = chaveCifra();
  if (!chave) throw new Error('MARKETING_CHAVE_CIFRA não configurada');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(cifrado) {
  const chave = chaveCifra();
  if (!chave) throw new Error('MARKETING_CHAVE_CIFRA não configurada');
  const [versao, iv, tag, dados] = String(cifrado || '').split(':');
  if (versao !== 'v1' || !iv || !tag || !dados) throw new Error('Token gravado em formato desconhecido');
  const d = crypto.createDecipheriv('aes-256-gcm', chave, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
}

// ===== Conta =====
// Dados públicos da conta (sem token)
async function dadosConta(empresaId) {
  const r = await pool.query(
    `SELECT canal, ig_user_id, username, token_expira_em, seguidores, atualizado_em,
            (token_cifrado IS NOT NULL) AS conectada
     FROM marketing_conta WHERE empresa_id = $1`, [empresaId]);
  return r.rows[0] || null;
}

// Conta com o token em texto (uso interno: publicação, métricas, renovação)
async function contaComToken(empresaId) {
  const r = await pool.query('SELECT * FROM marketing_conta WHERE empresa_id = $1 AND token_cifrado IS NOT NULL', [empresaId]);
  const c = r.rows[0];
  if (!c) return null;
  return { ...c, token: decifrar(c.token_cifrado) };
}

async function gravarConta(empresaId, { ig_user_id, username, seguidores, token, expira_em }) {
  await pool.query(
    `INSERT INTO marketing_conta (empresa_id, canal, ig_user_id, username, token_cifrado, token_expira_em, seguidores, atualizado_em)
     VALUES ($1, 'instagram', $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (empresa_id) DO UPDATE SET canal = 'instagram', ig_user_id = EXCLUDED.ig_user_id,
       username = EXCLUDED.username, token_cifrado = EXCLUDED.token_cifrado, token_expira_em = EXCLUDED.token_expira_em,
       seguidores = COALESCE(EXCLUDED.seguidores, marketing_conta.seguidores), atualizado_em = NOW()`,
    [empresaId, ig_user_id, username, cifrar(token), expira_em, seguidores]);
  if (seguidores != null) await registrarSeguidores(empresaId, seguidores);
}

// Conecta (ou troca) a conta: valida o token no /me, tenta renová-lo para saber a validade exata
// (token com menos de 24 h não renova: aí a validade estimada é de 60 dias) e grava cifrado.
async function conectarConta(empresaId, tokenInformado) {
  const token = String(tokenInformado || '').trim();
  if (token.length < 20 || /\s/.test(token)) throw new ErroValidacao('Cole o token de acesso de longa duração (sem espaços).');
  const conta = await ig.minhaConta(token);
  if (!conta.ig_user_id) throw new ErroValidacao('O token não devolveu o id da conta do Instagram.');
  if (conta.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(conta.account_type)) {
    throw new ErroValidacao(`A conta @${conta.username} não é Profissional (tipo ${conta.account_type}). Mude para conta Profissional no app do Instagram.`);
  }
  let tokenFinal = token, expira = new Date(Date.now() + 60 * 86400000);
  try { const n = await ig.renovarToken(token); tokenFinal = n.token; expira = n.expira_em; } catch { /* token novo: fica a estimativa */ }
  await gravarConta(empresaId, { ...conta, token: tokenFinal, expira_em: expira });
  return dadosConta(empresaId);
}

// ===== Seguidores =====
async function registrarSeguidores(empresaId, seguidores) {
  await pool.query(
    `INSERT INTO marketing_seguidores (empresa_id, data, seguidores)
     VALUES ($1, (NOW() AT TIME ZONE '${FUSO}')::date, $2)
     ON CONFLICT (empresa_id, data) DO UPDATE SET seguidores = EXCLUDED.seguidores`, [empresaId, seguidores]);
  await pool.query('UPDATE marketing_conta SET seguidores = $2, atualizado_em = NOW() WHERE empresa_id = $1', [empresaId, seguidores]);
}

// ===== Legenda e imagens =====
const contarHashtags = texto => (String(texto || '').match(/#[\p{L}\p{N}_]+/gu) || []).length;

function validarLegenda(legenda) {
  const s = String(legenda || '');
  if (s.length > LEGENDA_MAX) return `A legenda tem ${s.length} caracteres: o Instagram aceita até ${LEGENDA_MAX}.`;
  const n = contarHashtags(s);
  if (n > HASHTAGS_MAX) return `A legenda tem ${n} hashtags: o Instagram aceita até ${HASHTAGS_MAX}.`;
  return null;
}

const proporcaoTexto = (w, h) => {
  const r = w / h;
  const conhecidas = [[1, 1, '1:1'], [4, 5, '4:5'], [9, 16, '9:16'], [16, 9, '16:9'], [3, 4, '3:4'], [4, 3, '4:3'], [2, 3, '2:3'], [3, 2, '3:2']];
  const k = conhecidas.find(([a, b]) => Math.abs(r - a / b) < 0.01);
  return k ? k[2] : `${r.toFixed(2).replace('.', ',')}:1`;
};

// Converte PNG/JPEG/WebP para JPEG sRGB (qualidade 90, sem metadados), valida a proporção aceita pelo Instagram.
async function processarImagem(buffer, nome = 'imagem') {
  const sharp = require('sharp');
  let meta;
  try { meta = await sharp(buffer).metadata(); }
  catch { throw new ErroValidacao(`${nome}: não é uma imagem válida (use PNG, JPEG ou WebP).`); }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) {
    throw new ErroValidacao(`${nome}: formato ${meta.format || 'desconhecido'} não aceito (use PNG, JPEG ou WebP).`);
  }
  let w = meta.width, h = meta.height;
  if (meta.orientation >= 5) [w, h] = [h, w]; // foto girada pelo EXIF
  const r = w / h;
  if (r < PROPORCAO_MIN - 0.005 || r > PROPORCAO_MAX + 0.005) {
    throw new ErroValidacao(`${nome}: proporção ${proporcaoTexto(w, h)} (${w}×${h}) fora do aceito pelo Instagram, ` +
      'que vai de 4:5 (retrato) a 1,91:1 (paisagem). O padrão Marsh é 1080×1350.');
  }
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: LARGURA_MAX, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  if (data.length > IMAGEM_MAX_BYTES) throw new ErroValidacao(`${nome}: depois de convertida passa de 8 MB.`);
  return { buffer: data, largura: info.width, altura: info.height, tamanho: data.length };
}

const nomeJpg = nome => storage.sanitizarNome(String(nome || 'imagem').replace(/\.[^.]+$/, '')).slice(0, 80) + '.jpg';

// Grava as imagens já convertidas no fim do post: marketing/<post_id>/<nn>-<nome>.jpg
async function adicionarMidias(postId, imagens) {
  const atuais = (await pool.query('SELECT storage_key, ordem FROM marketing_midias WHERE post_id = $1', [postId])).rows;
  let nn = Math.max(0, ...atuais.map(m => parseInt((m.storage_key.split('/').pop() || '').split('-')[0], 10) || 0));
  let ordem = Math.max(0, ...atuais.map(m => m.ordem));
  const criadas = [];
  for (const img of imagens) {
    nn += 1; ordem += 1;
    const nome = nomeJpg(img.nome);
    const key = `marketing/${postId}/${String(nn).padStart(2, '0')}-${nome}`;
    await storage.uploadNaKey({ key, buffer: img.buffer, mimeType: 'image/jpeg' });
    const r = await pool.query(
      `INSERT INTO marketing_midias (post_id, ordem, storage_key, nome_arquivo, largura, altura, tamanho_bytes, mime)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'image/jpeg') RETURNING id`,
      [postId, ordem, key, nome, img.largura, img.altura, img.tamanho]);
    criadas.push(r.rows[0].id);
  }
  await atualizarTipo(postId);
  return criadas;
}

// 1 imagem = imagem; 2 ou mais = carrossel
async function atualizarTipo(postId) {
  await pool.query(
    `UPDATE marketing_posts SET tipo = CASE WHEN (SELECT COUNT(*) FROM marketing_midias WHERE post_id = $1) > 1
       THEN 'carrossel' ELSE 'imagem' END, data_atualizacao = NOW() WHERE id = $1`, [postId]);
}

async function removerArquivos(keys) {
  for (const k of keys) { try { await storage.remove(k); } catch { /* arquivo já não existe */ } }
}

async function midiasDoPost(postId, ttl = TTL_URL_PAINEL) {
  const r = await pool.query(
    `SELECT id, ordem, storage_key, nome_arquivo, largura, altura, tamanho_bytes, mime
     FROM marketing_midias WHERE post_id = $1 ORDER BY ordem, id`, [postId]);
  const lista = [];
  for (const m of r.rows) {
    let url = null;
    if (storage.disponivel) { try { url = await storage.getDownloadUrl(m.storage_key, null, ttl); } catch { url = null; } }
    const { storage_key, ...resto } = m;
    lista.push({ ...resto, url });
  }
  return lista;
}

// ===== Publicação =====
const minutosDepois = min => new Date(Date.now() + min * 60000);

async function marcarErroFinal(post, mensagem) {
  await pool.query(
    `UPDATE marketing_posts SET status = 'erro', ultimo_erro = $2, data_atualizacao = NOW() WHERE id = $1`,
    [post.id, mensagem]);
  await registrarAlerta({
    chave: `marketing:post:${post.id}`,
    titulo: `Instagram: post não publicado (${post.titulo || 'post #' + post.id})`,
    detalhe: `Post #${post.id}: ${mensagem}`
  });
}

// Publica um post já travado (status 'publicando'). Devolve o post atualizado.
async function executarPublicacao(post) {
  let conta;
  try { conta = await contaComToken(post.empresa_id); }
  catch (err) { await marcarErroFinal(post, `Não foi possível ler o token da conta: ${err.message}`); return carregarPost(post.id); }
  if (!conta) {
    await marcarErroFinal(post, 'Conta do Instagram não conectada (Marketing → Conta).');
    return carregarPost(post.id);
  }
  try {
    const limite = await ig.limitePublicacao(conta.ig_user_id, conta.token);
    if (limite && limite.total != null && limite.usado >= limite.total) {
      throw new ig.ErroGraph(`Limite de ${limite.total} publicações em 24 h atingido.`, { subcode: 2207042 });
    }
    if (!storage.disponivel) throw new Error('Storage (S3/R2) não configurado no servidor.');
    const midias = (await pool.query('SELECT storage_key FROM marketing_midias WHERE post_id = $1 ORDER BY ordem, id', [post.id])).rows;
    if (!midias.length) throw new ErroValidacao('Post sem imagem.');
    const imagens = [];
    for (const m of midias) imagens.push(await storage.getDownloadUrl(m.storage_key, null, TTL_URL_INSTAGRAM));

    const r = await ig.publicar({
      igUserId: conta.ig_user_id, token: conta.token, imagens, legenda: post.legenda || '',
      aoCriarContainer: id => pool.query('UPDATE marketing_posts SET ig_container_id = $2 WHERE id = $1', [post.id, id])
    });
    await pool.query(
      `UPDATE marketing_posts SET status = 'publicado', ig_container_id = $2, ig_media_id = $3, permalink = $4,
         data_publicacao = COALESCE($5::timestamptz, NOW()), ultimo_erro = NULL, data_atualizacao = NOW()
       WHERE id = $1`, [post.id, r.container_id, r.media_id, r.permalink, r.timestamp]);
  } catch (err) {
    const msg = err.message || String(err);
    if (err instanceof ig.ErroGraph && err.ehLimite) {
      await pool.query(
        `UPDATE marketing_posts SET status = 'agendado', data_agendada = $2, ultimo_erro = $3, data_atualizacao = NOW()
         WHERE id = $1`, [post.id, minutosDepois(REAGENDAR_LIMITE_MIN), `${msg} Reagendado para daqui a 1 hora.`]);
    } else if (err instanceof ErroValidacao) {
      await marcarErroFinal(post, msg);
    } else {
      const tentativas = (post.tentativas || 0) + 1;
      if (tentativas >= MAX_TENTATIVAS) {
        await pool.query('UPDATE marketing_posts SET tentativas = $2 WHERE id = $1', [post.id, tentativas]);
        await marcarErroFinal(post, `${msg} (${tentativas} tentativas)`);
      } else {
        const espera = ESPERAS_RETENTATIVA_MIN[tentativas - 1] || ESPERAS_RETENTATIVA_MIN[ESPERAS_RETENTATIVA_MIN.length - 1];
        await pool.query(
          `UPDATE marketing_posts SET status = 'agendado', tentativas = $2, data_agendada = $3, ultimo_erro = $4,
             data_atualizacao = NOW() WHERE id = $1`,
          [post.id, tentativas, minutosDepois(espera), `Tentativa ${tentativas} de ${MAX_TENTATIVAS}: ${msg} Nova tentativa em ${espera} min.`]);
      }
      if (err instanceof ig.ErroGraph && err.ehToken) {
        await registrarAlerta({ chave: 'marketing:token', titulo: 'Instagram: token inválido ou expirado',
          detalhe: `${msg} Gere um token novo em Marketing → Conta.` });
      }
    }
  }
  return carregarPost(post.id);
}

// Trava um post específico para publicar (só se ainda está agendado). null = outro processo já pegou.
async function travarPost(id) {
  const r = await pool.query(
    `UPDATE marketing_posts SET status = 'publicando', data_atualizacao = NOW()
     WHERE id = $1 AND status = 'agendado' RETURNING *`, [id]);
  return r.rows[0] || null;
}

// Rotina de 5 min: posts agendados vencidos. O UPDATE ... RETURNING trava cada post uma vez só,
// mesmo com duas instâncias do servidor rodando ao mesmo tempo.
async function publicarPendentes() {
  const r = await pool.query(
    `UPDATE marketing_posts SET status = 'publicando', data_atualizacao = NOW()
     WHERE id IN (SELECT id FROM marketing_posts WHERE status = 'agendado' AND data_agendada <= NOW()
                  ORDER BY data_agendada LIMIT 10 FOR UPDATE SKIP LOCKED)
       AND status = 'agendado'
     RETURNING *`);
  const resultados = [];
  for (const post of r.rows) resultados.push(await executarPublicacao(post));
  return resultados;
}

// Post parado em 'publicando' há mais de 15 min (servidor caiu no meio): não republica sozinho,
// porque pode ter saído no Instagram. Vira erro para o admin conferir.
async function liberarTravados() {
  const r = await pool.query(
    `SELECT * FROM marketing_posts WHERE status = 'publicando' AND data_atualizacao < NOW() - INTERVAL '15 minutes'`);
  for (const p of r.rows) {
    await marcarErroFinal(p, 'A publicação foi interrompida no meio. Confira no Instagram se o post saiu antes de agendar de novo.');
  }
  return r.rows.length;
}

// ===== Rotina diária: token, seguidores e métricas =====
async function renovarTokenSePreciso(empresaId) {
  const conta = await contaComToken(empresaId);
  if (!conta) return false;
  const faltaMs = conta.token_expira_em ? new Date(conta.token_expira_em) - Date.now() : 0;
  if (faltaMs > RENOVAR_TOKEN_DIAS * 86400000) return false;
  try {
    const n = await ig.renovarToken(conta.token);
    await pool.query(
      'UPDATE marketing_conta SET token_cifrado = $2, token_expira_em = $3, atualizado_em = NOW() WHERE empresa_id = $1',
      [empresaId, cifrar(n.token), n.expira_em]);
    return true;
  } catch (err) {
    await registrarAlerta({ chave: 'marketing:token', titulo: 'Instagram: não foi possível renovar o token',
      detalhe: `${err.message}. Vence em ${conta.token_expira_em ? new Date(conta.token_expira_em).toLocaleDateString('pt-BR', { timeZone: FUSO }) : '?'}: gere um token novo em Marketing → Conta.` });
    return false;
  }
}

async function atualizarSeguidores(empresaId) {
  const conta = await contaComToken(empresaId);
  if (!conta) return null;
  const d = await ig.minhaConta(conta.token);
  if (d.username && d.username !== conta.username) {
    await pool.query('UPDATE marketing_conta SET username = $2 WHERE empresa_id = $1', [empresaId, d.username]);
  }
  if (d.seguidores != null) await registrarSeguidores(empresaId, d.seguidores);
  return d.seguidores;
}

// Métricas dos posts publicados nos últimos 30 dias (uma linha por post por dia)
async function atualizarMetricas(empresaId) {
  const conta = await contaComToken(empresaId);
  if (!conta) return 0;
  const posts = (await pool.query(
    `SELECT id, ig_media_id, permalink FROM marketing_posts
     WHERE empresa_id = $1 AND status = 'publicado' AND ig_media_id IS NOT NULL
       AND data_publicacao >= NOW() - INTERVAL '30 days'
     ORDER BY data_publicacao DESC LIMIT 100`, [empresaId])).rows;
  let n = 0;
  for (const p of posts) {
    try {
      const m = await ig.metricasDaMidia(p.ig_media_id, conta.token);
      await pool.query(
        `INSERT INTO marketing_metricas (post_id, data, alcance, curtidas, comentarios, salvamentos, compartilhamentos, interacoes, visualizacoes)
         VALUES ($1, (NOW() AT TIME ZONE '${FUSO}')::date, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (post_id, data) DO UPDATE SET alcance = EXCLUDED.alcance, curtidas = EXCLUDED.curtidas,
           comentarios = EXCLUDED.comentarios, salvamentos = EXCLUDED.salvamentos,
           compartilhamentos = EXCLUDED.compartilhamentos, interacoes = EXCLUDED.interacoes,
           visualizacoes = EXCLUDED.visualizacoes`,
        [p.id, m.reach, m.likes, m.comments, m.saved, m.shares, m.total_interactions, m.views]);
      if (!p.permalink) {
        const info = await ig.permalinkDaMidia(p.ig_media_id, conta.token).catch(() => null);
        if (info && info.permalink) await pool.query('UPDATE marketing_posts SET permalink = $2 WHERE id = $1', [p.id, info.permalink]);
      }
      n++;
    } catch (err) {
      if (err instanceof ig.ErroGraph && (err.ehToken || err.ehLimite)) throw err;
      await registrarAlerta({ chave: 'marketing:metricas', nivel: 'aviso', titulo: 'Instagram: falha ao ler métricas de um post',
        detalhe: `post ${p.id}: ${err.message}` });
    }
  }
  return n;
}

async function rotinaDiaria() {
  const contas = (await pool.query('SELECT empresa_id FROM marketing_conta WHERE token_cifrado IS NOT NULL')).rows;
  const resumo = [];
  for (const { empresa_id } of contas) {
    const item = { empresa_id, token_renovado: false, seguidores: null, metricas: 0 };
    try {
      item.token_renovado = await renovarTokenSePreciso(empresa_id);
      item.seguidores = await atualizarSeguidores(empresa_id);
      item.metricas = await atualizarMetricas(empresa_id);
    } catch (err) {
      item.erro = err.message;
      await registrarAlerta({ chave: 'marketing:diaria', titulo: 'Instagram: rotina diária (seguidores/métricas) falhou',
        detalhe: `empresa ${empresa_id}: ${err.message}` });
    }
    resumo.push(item);
  }
  return resumo;
}

// ===== Leitura =====
async function carregarPost(id, empresaId) {
  const r = await pool.query(
    `SELECT id, empresa_id, canal, tipo, titulo, legenda, data_agendada, status, tentativas, ultimo_erro,
            ig_container_id, ig_media_id, permalink, data_publicacao, criado_por, data_criacao, data_atualizacao
     FROM marketing_posts WHERE id = $1 ${empresaId ? 'AND empresa_id = $2' : ''}`,
    empresaId ? [id, empresaId] : [id]);
  return r.rows[0] || null;
}

module.exports = {
  FUSO, LEGENDA_MAX, HASHTAGS_MAX, IMAGENS_MAX, IMAGEM_MAX_BYTES, MAX_TENTATIVAS,
  ErroValidacao, cifraConfigurada, cifrar, decifrar,
  dadosConta, contaComToken, conectarConta, registrarSeguidores,
  contarHashtags, validarLegenda, processarImagem, adicionarMidias, atualizarTipo, removerArquivos, midiasDoPost,
  travarPost, executarPublicacao, publicarPendentes, liberarTravados,
  renovarTokenSePreciso, atualizarSeguidores, atualizarMetricas, rotinaDiaria, carregarPost
};
