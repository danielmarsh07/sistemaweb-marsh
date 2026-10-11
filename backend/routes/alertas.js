/**
 * /api/alertas — falhas registradas pelo services/alertas.js (só administradores).
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');

router.use((req, res, next) => {
  const tipo = req.usuario.tipo;
  if (tipo !== 'admin_empresa' && tipo !== 'admin_sistema') return res.status(403).json({ erro: 'Apenas administradores.' });
  next();
});

// GET /?todos=1 — por padrão só os não lidos; com todos=1, também os últimos 100 lidos
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, chave, nivel, titulo, detalhe, ocorrencias, primeira_em, ultima_em, email_enviado_em, lido
       FROM alertas_sistema ${req.query.todos === '1' ? '' : 'WHERE NOT lido'}
       ORDER BY lido, ultima_em DESC LIMIT 100`);
    const n = (await pool.query(`SELECT COUNT(*)::int AS n FROM alertas_sistema WHERE NOT lido`)).rows[0].n;
    res.json({ alertas: r.rows, nao_lidos: n });
  } catch (err) { res.status(500).json({ erro: 'Erro ao buscar alertas', detalhe: err.message }); }
});

router.post('/:id/lido', async (req, res) => {
  try {
    await pool.query('UPDATE alertas_sistema SET lido = TRUE WHERE id = $1', [req.params.id]);
    res.json({ mensagem: 'Marcado como resolvido.' });
  } catch (err) { res.status(500).json({ erro: 'Erro ao atualizar alerta', detalhe: err.message }); }
});

router.post('/ler-todos', async (req, res) => {
  try {
    const r = await pool.query('UPDATE alertas_sistema SET lido = TRUE WHERE NOT lido');
    res.json({ mensagem: `${r.rowCount} alerta(s) marcados como resolvidos.` });
  } catch (err) { res.status(500).json({ erro: 'Erro ao atualizar alertas', detalhe: err.message }); }
});

module.exports = router;
