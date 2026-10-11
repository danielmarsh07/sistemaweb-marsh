/**
 * licenca.js — chaves e assinatura das licenças do conector Claude <-> SAP.
 *
 * - Chave do cliente: MRSH-XXXX-XXXX-XXXX (mostrada uma única vez; no banco só o hash).
 * - Resposta de validação assinada com Ed25519. A chave privada fica na variável de
 *   ambiente LICENCA_CHAVE_PRIVADA (Render); a pública vai embutida no conector, que
 *   recusa qualquer licença adulterada. Gerar o par: node scripts/gerar-chaves-licenca.js
 */
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para não confundir
const VALIDADE_DIAS = 7; // quanto tempo o conector pode usar a licença sem falar com o servidor

const PLANOS = {
  leitura:         { nome: 'Leitura',         permite_escrita: false },
  desenvolvimento: { nome: 'Desenvolvimento', permite_escrita: true },
  empresa:         { nome: 'Empresa',         permite_escrita: true }
};

function gerarChave() {
  const grupo = () => Array.from({ length: 4 }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('');
  return `MRSH-${grupo()}-${grupo()}-${grupo()}`;
}

function hashChave(chave) {
  return crypto.createHash('sha256').update(String(chave || '').trim().toUpperCase()).digest('hex');
}

function prefixoChave(chave) {
  return String(chave).slice(0, 9); // "MRSH-XXXX"
}

let _privada = null;
function chavePrivada() {
  if (_privada) return _privada;
  const pem = (process.env.LICENCA_CHAVE_PRIVADA || '').replace(/\\n/g, '\n').trim();
  if (!pem) return null;
  _privada = crypto.createPrivateKey(pem);
  return _privada;
}

function chavePublicaPem() {
  const priv = chavePrivada();
  if (!priv) return null;
  return crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
}

/** Assina o payload. Devolve o JSON exato que foi assinado + assinatura base64. */
function assinar(payload) {
  const priv = chavePrivada();
  if (!priv) throw new Error('LICENCA_CHAVE_PRIVADA não configurada');
  const licenca_json = JSON.stringify(payload);
  const assinatura = crypto.sign(null, Buffer.from(licenca_json, 'utf8'), priv).toString('base64');
  return { licenca_json, assinatura };
}

function listaSids(sids) {
  return String(sids || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

module.exports = { PLANOS, VALIDADE_DIAS, gerarChave, hashChave, prefixoChave, chavePublicaPem, assinar, listaSids };
