// Senhas: regra mínima, links de convite/redefinição (uso único, com prazo) e o envio por e-mail.
// O token só existe no link do e-mail; o banco guarda o SHA-256 dele (vazamento do banco não dá acesso).
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const email = require('./email');
const auditoria = require('./auditoria');

const BASE_URL = process.env.APP_URL || 'https://marshconsultoria.com.br';
const PRAZO_H = { convite: 72, redefinir: 2 };

// Mínimo 8 caracteres, com pelo menos uma letra e um número. Devolve a mensagem de erro ou null.
function validarSenha(senha) {
  const s = String(senha || '');
  if (s.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (!/[A-Za-zÀ-ÿ]/.test(s) || !/\d/.test(s)) return 'A senha precisa ter letras e números.';
  if (s.length > 128) return 'Senha longa demais (máx. 128).';
  return null;
}

const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// Cria um link novo (os anteriores do mesmo tipo deixam de valer) e envia por e-mail. Devolve { enviado, link }.
async function enviarLink(usuario, tipo) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`UPDATE usuarios_tokens SET usado_em = NOW() WHERE usuario_id = $1 AND tipo = $2 AND usado_em IS NULL`, [usuario.id, tipo]);
  await pool.query(
    `INSERT INTO usuarios_tokens (usuario_id, tipo, token_hash, expira_em) VALUES ($1, $2, $3, NOW() + make_interval(hours => $4))`,
    [usuario.id, tipo, hashToken(token), PRAZO_H[tipo]]);
  const link = `${BASE_URL}/definir-senha.html?t=${token}`;
  const enviado = await email.enviarLinkSenha({ nome: usuario.nome, email: usuario.email, link, tipo, horas: PRAZO_H[tipo] });
  return { enviado, link };
}

// Token válido (não usado, no prazo, usuário ativo) → { id, usuario_id, tipo, nome, email } ou null
async function lerToken(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const r = await pool.query(
    `SELECT t.id, t.usuario_id, t.tipo, u.nome, u.email
     FROM usuarios_tokens t JOIN usuarios u ON u.id = t.usuario_id
     WHERE t.token_hash = $1 AND t.usado_em IS NULL AND t.expira_em > NOW() AND u.ativo = TRUE`, [hashToken(token)]);
  return r.rows[0] || null;
}

// Define a senha pelo link e invalida todos os links pendentes do usuário
async function definirSenhaPorToken(token, senha) {
  const erro = validarSenha(senha);
  if (erro) return { erro };
  const t = await lerToken(token);
  if (!t) return { erro: 'Link inválido ou expirado. Peça um novo.' };
  // Consome o link de forma atômica: dois envios simultâneos do mesmo link, só um passa
  const consumido = await pool.query('UPDATE usuarios_tokens SET usado_em = NOW() WHERE id = $1 AND usado_em IS NULL', [t.id]);
  if (!consumido.rowCount) return { erro: 'Link inválido ou expirado. Peça um novo.' };
  // Senha nova encerra as sessões abertas (quem pediu o link pode estar recuperando uma conta invadida)
  await pool.query('UPDATE usuarios SET senha = $1, sessao_versao = sessao_versao + 1 WHERE id = $2', [await bcrypt.hash(senha, 10), t.usuario_id]);
  await pool.query('UPDATE usuarios_tokens SET usado_em = NOW() WHERE usuario_id = $1 AND usado_em IS NULL', [t.usuario_id]);
  await auditoria.registrar({ usuario_id: t.usuario_id, acao: `usuario.senha_definida_${t.tipo}`, entidade: 'usuario', entidade_id: t.usuario_id });
  return { ok: true, email: t.email };
}

// Senha impossível de adivinhar para quem ainda vai criar a sua pelo convite
const senhaProvisoria = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

module.exports = { validarSenha, enviarLink, lerToken, definirSenhaPorToken, senhaProvisoria, PRAZO_H };
