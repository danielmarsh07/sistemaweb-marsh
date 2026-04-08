const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar fornecedores da empresa logada
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT * FROM fornecedores
       WHERE empresa_id = $1 AND ativo = TRUE
       ORDER BY COALESCE(razao_social, nome) ASC`,
      [empresa_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar fornecedores', detalhe: err.message });
  }
});

// GET - Um fornecedor por ID
router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
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
  const empresa_id = req.usuario.empresa_id || 1;
  const {
    razao_social, nome_fantasia, cnpj,
    email, telefone, celular, site, ramo, tipo,
    contato_nome, contato_email,
    status, observacoes
  } = req.body;

  if (!razao_social) {
    return res.status(400).json({ erro: 'Razão social é obrigatória' });
  }

  try {
    // Verificar CNPJ duplicado
    if (cnpj) {
      const dup = await pool.query(
        'SELECT id FROM fornecedores WHERE cnpj = $1 AND empresa_id = $2 AND ativo = TRUE',
        [cnpj, empresa_id]
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({ erro: 'CNPJ já cadastrado para outro fornecedor' });
      }
    }

    const result = await pool.query(
      `INSERT INTO fornecedores (
        empresa_id, nome, razao_social, nome_fantasia, cnpj,
        email, telefone, celular, site, ramo, tipo,
        contato_nome, contato_email, status, observacoes, ativo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      RETURNING *`,
      [
        empresa_id,
        razao_social,
        razao_social, nome_fantasia || null, cnpj || null,
        email || null, telefone || null, celular || null, site || null,
        ramo || null, tipo || null,
        contato_nome || null, contato_email || null,
        status || 'ativo', observacoes || null
      ]
    );
    res.status(201).json({ mensagem: 'Fornecedor criado com sucesso!', fornecedor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar fornecedor', detalhe: err.message });
  }
});

// PUT - Atualizar fornecedor
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const {
    razao_social, nome_fantasia, cnpj,
    email, telefone, celular, site, ramo, tipo,
    contato_nome, contato_email, status, observacoes
  } = req.body;

  try {
    const atual = await pool.query(
      'SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    }

    const f = atual.rows[0];

    if (cnpj && cnpj !== f.cnpj) {
      const dup = await pool.query(
        'SELECT id FROM fornecedores WHERE cnpj = $1 AND empresa_id = $2 AND ativo = TRUE AND id != $3',
        [cnpj, empresa_id, req.params.id]
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({ erro: 'CNPJ já cadastrado para outro fornecedor' });
      }
    }

    const novaRazao = razao_social || f.razao_social || f.nome;

    const result = await pool.query(
      `UPDATE fornecedores SET
        nome=$1, razao_social=$2, nome_fantasia=$3, cnpj=$4,
        email=$5, telefone=$6, celular=$7, site=$8, ramo=$9, tipo=$10,
        contato_nome=$11, contato_email=$12, status=$13, observacoes=$14
       WHERE id=$15 AND empresa_id=$16
       RETURNING *`,
      [
        novaRazao, novaRazao, nome_fantasia ?? f.nome_fantasia, cnpj ?? f.cnpj,
        email ?? f.email, telefone ?? f.telefone, celular ?? f.celular,
        site ?? f.site, ramo ?? f.ramo, tipo ?? f.tipo,
        contato_nome ?? f.contato_nome, contato_email ?? f.contato_email,
        status ?? f.status, observacoes ?? f.observacoes,
        req.params.id, empresa_id
      ]
    );
    res.json({ mensagem: 'Fornecedor atualizado com sucesso!', fornecedor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar fornecedor', detalhe: err.message });
  }
});

// DELETE - Exclusão lógica
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'UPDATE fornecedores SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING *',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    }
    res.json({ mensagem: 'Fornecedor removido com sucesso!', fornecedor: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover fornecedor', detalhe: err.message });
  }
});

module.exports = router;
