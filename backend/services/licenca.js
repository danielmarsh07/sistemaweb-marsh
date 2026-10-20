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

const MAX_CONEXOES = 10;

/**
 * Valida e normaliza as conexões SAP da licença (o instalador recebe pré-preenchidas).
 * Só guarda { sid, descricao, url, mandante, idioma, producao? }: qualquer outro campo (usuário, senha...) é descartado.
 * `porta` (opcional) é gravada dentro da URL (https://host:porta); porta padrão do protocolo fica fora da URL.
 * Devolve { erro } ou { lista }.
 */
function validarConexoes(conexoes) {
  if (conexoes === null || conexoes === '') return { lista: [] };
  if (!Array.isArray(conexoes)) return { erro: 'Conexões SAP devem ser uma lista.' };
  if (conexoes.length > MAX_CONEXOES) return { erro: `No máximo ${MAX_CONEXOES} sistemas SAP.` };
  const lista = [];
  for (const [i, c] of conexoes.entries()) {
    const n = i + 1;
    if (!c || typeof c !== 'object') return { erro: `Conexão ${n}: formato inválido.` };
    const sid = String(c.sid || '').trim().toUpperCase();
    const descricao = String(c.descricao || '').trim().slice(0, 100);
    let url = String(c.url || '').trim();
    // Porta em campo próprio (tela): entra na URL, que é o que o instalador e o conector usam (https://host:porta)
    const porta = String(c.porta ?? '').trim();
    if (porta) {
      if (!/^\d{1,5}$/.test(porta) || Number(porta) < 1 || Number(porta) > 65535) {
        return { erro: `Conexão ${n} (${sid || '?'}): porta deve ser um número de 1 a 65535.` };
      }
      try {
        const u = new URL(url);
        u.port = porta;
        url = u.origin + (u.pathname === '/' ? '' : u.pathname);
      } catch (e) { /* URL inválida: a regra abaixo responde */ }
    }
    const mandante = String(c.mandante || '').trim();
    const idioma = String(c.idioma || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3}$/.test(sid)) return { erro: `Conexão ${n}: SID deve ter 3 letras/números.` };
    let urlOk = /^https?:\/\/\S+$/i.test(url) && url.length <= 255;
    if (urlOk) { try { new URL(url); } catch (e) { urlOk = false; } }
    if (!urlOk) return { erro: `Conexão ${n} (${sid}): URL deve começar com http:// ou https://.` };
    if (!/^\d{3}$/.test(mandante)) return { erro: `Conexão ${n} (${sid}): mandante deve ter 3 dígitos.` };
    if (!/^[A-Z]{2}$/.test(idioma)) return { erro: `Conexão ${n} (${sid}): idioma deve ter 2 letras (ex.: PT).` };
    if (lista.some(x => x.sid === sid)) return { erro: `Conexão ${n}: SID ${sid} repetido (uma conexão por SID).` };
    // producao: o conector trata o sistema como produção (sempre somente leitura) e manda o log das
    // consultas para a Marsh. Só é gravada quando marcada (as conexões antigas ficam iguais).
    const producao = c.producao === true || c.producao === 'true';
    lista.push({ sid, descricao, url: url.replace(/\/+$/, ''), mandante, idioma, ...(producao ? { producao: true } : {}) });
  }
  return { lista };
}

/** Conexões da licença limitadas aos SIDs contratados (o JSONB chega do pg já como array). */
function conexoesDosSids(conexoes, sids) {
  return (Array.isArray(conexoes) ? conexoes : []).filter(c => c && sids.includes(String(c.sid).toUpperCase()));
}

module.exports = { PLANOS, VALIDADE_DIAS, gerarChave, hashChave, prefixoChave, chavePublicaPem, assinar, listaSids,
                   validarConexoes, conexoesDosSids };
