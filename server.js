const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const pool = require('./db');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Servir arquivos estáticos do dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Importar rotas
const authRoutes = require('./routes/auth');
const clientesRoutes = require('./routes/clientes');
const fornecedoresRoutes = require('./routes/fornecedores');
const transacoesRoutes = require('./routes/transacoes');
const autenticar = require('./middleware/autenticar');

// Rotas públicas
app.use('/api/auth', authRoutes);

// Rotas protegidas
app.use('/api/clientes', autenticar, clientesRoutes);
app.use('/api/fornecedores', autenticar, fornecedoresRoutes);
app.use('/api/transacoes', autenticar, transacoesRoutes);

// Rota de teste
app.get('/api/ping', (req, res) => {
  res.json({ mensagem: 'Servidor está funcionando! ✅' });
});

// Rota raiz redireciona para dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Erro 404
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' });
});

// Criar tabelas se não existirem e iniciar servidor
async function iniciar() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        cpf_cnpj VARCHAR(50),
        email VARCHAR(255),
        telefone VARCHAR(50),
        endereco TEXT,
        data_criacao TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS fornecedores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        cnpj VARCHAR(50),
        email VARCHAR(255),
        telefone VARCHAR(50),
        ramo VARCHAR(255),
        data_criacao TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transacoes (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL,
        valor NUMERIC(12,2) NOT NULL,
        categoria VARCHAR(255) NOT NULL,
        descricao TEXT,
        data TIMESTAMP DEFAULT NOW(),
        usuario_id INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Tabelas verificadas/criadas com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao criar tabelas:', err.message);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
  });
}

iniciar();
