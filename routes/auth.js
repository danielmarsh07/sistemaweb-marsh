const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

// Rate limit: 10 tentativas de login por IP a cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Email e senha são obrigatórios' });
  }

  try {
    const result = await pool.query(
      `SELECT u.*, e.razao_social as empresa_nome, e.nome_fantasia as empresa_fantasia
       FROM usuarios u
       LEFT JOIN empresas e ON e.id = u.empresa_id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Email ou senha inválidos' });
    }

    const usuario = result.rows[0];

    if (usuario.ativo === false) {
      return res.status(403).json({ erro: 'Usuário desativado. Entre em contato com o administrador.' });
    }

    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
    if (!senhaCorreta) {
      return res.status(401).json({ erro: 'Email ou senha inválidos' });
    }

    const payload = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      empresa_id: usuario.empresa_id || 1,
      tipo: usuario.tipo || 'admin_empresa',
      cliente_id: usuario.cliente_id || null
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      mensagem: 'Login realizado com sucesso!',
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        empresa_id: usuario.empresa_id || 1,
        tipo: usuario.tipo || 'admin_empresa',
        cliente_id: usuario.cliente_id || null,
        empresa_nome: usuario.empresa_fantasia || usuario.empresa_nome || 'Marsh Consultoria'
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao fazer login', detalhe: err.message });
  }
});

module.exports = router;
