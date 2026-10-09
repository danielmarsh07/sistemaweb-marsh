/**
 * Gera o par de chaves Ed25519 das licenças (rodar UMA vez, localmente):
 *   node scripts/gerar-chaves-licenca.js
 *
 * - Privada  -> variável de ambiente LICENCA_CHAVE_PRIVADA no Render (nunca no git)
 * - Pública  -> arquivo chave_publica_licenca.pem do conector (Integration ECC)
 *
 * Trocar o par invalida as licenças em cache nos clientes: só faça se a privada vazar.
 */
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privada = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publica = publicKey.export({ type: 'spki', format: 'pem' });

console.log('=== LICENCA_CHAVE_PRIVADA (Render > Environment; uma linha com \\n) ===');
console.log(privada.trim().replace(/\n/g, '\\n'));
console.log('\n=== chave_publica_licenca.pem (conector) ===');
console.log(publica.trim());
