const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar atendimentos de um chamado
router.get('/chamado/:chamado_id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    // Garante que o chamado pertence à empresa
    const chamadoOk = await pool.query(
      'SELECT id FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.chamado_id, empresa_id]
    );
    if (chamadoOk.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    const result = await pool.query(
      `SELECT a.*, u.nome as usuario_nome
       FROM atendimentos a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.chamado_id = $1
       ORDER BY a.data_atendimento ASC`,
      [req.params.chamado_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar atendimentos', detalhe: err.message });
  }
});

// POST - Registrar atendimento em um chamado
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const usuario_id = req.usuario.id;
  const { chamado_id, tipo, descricao, tempo_gasto_minutos, data_atendimento } = req.body;

  if (!chamado_id || !descricao) {
    return res.status(400).json({ erro: 'chamado_id e descrição são obrigatórios' });
  }

  try {
    // Garante que o chamado pertence à empresa
    const chamadoOk = await pool.query(
      'SELECT id, status FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [chamado_id, empresa_id]
    );
    if (chamadoOk.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    const result = await pool.query(
      `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, tempo_gasto_minutos, data_atendimento)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        chamado_id, usuario_id,
        tipo || 'comentario',
        descricao,
        tempo_gasto_minutos || 0,
        data_atendimento || new Date()
      ]
    );

    // Se o tipo for 'solucao', atualiza status do chamado para 'resolvido'
    if (tipo === 'solucao') {
      await pool.query(
        `UPDATE chamados SET status = 'resolvido', data_fechamento = NOW()
         WHERE id = $1 AND empresa_id = $2`,
        [chamado_id, empresa_id]
      );
    }

    // Se estava aberto e recebeu atendimento, muda para 'em_andamento'
    if (tipo !== 'solucao' && chamadoOk.rows[0].status === 'aberto') {
      await pool.query(
        `UPDATE chamados SET status = 'em_andamento' WHERE id = $1 AND empresa_id = $2`,
        [chamado_id, empresa_id]
      );
    }

    const atendimento = result.rows[0];

    // Buscar nome do usuário para retornar
    const usuario = await pool.query('SELECT nome FROM usuarios WHERE id = $1', [usuario_id]);
    if (usuario.rows.length > 0) {
      atendimento.usuario_nome = usuario.rows[0].nome;
    }

    res.status(201).json({ mensagem: 'Atendimento registrado com sucesso!', atendimento });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar atendimento', detalhe: err.message });
  }
});

// DELETE - Remover atendimento
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    // Verifica que o atendimento pertence a um chamado da empresa
    const check = await pool.query(
      `SELECT a.id FROM atendimentos a
       JOIN chamados ch ON ch.id = a.chamado_id
       WHERE a.id = $1 AND ch.empresa_id = $2`,
      [req.params.id, empresa_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ erro: 'Atendimento não encontrado' });
    }

    await pool.query('DELETE FROM atendimentos WHERE id = $1', [req.params.id]);
    res.json({ mensagem: 'Atendimento removido com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover atendimento', detalhe: err.message });
  }
});

module.exports = router;
