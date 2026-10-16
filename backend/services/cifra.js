// Cifra de segredos guardados no banco (AES-256-GCM).
// Chave: SISTEMA_CHAVE_CIFRA ou, se não houver, MARKETING_CHAVE_CIFRA (a mesma já usada no token do Instagram).
// 32 bytes em hex (64 caracteres) ou base64.
const crypto = require('crypto');

function chave() {
  const v = (process.env.SISTEMA_CHAVE_CIFRA || process.env.MARKETING_CHAVE_CIFRA || '').trim();
  if (!v) return null;
  let b = null;
  if (/^[0-9a-f]{64}$/i.test(v)) b = Buffer.from(v, 'hex');
  else { try { b = Buffer.from(v, 'base64'); } catch { b = null; } }
  return b && b.length === 32 ? b : null;
}

const configurada = () => !!chave();

function cifrar(texto) {
  const k = chave();
  if (!k) throw new Error('Chave de cifra não configurada (SISTEMA_CHAVE_CIFRA)');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(cifrado) {
  const k = chave();
  if (!k) throw new Error('Chave de cifra não configurada (SISTEMA_CHAVE_CIFRA)');
  const [versao, iv, tag, dados] = String(cifrado || '').split(':');
  if (versao !== 'v1' || !iv || !tag || !dados) throw new Error('Segredo gravado em formato desconhecido');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
}

module.exports = { configurada, cifrar, decifrar };
