const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar todas com resumo
router.get('/', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transacoes ORDER BY data DESC');
    const transacoes = result.rows;

    let totalEntradas = 0;
    let totalSaidas = 0;

    transacoes.forEach(t => {
      if (t.tipo === 'entrada') totalEntradas += parseFloat(t.valor);
      else if (t.tipo === 'saída') totalSaidas += parseFloat(t.valor);
    });

    res.json({
      transacoes,
      resumo: {
        totalEntradas,
        totalSaidas,
        saldo: totalEntradas - totalSaidas
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar transações', detalhe: err.message });
  }
});

// GET - Uma transação por ID
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transacoes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar transação', detalhe: err.message });
  }
});

// POST - Criar nova transação
router.post('/', async (req, res) => {
  const { tipo, valor, categoria, descricao, usuario_id } = req.body;

  if (!tipo || !valor || !categoria) {
    return res.status(400).json({ erro: 'Tipo, valor e categoria são obrigatórios' });
  }

  if (!['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO transacoes (tipo, valor, categoria, descricao, usuario_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tipo, parseFloat(valor), categoria, descricao || '', usuario_id || 1]
    );
    res.status(201).json({ mensagem: 'Transação criada com sucesso!', transacao: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar transação', detalhe: err.message });
  }
});

// PUT - Atualizar transação
router.put('/:id', async (req, res) => {
  const { tipo, valor, categoria, descricao } = req.body;

  if (tipo && !['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  try {
    const atual = await pool.query('SELECT * FROM transacoes WHERE id = $1', [req.params.id]);
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada' });
    }

    const t = atual.rows[0];
    const result = await pool.query(
      `UPDATE transacoes SET tipo=$1, valor=$2, categoria=$3, descricao=$4
       WHERE id=$5 RETURNING *`,
      [
        tipo || t.tipo,
        valor ? parseFloat(valor) : t.valor,
        categoria || t.categoria,
        descricao || t.descricao,
        req.params.id
      ]
    );
    res.json({ mensagem: 'Transação atualizada com sucesso!', transacao: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar transação', detalhe: err.message });
  }
});

// DELETE - Deletar transação
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM transacoes WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada' });
    }
    res.json({ mensagem: 'Transação deletada com sucesso!', transacao: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao deletar transação', detalhe: err.message });
  }
});

module.exports = router;
