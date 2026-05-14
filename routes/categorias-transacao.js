const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { tipo, ativos } = req.query;
  try {
    const params = [empresa_id];
    let sql = `
      SELECT c.*,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome,
        (SELECT COUNT(*) FROM transacoes t
         WHERE t.empresa_id = c.empresa_id AND t.categoria = c.nome) as total_uso
      FROM categorias_transacao c
      LEFT JOIN usuarios uc ON uc.id = c.criado_por_usuario_id
      LEFT JOIN usuarios ua ON ua.id = c.atualizado_por_usuario_id
      WHERE c.empresa_id = $1`;

    if (tipo === 'entrada' || tipo === 'saída') {
      params.push(tipo);
      sql += ` AND c.tipo = $${params.length}`;
    }
    if (ativos === 'true') {
      sql += ` AND c.ativo = TRUE`;
    }
    sql += ` ORDER BY c.tipo ASC, c.nome ASC`;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar categorias', detalhe: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT * FROM categorias_transacao WHERE id = $1 AND empresa_id = $2`,
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Categoria não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar categoria', detalhe: err.message });
  }
});

router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, tipo, descricao } = req.body;

  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }
  if (!['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO categorias_transacao (empresa_id, nome, tipo, descricao, criado_por_usuario_id, ativo)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
      [empresa_id, nome.trim(), tipo, descricao || null, req.usuario.id]
    );
    res.status(201).json({ mensagem: 'Categoria criada com sucesso!', categoria: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ erro: 'Já existe uma categoria com esse nome e tipo' });
    }
    res.status(500).json({ erro: 'Erro ao criar categoria', detalhe: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, tipo, descricao, ativo } = req.body;

  if (tipo && !['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  try {
    const atual = await pool.query(
      'SELECT * FROM categorias_transacao WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Categoria não encontrada' });
    }

    const c = atual.rows[0];
    const novoNome = nome != null && nome.trim() ? nome.trim() : c.nome;
    const novoTipo = tipo || c.tipo;

    // Se alterou o nome ou o tipo, propaga para as transações relacionadas (mantém histórico coerente).
    if (novoNome !== c.nome || novoTipo !== c.tipo) {
      await pool.query(
        `UPDATE transacoes SET categoria = $1
         WHERE empresa_id = $2 AND categoria = $3 AND tipo = $4`,
        [novoNome, empresa_id, c.nome, c.tipo]
      );
    }

    const result = await pool.query(
      `UPDATE categorias_transacao
       SET nome=$1, tipo=$2, descricao=$3, ativo=$4,
           atualizado_por_usuario_id=$5, data_atualizacao=NOW()
       WHERE id=$6 AND empresa_id=$7 RETURNING *`,
      [
        novoNome,
        novoTipo,
        descricao !== undefined ? descricao : c.descricao,
        ativo !== undefined ? ativo : c.ativo,
        req.usuario.id,
        req.params.id, empresa_id
      ]
    );
    res.json({ mensagem: 'Categoria atualizada com sucesso!', categoria: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ erro: 'Já existe uma categoria com esse nome e tipo' });
    }
    res.status(500).json({ erro: 'Erro ao atualizar categoria', detalhe: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const cat = await pool.query(
      'SELECT * FROM categorias_transacao WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (cat.rows.length === 0) {
      return res.status(404).json({ erro: 'Categoria não encontrada' });
    }
    const c = cat.rows[0];

    // Se há transações usando, exclusão lógica (desativa). Senão, hard delete.
    const uso = await pool.query(
      `SELECT COUNT(*)::int as total FROM transacoes
       WHERE empresa_id = $1 AND categoria = $2 AND tipo = $3`,
      [empresa_id, c.nome, c.tipo]
    );

    if (uso.rows[0].total > 0) {
      await pool.query(
        `UPDATE categorias_transacao SET ativo = FALSE,
           atualizado_por_usuario_id = $1, data_atualizacao = NOW()
         WHERE id = $2 AND empresa_id = $3`,
        [req.usuario.id, req.params.id, empresa_id]
      );
      return res.json({
        mensagem: `Categoria desativada (em uso por ${uso.rows[0].total} transação(ões))`,
        desativada: true
      });
    }

    await pool.query(
      'DELETE FROM categorias_transacao WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    res.json({ mensagem: 'Categoria removida com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover categoria', detalhe: err.message });
  }
});

module.exports = router;
