const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar tecnologias da empresa
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT t.*,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome,
        (SELECT COUNT(*) FROM cliente_tecnologias ct WHERE ct.tecnologia_id = t.id AND ct.status = 'ativo') as total_clientes
       FROM tecnologias t
       LEFT JOIN usuarios uc ON uc.id = t.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = t.atualizado_por_usuario_id
       WHERE t.empresa_id = $1 AND t.ativo = TRUE
       ORDER BY t.categoria ASC, t.nome ASC`,
      [empresa_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar tecnologias', detalhe: err.message });
  }
});

// GET - Uma tecnologia por ID
router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT t.*,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome
       FROM tecnologias t
       LEFT JOIN usuarios uc ON uc.id = t.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = t.atualizado_por_usuario_id
       WHERE t.id = $1 AND t.empresa_id = $2 AND t.ativo = TRUE`,
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Tecnologia não encontrada' });
    }

    const tec = result.rows[0];

    // Clientes que usam essa tecnologia
    const clientes = await pool.query(
      `SELECT c.id, COALESCE(c.razao_social, c.nome) as nome, ct.status as vinculo_status
       FROM cliente_tecnologias ct
       JOIN clientes c ON c.id = ct.cliente_id
       WHERE ct.tecnologia_id = $1 AND ct.status = 'ativo' AND c.ativo = TRUE`,
      [req.params.id]
    );
    tec.clientes = clientes.rows;

    res.json(tec);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar tecnologia', detalhe: err.message });
  }
});

// POST - Criar tecnologia
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, categoria, descricao, fabricante, versao, status } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tecnologias (empresa_id, nome, categoria, descricao, fabricante, versao, status, criado_por_usuario_id, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING *`,
      [
        empresa_id, nome,
        categoria || null, descricao || null,
        fabricante || null, versao || null,
        status || 'ativa',
        req.usuario.id
      ]
    );
    res.status(201).json({ mensagem: 'Tecnologia criada com sucesso!', tecnologia: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar tecnologia', detalhe: err.message });
  }
});

// PUT - Atualizar tecnologia
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, categoria, descricao, fabricante, versao, status } = req.body;

  try {
    const atual = await pool.query(
      'SELECT * FROM tecnologias WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Tecnologia não encontrada' });
    }

    const t = atual.rows[0];
    const result = await pool.query(
      `UPDATE tecnologias SET nome=$1, categoria=$2, descricao=$3, fabricante=$4, versao=$5, status=$6,
        atualizado_por_usuario_id=$7, data_atualizacao=NOW()
       WHERE id=$8 AND empresa_id=$9 RETURNING *`,
      [
        nome || t.nome,
        categoria ?? t.categoria,
        descricao ?? t.descricao,
        fabricante ?? t.fabricante,
        versao ?? t.versao,
        status || t.status,
        req.usuario.id,
        req.params.id, empresa_id
      ]
    );
    res.json({ mensagem: 'Tecnologia atualizada com sucesso!', tecnologia: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar tecnologia', detalhe: err.message });
  }
});

// DELETE - Exclusão lógica
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'UPDATE tecnologias SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING *',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Tecnologia não encontrada' });
    }
    res.json({ mensagem: 'Tecnologia removida com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover tecnologia', detalhe: err.message });
  }
});

module.exports = router;
