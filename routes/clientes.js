const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar todos
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar clientes', detalhe: err.message });
  }
});

// GET - Um cliente por ID
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar cliente', detalhe: err.message });
  }
});

// POST - Criar novo cliente
router.post('/', async (req, res) => {
  const { nome, cpf_cnpj, email, telefone, endereco } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO clientes (nome, cpf_cnpj, email, telefone, endereco)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nome, cpf_cnpj || '', email || '', telefone || '', endereco || '']
    );
    res.status(201).json({ mensagem: 'Cliente criado com sucesso!', cliente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar cliente', detalhe: err.message });
  }
});

// PUT - Atualizar cliente
router.put('/:id', async (req, res) => {
  const { nome, cpf_cnpj, email, telefone, endereco } = req.body;

  try {
    const atual = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const c = atual.rows[0];
    const result = await pool.query(
      `UPDATE clientes SET nome=$1, cpf_cnpj=$2, email=$3, telefone=$4, endereco=$5
       WHERE id=$6 RETURNING *`,
      [
        nome || c.nome,
        cpf_cnpj || c.cpf_cnpj,
        email || c.email,
        telefone || c.telefone,
        endereco || c.endereco,
        req.params.id
      ]
    );
    res.json({ mensagem: 'Cliente atualizado com sucesso!', cliente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar cliente', detalhe: err.message });
  }
});

// DELETE - Deletar cliente
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM clientes WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }
    res.json({ mensagem: 'Cliente deletado com sucesso!', cliente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao deletar cliente', detalhe: err.message });
  }
});

module.exports = router;
