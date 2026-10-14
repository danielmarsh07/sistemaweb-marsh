// ============================================================================
// Serviço de TTS via OpenAI (Audio API) — voz da Ivy.
// Recebe texto → devolve Buffer de áudio MP3 (a rota faz o stream pro cliente).
// O toque "robótico" vem do jeito de falar (instruções) + um efeito aplicado no navegador.
//
// Configuração via env vars (as antigas OPENAI_TTS_VOICE/MODEL do JARVIS são ignoradas de propósito:
// no Render elas ainda apontavam para a voz masculina onyx):
//   OPENAI_API_KEY            (obrigatória — mesma da LLM)
//   IVY_TTS_VOICE             (default: nova — feminina)
//                             femininas: nova | shimmer | coral | sage
//                             masculinas: onyx | echo | fable | ash
//   IVY_TTS_MODEL             (default: gpt-4o-mini-tts — aceita instruções de estilo)
//                             tts-1 / tts-1-hd ignoram as instruções
//   IVY_TTS_INSTRUCTIONS      (opcional) estilo da fala; o padrão está em INSTRUCOES_PADRAO
// ============================================================================

const OpenAI = require('openai');

const INSTRUCOES_PADRAO = 'Você é Ivy, uma assistente virtual feminina com voz levemente sintética e robótica: '
  + 'timbre limpo e preciso, entonação contida e uniforme, ritmo constante, articulação clara de cada sílaba. '
  + 'Fale em português do Brasil, com calma e simpatia discreta.';

let _client = null;
function client() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

async function sintetizar(texto) {
  const oa = client();
  if (!oa) throw new Error('OPENAI_API_KEY não configurada no servidor.');
  if (!texto || typeof texto !== 'string') throw new Error('Texto inválido para síntese.');

  // Cap defensivo (mesmo limite do endpoint OpenAI = 4096 chars)
  const textoFinal = texto.slice(0, 1500);

  const voice = process.env.IVY_TTS_VOICE || 'nova';
  const model = process.env.IVY_TTS_MODEL || 'gpt-4o-mini-tts';

  const params = { model, voice, input: textoFinal, response_format: 'mp3' };
  // Só os modelos gpt-4o-* aceitam instruções; nos tts-1 a API recusaria o campo
  if (model.startsWith('gpt-4o')) params.instructions = process.env.IVY_TTS_INSTRUCTIONS || INSTRUCOES_PADRAO;

  let response;
  try {
    response = await oa.audio.speech.create(params);
  } catch (err) {
    // Chave sem acesso ao modelo novo: tenta o tts-1 com a mesma voz feminina
    // (sem isso o front cairia na voz do navegador, que pode ser masculina)
    if (model === 'tts-1' || ![400, 403, 404].includes(err && err.status)) throw err;
    console.warn(`[assistente-tts] ${model} recusado (${err.status}), usando tts-1:`, err.message);
    response = await oa.audio.speech.create({ model: 'tts-1', voice, input: textoFinal, response_format: 'mp3' });
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { sintetizar, isConfigured };
