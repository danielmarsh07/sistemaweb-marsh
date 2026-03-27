const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar todos
router.get('/', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM fornecedores ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar fornecedores', detalhe: err.message });
  }
});

// GET - Um fornecedor por ID
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM fornecedores WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar fornecedor', detalhe: err.message });
  }
});

// POST - Criar novo fornecedor
router.post('/', async (req, res) => {
  const { nome, cnpj, email, telefone, ramo } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO fornecedores (nome, cnpj, email, telefone, ramo)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nome, cnpj || '', email || '', telefone || '', ramo || '']
    );
    res.status(201).json({ mensagem: 'Fornecedor criado com sucesso!', fornecedor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar fornecedor', detalhe: err.message });
  }
});

// PUT - Atualizar fornecedor
router.put('/:id', async (req, res) => {
  const { nome, cnpj, email, telefone, ramo } = req.body;

  try {
    const atual = await pool.query('SELECT * FROM fornecedores WHERE id = $1', [req.params.id]);
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    }

    const f = atual.rows[0];
    const result = await pool.query(
      `UPDATE fornecedores SET nome=$1, cnpj=$2, email=$3, telefone=$4, ramo=$5
       WHERE id=$6 RETURNING *`,
      [
        nome || f.nome,
        cnpj || f.cnpj,
        email || f.email,
        telefone || f.telefone,
        ramo || f.ramo,
        req.params.id
      ]
    );
    res.json({ mensagem: 'Fornecedor atualizado com sucesso!', fornecedor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar fornecedor', detalhe: err.message });
  }
});

// DELETE - Deletar fornecedor
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM fornecedores WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    }
    res.json({ mensagem: 'Fornecedor deletado com sucesso!', fornecedor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao deletar fornecedor', detalhe: err.message });
  }
});

module.exports = router;
