// ============================================================================
// Serviço de TTS via OpenAI (Audio API).
// Recebe texto → devolve Buffer de áudio MP3 (a rota faz o stream pro cliente).
//
// Configuração via env vars:
//   OPENAI_API_KEY            (obrigatória — mesma da LLM)
//   OPENAI_TTS_VOICE          (default: onyx)
//                             alloy | echo | fable | onyx | nova | shimmer
//                             onyx  = americana grave/autoritária (Jarvis vibe)
//                             fable = britânica masculina (mais Jarvis ainda)
//                             echo  = masculina americana clara
//   OPENAI_TTS_MODEL          (default: tts-1 — latência baixa)
//                             Alternativa: tts-1-hd (qualidade maior, ~3x latência)
// ============================================================================

const OpenAI = require('openai');

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

  const voice = process.env.OPENAI_TTS_VOICE || 'onyx';
  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';

  const response = await oa.audio.speech.create({
    model,
    voice,
    input: textoFinal,
    response_format: 'mp3'
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { sintetizar, isConfigured };
