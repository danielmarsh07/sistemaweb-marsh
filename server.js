const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const pool = require('./db');

const app = express();

// Necessário no Render (e qualquer reverse proxy) para o req.ip refletir o IP real
// e o express-rate-limit funcionar corretamente.
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());

// Servir arquivos estáticos do dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Importar rotas
const authRoutes = require('./routes/auth');
const empresasRoutes = require('./routes/empresas');
const clientesRoutes = require('./routes/clientes');
const fornecedoresRoutes = require('./routes/fornecedores');
const transacoesRoutes = require('./routes/transacoes');
const tecnologiasRoutes = require('./routes/tecnologias');
const chamadosRoutes = require('./routes/chamados');
const atendimentosRoutes = require('./routes/atendimentos');
const usuariosRoutes = require('./routes/usuarios');
const autenticar = require('./middleware/autenticar');

// Rotas públicas
app.use('/api/auth', authRoutes);

// Rotas protegidas
app.use('/api/empresas', autenticar, empresasRoutes);
app.use('/api/clientes', autenticar, clientesRoutes);
app.use('/api/fornecedores', autenticar, fornecedoresRoutes);
app.use('/api/transacoes', autenticar, transacoesRoutes);
app.use('/api/tecnologias', autenticar, tecnologiasRoutes);
app.use('/api/chamados', autenticar, chamadosRoutes);
app.use('/api/atendimentos', autenticar, atendimentosRoutes);
app.use('/api/usuarios', autenticar, usuariosRoutes);

// Rota de teste
app.get('/api/ping', (req, res) => {
  res.json({ mensagem: 'Servidor está funcionando! ✅' });
});

// Rota raiz redireciona para landing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Erro 404
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota não encontrada' });
});

// ===== MIGRAÇÃO E INICIALIZAÇÃO DO BANCO =====
async function iniciar() {
  try {
    // 1. Criar tabela de empresas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS empresas (
        id SERIAL PRIMARY KEY,
        razao_social VARCHAR(255) NOT NULL,
        nome_fantasia VARCHAR(255),
        cnpj VARCHAR(50),
        email VARCHAR(255),
        telefone VARCHAR(50),
        status VARCHAR(20) DEFAULT 'ativo',
        plano VARCHAR(50) DEFAULT 'basico',
        ativo BOOLEAN DEFAULT TRUE,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. Inserir empresa padrão (Marsh Consultoria) se não existir
    await pool.query(`
      INSERT INTO empresas (razao_social, nome_fantasia, cnpj, email, status, plano)
      SELECT 'Marsh Consultoria', 'Marsh', '00.000.000/0001-00', 'contato@marsh.com.br', 'ativo', 'enterprise'
      WHERE NOT EXISTS (SELECT 1 FROM empresas WHERE id = 1);
    `);

    // 3. Criar tabela de usuários (base)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4. Adicionar colunas novas em usuarios (migração segura)
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo VARCHAR(50) DEFAULT 'admin_empresa';`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cliente_id INTEGER;`);
    // Corrigir linhas com NULL (caso o ALTER anterior já existia sem DEFAULT aplicado)
    await pool.query(`UPDATE usuarios SET empresa_id = 1 WHERE empresa_id IS NULL;`);
    await pool.query(`UPDATE usuarios SET tipo = 'admin_empresa' WHERE tipo IS NULL;`);
    await pool.query(`UPDATE usuarios SET ativo = TRUE WHERE ativo IS NULL;`);

    // 5. Criar tabela clientes base
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 6. Adicionar colunas novas em clientes (migração segura)
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS empresa_id INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS razao_social VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nome_fantasia VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cpf_cnpj VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inscricao_estadual VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS inscricao_municipal VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefone VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS celular VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS site VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS responsavel_nome VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS responsavel_email VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS responsavel_telefone VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cep VARCHAR(20);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS logradouro VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS numero VARCHAR(20);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS complemento VARCHAR(100);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bairro VARCHAR(100);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cidade VARCHAR(100);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS uf VARCHAR(2);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ativo';`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS data_inicio_contrato DATE;`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS data_fim_contrato DATE;`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS observacoes TEXT;`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS endereco TEXT;`);
    // Corrigir NULLs em clientes
    await pool.query(`UPDATE clientes SET empresa_id = 1 WHERE empresa_id IS NULL;`);
    await pool.query(`UPDATE clientes SET ativo = TRUE WHERE ativo IS NULL;`);
    await pool.query(`UPDATE clientes SET status = 'ativo' WHERE status IS NULL;`);

    // 7. Criar tabela fornecedores base
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fornecedores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 8. Adicionar colunas novas em fornecedores (migração segura)
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS empresa_id INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS razao_social VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cnpj VARCHAR(50);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS telefone VARCHAR(50);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS celular VARCHAR(50);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS ramo VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS tipo VARCHAR(50);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS site VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS contato_nome VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS contato_email VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ativo';`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS observacoes TEXT;`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT TRUE;`);
    // Corrigir NULLs em fornecedores
    await pool.query(`UPDATE fornecedores SET empresa_id = 1 WHERE empresa_id IS NULL;`);
    await pool.query(`UPDATE fornecedores SET ativo = TRUE WHERE ativo IS NULL;`);
    await pool.query(`UPDATE fornecedores SET status = 'ativo' WHERE status IS NULL;`);

    // 9. Criar tabela transacoes base
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transacoes (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL,
        valor NUMERIC(12,2) NOT NULL,
        categoria VARCHAR(255) NOT NULL,
        descricao TEXT,
        data TIMESTAMP DEFAULT NOW(),
        usuario_id INTEGER DEFAULT 1
      );
    `);
    await pool.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS empresa_id INTEGER DEFAULT 1;`);

    // 10. Criar tabela de tecnologias
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tecnologias (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER DEFAULT 1,
        nome VARCHAR(255) NOT NULL,
        categoria VARCHAR(100),
        descricao TEXT,
        fabricante VARCHAR(255),
        versao VARCHAR(50),
        status VARCHAR(20) DEFAULT 'ativa',
        ativo BOOLEAN DEFAULT TRUE,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 11. Criar tabela de vínculo cliente x tecnologia
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cliente_tecnologias (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER NOT NULL,
        tecnologia_id INTEGER NOT NULL,
        data_ativacao DATE DEFAULT CURRENT_DATE,
        data_inativacao DATE,
        status VARCHAR(20) DEFAULT 'ativo',
        observacoes TEXT,
        data_criacao TIMESTAMP DEFAULT NOW(),
        UNIQUE(cliente_id, tecnologia_id)
      );
    `);

    // 12. Criar tabela de chamados
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chamados (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER DEFAULT 1,
        cliente_id INTEGER,
        tecnologia_id INTEGER,
        aberto_por_usuario_id INTEGER,
        atribuido_para_usuario_id INTEGER,
        titulo VARCHAR(500) NOT NULL,
        descricao TEXT,
        status VARCHAR(50) DEFAULT 'aberto',
        prioridade VARCHAR(20) DEFAULT 'media',
        categoria VARCHAR(100),
        data_abertura TIMESTAMP DEFAULT NOW(),
        data_fechamento TIMESTAMP,
        ativo BOOLEAN DEFAULT TRUE,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 13. Criar tabela de atendimentos (timeline do chamado)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atendimentos (
        id SERIAL PRIMARY KEY,
        chamado_id INTEGER NOT NULL,
        usuario_id INTEGER,
        tipo VARCHAR(50) DEFAULT 'comentario',
        descricao TEXT NOT NULL,
        tempo_gasto_minutos INTEGER DEFAULT 0,
        data_atendimento TIMESTAMP DEFAULT NOW(),
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 14. Criar tabela de histórico de status do chamado (auditoria)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chamados_status_log (
        id SERIAL PRIMARY KEY,
        chamado_id INTEGER NOT NULL,
        empresa_id INTEGER,
        usuario_id INTEGER,
        status_anterior VARCHAR(50),
        status_novo VARCHAR(50) NOT NULL,
        observacao TEXT,
        data_mudanca TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_status_log_chamado ON chamados_status_log(chamado_id);`);

    // 15. Auditoria — colunas criado_por_usuario_id, atualizado_por_usuario_id, data_atualizacao
    // chamados não recebe criado_por_usuario_id porque já tem aberto_por_usuario_id (semanticamente equivalente).
    const tabelasComCriadoPor = ['clientes', 'fornecedores', 'tecnologias', 'transacoes'];
    const tabelasComAtualizadoPor = ['clientes', 'fornecedores', 'tecnologias', 'transacoes', 'chamados'];

    for (const t of tabelasComCriadoPor) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS criado_por_usuario_id INTEGER;`);
      // Backfill: registros antigos ficam vinculados ao admin (usuario id=1)
      await pool.query(`UPDATE ${t} SET criado_por_usuario_id = 1 WHERE criado_por_usuario_id IS NULL;`);
    }

    for (const t of tabelasComAtualizadoPor) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS atualizado_por_usuario_id INTEGER;`);
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS data_atualizacao TIMESTAMP;`);
    }

    console.log('✅ Banco de dados migrado e tabelas verificadas com sucesso!');
  } catch (err) {
    console.error('❌ Erro na migração do banco:', err.message);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
  });
}

iniciar();
