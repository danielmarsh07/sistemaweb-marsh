const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Listar chamados (cliente vê só os seus; admin vê todos)
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  const { status, prioridade, cliente_id } = req.query;

  try {
    let query = `
      SELECT ch.*,
        COALESCE(c.razao_social, c.nome) as cliente_nome,
        t.nome as tecnologia_nome,
        u1.nome as aberto_por_nome,
        u2.nome as atribuido_para_nome,
        (SELECT COUNT(*) FROM atendimentos a WHERE a.chamado_id = ch.id) as total_atendimentos
      FROM chamados ch
      LEFT JOIN clientes c ON c.id = ch.cliente_id
      LEFT JOIN tecnologias t ON t.id = ch.tecnologia_id
      LEFT JOIN usuarios u1 ON u1.id = ch.aberto_por_usuario_id
      LEFT JOIN usuarios u2 ON u2.id = ch.atribuido_para_usuario_id
      WHERE ch.empresa_id = $1 AND ch.ativo = TRUE
    `;
    const params = [empresa_id];
    let idx = 2;

    // Clientes só veem os chamados vinculados ao seu cliente_id
    if (isCliente && req.usuario.cliente_id) {
      query += ` AND ch.cliente_id = $${idx++}`;
      params.push(req.usuario.cliente_id);
    }

    if (status) { query += ` AND ch.status = $${idx++}`; params.push(status); }
    if (prioridade) { query += ` AND ch.prioridade = $${idx++}`; params.push(prioridade); }
    if (!isCliente && cliente_id) { query += ` AND ch.cliente_id = $${idx++}`; params.push(cliente_id); }

    query += ' ORDER BY ch.data_criacao DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar chamados', detalhe: err.message });
  }
});

// GET - Um chamado por ID (com atendimentos)
router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT ch.*,
        COALESCE(c.razao_social, c.nome) as cliente_nome,
        t.nome as tecnologia_nome,
        u1.nome as aberto_por_nome,
        u2.nome as atribuido_para_nome
       FROM chamados ch
       LEFT JOIN clientes c ON c.id = ch.cliente_id
       LEFT JOIN tecnologias t ON t.id = ch.tecnologia_id
       LEFT JOIN usuarios u1 ON u1.id = ch.aberto_por_usuario_id
       LEFT JOIN usuarios u2 ON u2.id = ch.atribuido_para_usuario_id
       WHERE ch.id = $1 AND ch.empresa_id = $2 AND ch.ativo = TRUE`,
      [req.params.id, empresa_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    const chamado = result.rows[0];

    // Buscar atendimentos
    const atend = await pool.query(
      `SELECT a.*, u.nome as usuario_nome
       FROM atendimentos a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.chamado_id = $1
       ORDER BY a.data_atendimento ASC`,
      [req.params.id]
    );
    chamado.atendimentos = atend.rows;

    res.json(chamado);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar chamado', detalhe: err.message });
  }
});

// POST - Abrir chamado
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const usuario_id = req.usuario.id;
  const isCliente = req.usuario.tipo === 'cliente';

  let {
    cliente_id, tecnologia_id,
    titulo, descricao, prioridade, categoria,
    atribuido_para_usuario_id
  } = req.body;

  // Se for usuário cliente, vincula automaticamente ao seu cliente_id
  if (isCliente) {
    if (!req.usuario.cliente_id) {
      return res.status(400).json({ erro: 'Usuário não vinculado a nenhum cliente. Contate o administrador.' });
    }
    cliente_id = req.usuario.cliente_id;
  }

  if (!titulo) {
    return res.status(400).json({ erro: 'Título é obrigatório' });
  }
  if (!cliente_id) {
    return res.status(400).json({ erro: 'Cliente é obrigatório' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO chamados (
        empresa_id, cliente_id, tecnologia_id,
        aberto_por_usuario_id, atribuido_para_usuario_id,
        titulo, descricao, prioridade, categoria, status, ativo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aberto', TRUE)
      RETURNING *`,
      [
        empresa_id, cliente_id || null, tecnologia_id || null,
        usuario_id, atribuido_para_usuario_id || null,
        titulo, descricao || null,
        prioridade || 'media', categoria || null
      ]
    );
    res.status(201).json({ mensagem: 'Chamado aberto com sucesso!', chamado: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao abrir chamado', detalhe: err.message });
  }
});

// PUT - Atualizar chamado (status, atribuição, etc.)
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const {
    titulo, descricao, status, prioridade, categoria,
    cliente_id, tecnologia_id, atribuido_para_usuario_id
  } = req.body;

  try {
    const atual = await pool.query(
      'SELECT * FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    const ch = atual.rows[0];

    // Se fechando ou resolvendo, registra data de fechamento
    const dataFechamento = (status === 'fechado' || status === 'resolvido') ? new Date() : ch.data_fechamento;

    const result = await pool.query(
      `UPDATE chamados SET
        titulo=$1, descricao=$2, status=$3, prioridade=$4, categoria=$5,
        cliente_id=$6, tecnologia_id=$7, atribuido_para_usuario_id=$8,
        data_fechamento=$9
       WHERE id=$10 AND empresa_id=$11 RETURNING *`,
      [
        titulo || ch.titulo,
        descricao ?? ch.descricao,
        status || ch.status,
        prioridade || ch.prioridade,
        categoria ?? ch.categoria,
        cliente_id || ch.cliente_id,
        tecnologia_id ?? ch.tecnologia_id,
        atribuido_para_usuario_id ?? ch.atribuido_para_usuario_id,
        dataFechamento,
        req.params.id, empresa_id
      ]
    );
    res.json({ mensagem: 'Chamado atualizado com sucesso!', chamado: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar chamado', detalhe: err.message });
  }
});

// DELETE - Exclusão lógica
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'UPDATE chamados SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING *',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }
    res.json({ mensagem: 'Chamado removido com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover chamado', detalhe: err.message });
  }
});

module.exports = router;
