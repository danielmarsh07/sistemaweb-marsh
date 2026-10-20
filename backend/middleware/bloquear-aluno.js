// Usuário de vaga do Conector (portal_papel = 'aluno') vê só os próprios treinamentos:
// fica de fora das licenças e do assistente da empresa (o financeiro filtra por conta própria: só compras dele;
// os chamados, pelo chamados-do-aluno: só os próprios).
// O papel vem do banco (não do token), para valer na hora em que o gestor muda a vaga.
const { papelPortal } = require('../services/contratos-conector');

module.exports = async function bloquearAluno(req, res, next) {
  if (!req.usuario || req.usuario.tipo !== 'cliente') return next();
  try {
    if (await papelPortal(req.usuario.id) === 'aluno') {
      return res.status(403).json({ erro: 'Seu acesso ao portal é só aos seus treinamentos.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao conferir o acesso', detalhe: err.message });
  }
};
