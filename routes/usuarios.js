const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db');

// Middleware: apenas admin_empresa e admin_sistema podem gerenciar usuários
// Se tipo não veio no JWT (token antigo), assume admin_empresa
function apenasAdmin(req, res, next) {
  const tipo = req.usuario.tipo;
  if (tipo && tipo !== 'admin_empresa' && tipo !== 'admin_sistema') {
    return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  }
  next();
}

// GET - Listar usuários da empresa
router.get('/', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT u.id, u.nome, u.email, u.tipo, u.ativo, u.data_criacao,
              u.cliente_id,
              COALESCE(c.razao_social, c.nome) as cliente_nome
       FROM usuarios u
       LEFT JOIN clientes c ON c.id = u.cliente_id
       WHERE u.empresa_id = $1
       ORDER BY u.tipo ASC, u.nome ASC`,
      [empresa_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar usuários', detalhe: err.message });
  }
});

// POST - Criar novo usuário (admin cria para cliente ou técnico)
router.post('/', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, email, senha, tipo, cliente_id } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios' });
  }

  if (!tipo) {
    return res.status(400).json({ erro: 'Tipo de usuário é obrigatório' });
  }

  const tiposValidos = ['admin_empresa', 'tecnico', 'cliente'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({ erro: `Tipo inválido. Use: ${tiposValidos.join(', ')}` });
  }

  if (tipo === 'cliente' && !cliente_id) {
    return res.status(400).json({ erro: 'Usuário do tipo cliente deve estar vinculado a um cliente' });
  }

  if (senha.length < 6) {
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
  }

  try {
    const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ erro: 'Email já cadastrado' });
    }

    // Se tipo=cliente, valida que o cliente pertence à empresa
    if (tipo === 'cliente' && cliente_id) {
      const clienteOk = await pool.query(
        'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo IS NOT FALSE',
        [cliente_id, empresa_id]
      );
      if (clienteOk.rows.length === 0) {
        return res.status(400).json({ erro: 'Cliente não encontrado nesta empresa' });
      }
    }

    const hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, nome, email, tipo, cliente_id, ativo, data_criacao`,
      [nome, email, hash, empresa_id, tipo, tipo === 'cliente' ? cliente_id : null]
    );

    res.status(201).json({ mensagem: 'Usuário criado com sucesso!', usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar usuário', detalhe: err.message });
  }
});

// PUT - Atualizar usuário (nome, tipo, cliente_id, ativo)
router.put('/:id', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, tipo, cliente_id, ativo } = req.body;

  try {
    const atual = await pool.query(
      'SELECT * FROM usuarios WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const u = atual.rows[0];

    // Não deixa revogar o próprio acesso de admin
    if (parseInt(req.params.id) === req.usuario.id && ativo === false) {
      return res.status(400).json({ erro: 'Você não pode desativar sua própria conta' });
    }

    const result = await pool.query(
      `UPDATE usuarios SET nome=$1, tipo=$2, cliente_id=$3, ativo=$4
       WHERE id=$5 AND empresa_id=$6
       RETURNING id, nome, email, tipo, cliente_id, ativo`,
      [
        nome || u.nome,
        tipo || u.tipo,
        tipo === 'cliente' ? (cliente_id || u.cliente_id) : null,
        ativo !== undefined ? ativo : u.ativo,
        req.params.id,
        empresa_id
      ]
    );

    res.json({ mensagem: 'Usuário atualizado!', usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar usuário', detalhe: err.message });
  }
});

// PUT - Resetar senha (admin redefine a senha de qualquer usuário da empresa)
router.put('/:id/senha', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nova_senha } = req.body;

  if (!nova_senha || nova_senha.length < 6) {
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
  }

  try {
    const check = await pool.query(
      'SELECT id FROM usuarios WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const hash = await bcrypt.hash(nova_senha, 10);
    await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [hash, req.params.id]);

    res.json({ mensagem: 'Senha redefinida com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao redefinir senha', detalhe: err.message });
  }
});

// DELETE - Desativar usuário (soft delete)
router.delete('/:id', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;

  if (parseInt(req.params.id) === req.usuario.id) {
    return res.status(400).json({ erro: 'Você não pode desativar sua própria conta' });
  }

  try {
    const result = await pool.query(
      'UPDATE usuarios SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING id, nome',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }
    res.json({ mensagem: `Usuário ${result.rows[0].nome} desativado.` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao desativar usuário', detalhe: err.message });
  }
});

module.exports = router;
