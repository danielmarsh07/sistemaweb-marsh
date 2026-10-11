// Bloqueia usuários do portal (tipo 'cliente') em rotas internas da Marsh.
// O portal só usa as rotas que já filtram pelo cliente do token (chamados, faturas, licença, cursos).
module.exports = function apenasEquipe(req, res, next) {
  if (req.usuario && req.usuario.tipo === 'cliente') {
    return res.status(403).json({ erro: 'Acesso restrito à equipe Marsh.' });
  }
  next();
};
