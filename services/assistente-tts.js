// ============================================================================
// Serviço de TTS via ElevenLabs.
// Recebe texto → devolve Buffer de áudio MP3 (a rota faz o stream pro cliente).
//
// Configuração via env vars:
//   ELEVENLABS_API_KEY        (obrigatória)
//   ELEVENLABS_VOICE_ID       (default: George = JBFqnCBsd6RMkjVDRZzb)
//   ELEVENLABS_MODEL_ID       (default: eleven_multilingual_v2)
// ============================================================================

const API_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George — britânica masculina
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

function isConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

async function sintetizar(texto) {
  if (!isConfigured()) {
    throw new Error('ELEVENLABS_API_KEY não configurada no servidor.');
  }
  if (!texto || typeof texto !== 'string') {
    throw new Error('Texto inválido para síntese.');
  }
  // Cap defensivo pra evitar custos absurdos
  const textoFinal = texto.slice(0, 1500);

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;

  const res = await fetch(`${API_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: textoFinal,
      model_id: modelId,
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.75,
        style: 0.25,
        use_speaker_boost: true
      }
    })
  });

  if (!res.ok) {
    let detalhe = '';
    try { detalhe = await res.text(); } catch {}
    throw new Error(`ElevenLabs ${res.status}: ${detalhe.slice(0, 300)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { sintetizar, isConfigured };
