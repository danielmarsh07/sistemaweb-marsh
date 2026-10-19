const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET não está definido. Defina a variável de ambiente antes de iniciar o servidor.');
  process.exit(1);
}

// Além da assinatura do token, confere no banco a cada requisição: usuário desativado, excluído ou com
// sessao_versao incrementada (troca de senha, tipo ou empresa) perde o acesso na hora, sem esperar as 8 h.
async function autenticar(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer <token>"

  if (!token) {
    return res.status(401).json({ erro: 'Acesso negado. Faça login para continuar.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado. Faça login novamente.' });
  }

  try {
    const u = (await pool.query('SELECT ativo, sessao_versao FROM usuarios WHERE id = $1', [payload.id])).rows[0];
    if (!u || u.ativo === false || (u.sessao_versao || 0) !== (payload.sv || 0)) {
      return res.status(401).json({ erro: 'Sua sessão foi encerrada. Faça login novamente.' });
    }
    // Simulador de acesso: o administrador vê o sistema como o usuário, mas não altera nada em nome dele
    if (payload.simulado_por) {
      const adm = (await pool.query(
        `SELECT 1 FROM usuarios WHERE id = $1 AND ativo = TRUE AND tipo IN ('admin_empresa','admin_sistema')`, [payload.simulado_por])).rows[0];
      if (!adm) return res.status(401).json({ erro: 'A simulação de acesso foi encerrada.' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return res.status(403).json({ erro: 'Simulação de acesso: somente visualização. Volte ao seu acesso para fazer alterações.' });
      }
    }
  } catch (err) {
    return next(err);
  }
  req.usuario = payload;
  next();
}

module.exports = autenticar;
