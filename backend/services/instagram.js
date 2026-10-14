// Instagram API with Instagram Login (graph.instagram.com): publicação de imagem/carrossel, métricas e token.
// Base e versão configuráveis para testar com um servidor falso local:
//   INSTAGRAM_GRAPH_URL   (padrão https://graph.instagram.com)
//   INSTAGRAM_API_VERSION (padrão v23.0)
// O token nunca aparece em mensagem de erro, log ou alerta.

const BASE = () => (process.env.INSTAGRAM_GRAPH_URL || 'https://graph.instagram.com').replace(/\/+$/, '');
const VERSAO = () => process.env.INSTAGRAM_API_VERSION || 'v23.0';
const TIMEOUT_MS = 30000;
// Espera entre consultas do status do contêiner (a API leva poucos segundos para processar a imagem)
const ESPERA_STATUS_MS = () => parseInt(process.env.MARKETING_STATUS_ESPERA_MS || '2000', 10);
const MAX_CONSULTAS_STATUS = 15;

// Métricas pedidas ao /insights de cada post (as indisponíveis voltam null)
const METRICAS = ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions', 'views'];

class ErroGraph extends Error {
  constructor(mensagem, { status, code, subcode, tipo } = {}) {
    super(mensagem);
    this.name = 'ErroGraph';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.tipo = tipo;
  }
  // Limite de publicação/requisições: reagendar sem contar tentativa
  get ehLimite() {
    // 4/17/32/613 = limite de chamadas; subcódigo 2207042 = limite de posts em 24 h
    return [4, 17, 32, 613].includes(this.code) || this.subcode === 2207042;
  }
  // Token inválido/expirado: não adianta tentar de novo até trocar o token
  get ehToken() { return this.code === 190; }
}

const espera = ms => new Promise(r => setTimeout(r, ms));

function semToken(texto, token) {
  let s = String(texto || '');
  if (token) s = s.split(token).join('***');
  return s.replace(/access_token=[^&\s"]+/g, 'access_token=***');
}

// Chamada genérica. caminho sem a versão (ex.: '/me'); semVersao = true para o refresh_access_token.
async function chamar(metodo, caminho, params, token, { semVersao = false } = {}) {
  const url = new URL(`${BASE()}${semVersao ? '' : '/' + VERSAO()}${caminho}`);
  const corpo = new URLSearchParams();
  const todos = { ...(params || {}), access_token: token };
  for (const [k, v] of Object.entries(todos)) {
    if (v === undefined || v === null) continue;
    if (metodo === 'GET') url.searchParams.set(k, String(v)); else corpo.set(k, String(v));
  }
  let res, dados;
  try {
    res = await fetch(url, {
      method: metodo,
      headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: metodo === 'GET' ? undefined : corpo,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const causa = err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    throw new ErroGraph(`Sem resposta da API do Instagram${causa}: ${semToken(err.message, token)}`, { status: 0 });
  }
  const texto = await res.text();
  try { dados = texto ? JSON.parse(texto) : {}; } catch { dados = null; }
  if (!res.ok || (dados && dados.error)) {
    const e = (dados && dados.error) || {};
    const msg = e.error_user_msg || e.message || `HTTP ${res.status}`;
    throw new ErroGraph(semToken(msg, token), { status: res.status, code: e.code, subcode: e.error_subcode, tipo: e.type });
  }
  if (!dados) throw new ErroGraph(`Resposta inválida da API do Instagram (HTTP ${res.status})`, { status: res.status });
  return dados;
}

// Dados da conta profissional ligada ao token. user_id = id usado na publicação (/{ig_user_id}/media).
async function minhaConta(token) {
  const d = await chamar('GET', '/me', { fields: 'user_id,username,account_type,followers_count' }, token);
  return {
    ig_user_id: String(d.user_id || d.id || ''),
    username: d.username || null,
    account_type: d.account_type || null,
    seguidores: d.followers_count != null ? Number(d.followers_count) : null
  };
}

// Renova o token de longa duração (precisa ter mais de 24 h e estar válido). Devolve { token, expira_em }.
async function renovarToken(token) {
  const d = await chamar('GET', '/refresh_access_token', { grant_type: 'ig_refresh_token' }, token, { semVersao: true });
  if (!d.access_token) throw new ErroGraph('Renovação do token não devolveu um token novo.');
  const segundos = Number(d.expires_in) || 60 * 86400;
  return { token: d.access_token, expira_em: new Date(Date.now() + segundos * 1000) };
}

// Cota de publicação das últimas 24 h. null quando a API não informa (segue sem checar).
async function limitePublicacao(igUserId, token) {
  try {
    const d = await chamar('GET', `/${igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' }, token);
    const item = (d.data || [])[0];
    if (!item) return null;
    return { usado: Number(item.quota_usage) || 0, total: item.config && item.config.quota_total != null ? Number(item.config.quota_total) : null };
  } catch (err) {
    if (err instanceof ErroGraph && (err.ehToken || err.ehLimite)) throw err;
    return null; // endpoint indisponível: não impede a publicação
  }
}

async function aguardarContainer(containerId, token) {
  let ultimo = null;
  for (let i = 0; i < MAX_CONSULTAS_STATUS; i++) {
    const d = await chamar('GET', `/${containerId}`, { fields: 'status_code,status' }, token);
    ultimo = d.status_code;
    if (ultimo === 'FINISHED' || ultimo === 'PUBLISHED') return;
    if (ultimo === 'ERROR' || ultimo === 'EXPIRED') {
      throw new ErroGraph(`O Instagram não conseguiu processar a mídia (${ultimo}${d.status ? ': ' + d.status : ''}).`);
    }
    await espera(ESPERA_STATUS_MS());
  }
  throw new ErroGraph(`A mídia não ficou pronta a tempo no Instagram (último status: ${ultimo || 'desconhecido'}).`);
}

// Publica. imagens = [url pública/assinada, ...] (1 = imagem única; 2 a 10 = carrossel).
// aoCriarContainer(id) é chamado assim que o contêiner principal existe (para gravar no post).
// Devolve { container_id, media_id, permalink, timestamp }.
async function publicar({ igUserId, token, imagens, legenda, aoCriarContainer }) {
  if (!imagens || !imagens.length) throw new ErroGraph('Post sem imagem.');
  if (imagens.length > 10) throw new ErroGraph('O carrossel aceita no máximo 10 imagens.');
  let containerId;
  if (imagens.length === 1) {
    const c = await chamar('POST', `/${igUserId}/media`, { image_url: imagens[0], caption: legenda || '' }, token);
    containerId = c.id;
  } else {
    const filhos = [];
    for (const url of imagens) {
      const f = await chamar('POST', `/${igUserId}/media`, { image_url: url, is_carousel_item: 'true' }, token);
      filhos.push(f.id);
    }
    const c = await chamar('POST', `/${igUserId}/media`,
      { media_type: 'CAROUSEL', children: filhos.join(','), caption: legenda || '' }, token);
    containerId = c.id;
  }
  if (!containerId) throw new ErroGraph('A API do Instagram não devolveu o contêiner da mídia.');
  if (aoCriarContainer) await aoCriarContainer(containerId);
  await aguardarContainer(containerId, token);
  const pub = await chamar('POST', `/${igUserId}/media_publish`, { creation_id: containerId }, token);
  const mediaId = pub.id;
  let permalink = null, timestamp = null;
  try {
    const info = await chamar('GET', `/${mediaId}`, { fields: 'permalink,timestamp' }, token);
    permalink = info.permalink || null;
    timestamp = info.timestamp || null;
  } catch { /* publicado; o link vem depois na rotina de métricas */ }
  return { container_id: containerId, media_id: mediaId, permalink, timestamp };
}

async function permalinkDaMidia(mediaId, token) {
  const d = await chamar('GET', `/${mediaId}`, { fields: 'permalink,timestamp' }, token);
  return { permalink: d.permalink || null, timestamp: d.timestamp || null };
}

// Lê o valor de uma métrica no formato do /insights (values[0].value ou total_value.value)
function valorMetrica(item) {
  if (!item) return null;
  if (item.total_value && item.total_value.value != null) return Number(item.total_value.value);
  if (Array.isArray(item.values) && item.values.length && item.values[0].value != null) return Number(item.values[0].value);
  return null;
}

// Métricas de um post. Se a chamada combinada falhar (alguma métrica não existe para o tipo de mídia),
// pede uma a uma e devolve null nas que a API recusar.
async function metricasDaMidia(mediaId, token) {
  const resultado = Object.fromEntries(METRICAS.map(m => [m, null]));
  const preencher = d => { for (const item of d.data || []) if (item.name in resultado) resultado[item.name] = valorMetrica(item); };
  try {
    preencher(await chamar('GET', `/${mediaId}/insights`, { metric: METRICAS.join(',') }, token));
    return resultado;
  } catch (err) {
    if (err instanceof ErroGraph && (err.ehToken || err.ehLimite)) throw err;
  }
  for (const m of METRICAS) {
    try { preencher(await chamar('GET', `/${mediaId}/insights`, { metric: m }, token)); }
    catch (err) { if (err instanceof ErroGraph && (err.ehToken || err.ehLimite)) throw err; }
  }
  return resultado;
}

module.exports = {
  ErroGraph, METRICAS, chamar, minhaConta, renovarToken, limitePublicacao, publicar,
  permalinkDaMidia, metricasDaMidia
};
