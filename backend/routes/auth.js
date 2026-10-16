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
       WHERE LOWER(u.email) = LOWER($1)`,
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
      cliente_id: usuario.cliente_id || null,
      sv: usuario.sessao_versao || 0 // conferido pelo middleware autenticar a cada requisição
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
        empresa_nome: usuario.empresa_fantasia || usuario.empresa_nome || 'Marsh Consultoria',
        tema: usuario.tema || 'sereno'
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao fazer login', detalhe: err.message });
  }
});

// ===== Esqueci minha senha / convite (sem login) =====
const senhas = require('../services/senhas');
// Limites separados: pedir link é mais restrito (gera e-mail); usar o link permite errar a senha algumas vezes
const limiteEsqueci = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitos pedidos de link. Tente de novo em 15 minutos.' }
});
const limiteSenha = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Tente de novo em 15 minutos.' }
});

// POST /api/auth/esqueci { email } — responde sempre igual (não revela se o e-mail existe)
router.post('/esqueci', limiteEsqueci, async (req, res) => {
  const mail = String((req.body || {}).email || '').trim().toLowerCase();
  const resposta = { mensagem: 'Se o e-mail estiver cadastrado, enviamos um link para criar uma nova senha. Confira a caixa de entrada e o spam.' };
  if (!mail) return res.status(400).json({ erro: 'Informe o e-mail.' });
  try {
    const u = (await pool.query(`SELECT id, nome, email FROM usuarios WHERE LOWER(email) = $1 AND ativo = TRUE`, [mail])).rows[0];
    if (u) await senhas.enviarLink(u, 'redefinir');
    res.json(resposta);
  } catch (err) {
    res.status(500).json({ erro: 'Não foi possível enviar o link agora.', detalhe: err.message });
  }
});

// GET /api/auth/link/:token — a página de definir senha confere o link antes de mostrar o formulário
router.get('/link/:token', limiteSenha, async (req, res) => {
  try {
    const t = await senhas.lerToken(req.params.token);
    if (!t) return res.status(404).json({ erro: 'Link inválido ou expirado. Peça um novo.' });
    res.json({ tipo: t.tipo, nome: t.nome, email: t.email });
  } catch (err) { res.status(500).json({ erro: 'Erro ao validar o link.', detalhe: err.message }); }
});

// POST /api/auth/definir-senha { token, senha }
router.post('/definir-senha', limiteSenha, async (req, res) => {
  const { token, senha } = req.body || {};
  try {
    const r = await senhas.definirSenhaPorToken(token, senha);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.json({ mensagem: 'Senha criada! Faça login com seu e-mail e a nova senha.', email: r.email });
  } catch (err) { res.status(500).json({ erro: 'Erro ao definir a senha.', detalhe: err.message }); }
});

// GET /api/auth/tema?email=...
// Retorna apenas o tema salvo de um usuário (sem credenciais).
// Usado pela tela de login para evitar FOUC ao digitar o email.
router.get('/tema', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ tema: 'sereno' });
  try {
    const r = await pool.query(
      'SELECT tema FROM usuarios WHERE LOWER(email) = $1 AND ativo IS NOT FALSE LIMIT 1',
      [email]
    );
    res.json({ tema: r.rows[0]?.tema || 'sereno' });
  } catch (err) {
    res.json({ tema: 'sereno' });
  }
});

module.exports = router;
