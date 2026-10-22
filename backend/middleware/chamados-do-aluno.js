// Chamados de quem ocupa uma vaga do Conector (portal_papel = 'aluno'): pode abrir chamado e acompanhar
// SÓ os próprios — os que abriu no portal e os que o Conector abriu pela licença dele. Os da empresa toda
// continuam com o gestor, e aprovar chamado do Conector é só do gestor.
// Usado em /api/chamados (inclusive anexos) e /api/atendimentos. O papel vem do banco, como no bloquear-aluno.
const pool = require('../db');
const { papelPortal } = require('../services/contratos-conector');

// Condição SQL "chamado da pessoa" ($n = id do usuário), para a listagem (alias ch) e para a conferência por id
const condicaoProprios = n =>
  `(ch.aberto_por_usuario_id = $${n} OR ch.licenca_id IN (SELECT id FROM licencas WHERE usuario_id = $${n}))`;

function chamadoDaRequisicao(req) {
  if (req.baseUrl.endsWith('/atendimentos')) {
    const m = req.path.match(/^\/chamado\/(\d+)/);
    if (m) return m[1];
    if (req.method === 'POST' && req.path === '/') return String((req.body || {}).chamado_id || '') || null;
    return null; // DELETE /:id de atendimento: cliente já não pode
  }
  const m = req.path.match(/^\/(\d+)(\/|$)/);
  return m ? m[1] : null;
}

async function chamadosDoAluno(req, res, next) {
  if (!req.usuario || req.usuario.tipo !== 'cliente') return next();
  try {
    if (await papelPortal(req.usuario.id) !== 'aluno') return next();
    req.soProprios = true;
    // Aprovar é do gestor; o aluno só aprova os próprios chamados se o cliente o autorizou (aprova_chamados_conector)
    if (/^\/\d+\/aprovacao$/.test(req.path)) {
      const u = await pool.query('SELECT aprova_chamados_conector FROM usuarios WHERE id = $1', [req.usuario.id]);
      if (!u.rows[0]?.aprova_chamados_conector) {
        return res.status(403).json({ erro: 'A aprovação de chamados do Conector é feita pelo gestor do contrato.' });
      }
    }
    const id = chamadoDaRequisicao(req);
    if (id) {
      if (!/^\d+$/.test(id)) return res.status(404).json({ erro: 'Chamado não encontrado' });
      const r = await pool.query(`SELECT 1 FROM chamados ch WHERE ch.id = $1 AND ${condicaoProprios(2)}`, [id, req.usuario.id]);
      if (!r.rows.length) return res.status(404).json({ erro: 'Chamado não encontrado' });
    }
    next();
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao conferir o acesso', detalhe: err.message });
  }
}

module.exports = chamadosDoAluno;
module.exports.condicaoProprios = condicaoProprios;
