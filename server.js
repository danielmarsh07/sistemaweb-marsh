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
const categoriasTransacaoRoutes = require('./routes/categorias-transacao');
const tecnologiasRoutes = require('./routes/tecnologias');
const chamadosRoutes = require('./routes/chamados');
const atendimentosRoutes = require('./routes/atendimentos');
const usuariosRoutes = require('./routes/usuarios');
const anexosRoutes = require('./routes/anexos');
const assistenteRoutes = require('./routes/assistente');
const licencasRoutes = require('./routes/licencas');
const licencasConectorRoutes = require('./routes/licencas-conector');
const treinamentosRoutes = require('./routes/treinamentos');
const financeiroRoutes = require('./routes/financeiro');
const asaasWebhookRoutes = require('./routes/asaas-webhook');
const financeiroJobs = require('./services/financeiro-jobs');
const autenticar = require('./middleware/autenticar');

// Rotas públicas
app.use('/api/auth', authRoutes);
app.use('/api/licencas-conector', licencasConectorRoutes); // conector SAP: autentica pela chave da licença
app.use('/api/asaas/webhook', asaasWebhookRoutes); // Asaas: autentica pelo header asaas-access-token

// Rotas protegidas
app.use('/api/empresas', autenticar, empresasRoutes);
app.use('/api/clientes', autenticar, clientesRoutes);
app.use('/api/fornecedores', autenticar, fornecedoresRoutes);
app.use('/api/transacoes', autenticar, transacoesRoutes);
app.use('/api/categorias-transacao', autenticar, categoriasTransacaoRoutes);
app.use('/api/tecnologias', autenticar, tecnologiasRoutes);
app.use('/api/chamados', autenticar, chamadosRoutes);
app.use('/api/chamados', autenticar, anexosRoutes); // anexos sob /api/chamados/:id/anexos
app.use('/api/atendimentos', autenticar, atendimentosRoutes);
app.use('/api/usuarios', autenticar, usuariosRoutes);
app.use('/api/assistente', autenticar, assistenteRoutes);
app.use('/api/licencas', autenticar, licencasRoutes);
app.use('/api/treinamentos', autenticar, treinamentosRoutes);
app.use('/api/financeiro', autenticar, financeiroRoutes);

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
    await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tema VARCHAR(20) DEFAULT 'sereno';`);
    await pool.query(`ALTER TABLE usuarios ALTER COLUMN tema SET DEFAULT 'sereno';`);
    await pool.query(`UPDATE usuarios SET tema = 'sereno' WHERE tema IS NULL;`);

    // Migrações de dados que devem rodar UMA vez só (o iniciar() roda a cada deploy)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migracoes_app (
        nome VARCHAR(100) PRIMARY KEY,
        executada_em TIMESTAMP DEFAULT NOW()
      );
    `);
    // Tema Marsh Sereno vira o padrão de todos; depois disso cada um troca à vontade
    const migTema = await pool.query(
      `INSERT INTO migracoes_app (nome) VALUES ('tema_sereno_padrao') ON CONFLICT DO NOTHING RETURNING nome;`
    );
    if (migTema.rowCount) {
      await pool.query(`UPDATE usuarios SET tema = 'sereno';`);
      console.log('Migração tema_sereno_padrao: todos os usuários no tema Marsh Sereno');
    }
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
    await pool.query(`ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS grupo_id UUID;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transacoes_grupo ON transacoes(grupo_id);`);

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

    // 16. Fase 2 — campos adicionais de classificação em clientes
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS segmento VARCHAR(50);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS porte VARCHAR(20);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tier_sla VARCHAR(20);`);

    // 17. Fase 2 — endereço completo em fornecedores (espelho de clientes)
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cep VARCHAR(20);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS logradouro VARCHAR(255);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS numero VARCHAR(20);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS complemento VARCHAR(100);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS bairro VARCHAR(100);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cidade VARCHAR(100);`);
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS uf VARCHAR(2);`);

    // 18. Fase 4 — avaliação CSAT do chamado
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chamados_avaliacao (
        id SERIAL PRIMARY KEY,
        chamado_id INTEGER NOT NULL UNIQUE,
        empresa_id INTEGER,
        usuario_id INTEGER,
        nota INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
        comentario TEXT,
        data_avaliacao TIMESTAMP DEFAULT NOW()
      );
    `);

    // 19. Fase 4 — atendimentos lidos por usuário (badge "novos comentários")
    await pool.query(`
      CREATE TABLE IF NOT EXISTS atendimentos_lidos (
        id SERIAL PRIMARY KEY,
        atendimento_id INTEGER NOT NULL,
        usuario_id INTEGER NOT NULL,
        lido_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(atendimento_id, usuario_id)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_atend_lidos_user ON atendimentos_lidos(usuario_id);`);

    // 20. Fase 4 — anexos do chamado (storage S3/R2)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chamados_anexos (
        id SERIAL PRIMARY KEY,
        chamado_id INTEGER NOT NULL,
        empresa_id INTEGER,
        usuario_id INTEGER,
        nome_original VARCHAR(255) NOT NULL,
        storage_key VARCHAR(500) NOT NULL,
        tamanho_bytes BIGINT,
        mime_type VARCHAR(150),
        data_upload TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_anexos_chamado ON chamados_anexos(chamado_id);`);

    // 21. Categorias de transação (cadastro estruturado, evita string livre)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categorias_transacao (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        nome VARCHAR(120) NOT NULL,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('entrada','saída')),
        descricao TEXT,
        ativo BOOLEAN DEFAULT TRUE,
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP,
        UNIQUE(empresa_id, nome, tipo)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cat_trans_emp ON categorias_transacao(empresa_id);`);

    // Backfill: cria categorias a partir dos valores já usados em transacoes
    // Inferimos o tipo pelo tipo majoritário de cada (empresa_id, categoria).
    await pool.query(`
      INSERT INTO categorias_transacao (empresa_id, nome, tipo, ativo)
      SELECT empresa_id, categoria, tipo, TRUE
      FROM (
        SELECT empresa_id, categoria, tipo,
               ROW_NUMBER() OVER (PARTITION BY empresa_id, categoria ORDER BY COUNT(*) DESC) AS rn
        FROM transacoes
        WHERE categoria IS NOT NULL AND TRIM(categoria) <> ''
        GROUP BY empresa_id, categoria, tipo
      ) ranked
      WHERE rn = 1
      ON CONFLICT (empresa_id, nome, tipo) DO NOTHING;
    `);

    // 20. Licenças do conector Claude <-> SAP (produto Marsh)
    //     A chave nunca é guardada em texto: só o hash SHA-256 e o prefixo para exibição.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licencas (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER DEFAULT 1,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        produto VARCHAR(50) DEFAULT 'conector_sap',
        plano VARCHAR(30) NOT NULL DEFAULT 'leitura',
        max_usuarios INTEGER,
        sids VARCHAR(255) NOT NULL DEFAULT 'DEV',
        data_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
        data_fim DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ativa',
        chave_hash VARCHAR(64) UNIQUE NOT NULL,
        chave_prefixo VARCHAR(20) NOT NULL,
        ultima_validacao TIMESTAMP,
        versao_conector VARCHAR(30),
        observacoes TEXT,
        ativo BOOLEAN DEFAULT TRUE,
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_licencas_emp ON licencas(empresa_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_licencas_cliente ON licencas(cliente_id);`);

    //     Uso: só contadores por dia/SID/usuário (hash)/ferramenta — nunca código ou dados do SAP
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licencas_uso (
        id SERIAL PRIMARY KEY,
        licenca_id INTEGER NOT NULL REFERENCES licencas(id),
        data DATE NOT NULL,
        sid VARCHAR(10) NOT NULL,
        usuario_hash VARCHAR(64) NOT NULL,
        ferramenta VARCHAR(50) NOT NULL,
        chamadas INTEGER NOT NULL DEFAULT 0,
        recusas INTEGER NOT NULL DEFAULT 0,
        UNIQUE (licenca_id, data, sid, usuario_hash, ferramenta)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_licencas_uso_lic_data ON licencas_uso(licenca_id, data);`);

    // 21. Treinamentos (portal do cliente): cursos, aulas, liberação por cliente, progresso por usuário
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cursos (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER DEFAULT 1,
        titulo VARCHAR(200) NOT NULL,
        descricao TEXT,
        capa VARCHAR(20) DEFAULT 'abap',
        carga_horaria VARCHAR(50),
        status VARCHAR(20) NOT NULL DEFAULT 'rascunho',
        ordem INTEGER DEFAULT 0,
        ativo BOOLEAN DEFAULT TRUE,
        criado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cursos_aulas (
        id SERIAL PRIMARY KEY,
        curso_id INTEGER NOT NULL REFERENCES cursos(id),
        modulo VARCHAR(200),
        titulo VARCHAR(200) NOT NULL,
        descricao TEXT,
        video_url VARCHAR(500),
        material_url VARCHAR(500),
        duracao_min INTEGER,
        ordem INTEGER DEFAULT 0,
        ativo BOOLEAN DEFAULT TRUE
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cursos_aulas_curso ON cursos_aulas(curso_id);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cursos_liberacoes (
        id SERIAL PRIMARY KEY,
        curso_id INTEGER NOT NULL REFERENCES cursos(id),
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        data_fim DATE,
        data_criacao TIMESTAMP DEFAULT NOW(),
        UNIQUE (curso_id, cliente_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cursos_progresso (
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
        aula_id INTEGER NOT NULL REFERENCES cursos_aulas(id),
        concluida_em TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (usuario_id, aula_id)
      );
    `);

    // Pontapé inicial (uma vez): os dois cursos da grade v0.1 como rascunho, um item por módulo
    const migCursos = await pool.query(
      `INSERT INTO migracoes_app (nome) VALUES ('cursos_iniciais') ON CONFLICT DO NOTHING RETURNING nome;`
    );
    if (migCursos.rowCount) {
      const cursosIniciais = [
        ['IA no Desenvolvimento ABAP', 'Ler, entender, alterar e testar código SAP com IA e governança.', 'abap', '~20 h', [
          'Por que mudar a forma de desenvolver', 'Fundamentos de IA para quem programa',
          'Segurança e dados: a conversa com a TI', 'Montando o ambiente', 'Lendo o sistema com IA',
          'Entendendo e documentando legado', 'Alterando código com governança',
          'Classes, includes, funções e formulários', 'Qualidade: testes e revisão',
          'Casos Brasil: fiscal', 'Trabalhando em equipe e em escala', 'Projeto final']],
        ['IA para Consultores Funcionais SAP', 'Consultar o sistema, entender os Z, especificar e testar sem depender do ABAP.', 'func', '~16 h', [
          'O funcional com superpoderes', 'Fundamentos e segurança', 'Consultando o SAP em linguagem natural',
          'Entendendo os desenvolvimentos Z', 'Especificações com IA', 'Testes', 'Suporte e AMS',
          'Trilhas por módulo (SD, MM, FI/CO, Fiscal BR)', 'Documentação e comunicação', 'Projeto final']]
      ];
      for (const [i, [titulo, descricao, capa, carga, modulos]] of cursosIniciais.entries()) {
        const c = await pool.query(
          `INSERT INTO cursos (empresa_id, titulo, descricao, capa, carga_horaria, status, ordem)
           VALUES (1, $1, $2, $3, $4, 'rascunho', $5) RETURNING id`, [titulo, descricao, capa, carga, i]);
        for (const [j, m] of modulos.entries()) {
          await pool.query(
            `INSERT INTO cursos_aulas (curso_id, modulo, titulo, ordem) VALUES ($1, $2, $3, $4)`,
            [c.rows[0].id, `Módulo ${j + 1}`, m, j]);
        }
      }
      console.log('Migração cursos_iniciais: cursos ABAP e Funcional criados como rascunho');
    }

    // 22. Faturamento mensal: contratos recorrentes → faturas → NFS-e (Asaas, padrão nacional)
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email_financeiro VARCHAR(255);`);
    await pool.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(50);`);

    //     Configuração por empresa. A chave da API do Asaas NÃO fica aqui: vem de ASAAS_API_KEY (Render > Environment)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financeiro_config (
        empresa_id INTEGER PRIMARY KEY,
        instrucoes_pagamento TEXT,
        pix_chave VARCHAR(150),
        codigo_servico VARCHAR(20),
        nome_servico VARCHAR(255),
        aliquota_iss NUMERIC(5,2) DEFAULT 0,
        email_copia VARCHAR(255),
        dias_lembrete INTEGER DEFAULT 3,
        vencimento_mes_seguinte BOOLEAN DEFAULT TRUE,
        data_atualizacao TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contratos (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        descricao VARCHAR(255) NOT NULL,
        descricao_servico TEXT NOT NULL,
        valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
        dia_vencimento INTEGER NOT NULL DEFAULT 10 CHECK (dia_vencimento BETWEEN 1 AND 28),
        data_inicio DATE NOT NULL,
        data_fim DATE,
        indice_reajuste VARCHAR(10) DEFAULT 'nenhum',
        mes_reajuste INTEGER CHECK (mes_reajuste BETWEEN 1 AND 12),
        emitir_nfse BOOLEAN NOT NULL DEFAULT TRUE,
        codigo_servico VARCHAR(20),
        nome_servico VARCHAR(255),
        aliquota_iss NUMERIC(5,2),
        reter_iss BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(20) NOT NULL DEFAULT 'ativo',
        observacoes TEXT,
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contratos_emp ON contratos(empresa_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contratos_cliente ON contratos(cliente_id);`);

    //     status: rascunho (gerada, aguardando revisão) → aberta (aprovada/enviada) → paga | cancelada
    //     "vencida" não é status gravado: é aberta com vencimento < hoje
    await pool.query(`
      CREATE TABLE IF NOT EXISTS faturas (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        cliente_id INTEGER NOT NULL REFERENCES clientes(id),
        contrato_id INTEGER REFERENCES contratos(id),
        competencia DATE NOT NULL,
        descricao TEXT NOT NULL,
        valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
        data_vencimento DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'rascunho',
        data_aprovacao TIMESTAMP,
        data_pagamento DATE,
        valor_pago NUMERIC(12,2),
        forma_pagamento VARCHAR(30),
        observacoes TEXT,
        emitir_nfse BOOLEAN NOT NULL DEFAULT TRUE,
        codigo_servico VARCHAR(20),
        nome_servico VARCHAR(255),
        aliquota_iss NUMERIC(5,2),
        reter_iss BOOLEAN NOT NULL DEFAULT FALSE,
        nfse_status VARCHAR(20) NOT NULL DEFAULT 'nao_emitida',
        nfse_asaas_id VARCHAR(50),
        nfse_numero VARCHAR(50),
        nfse_codigo_verificacao VARCHAR(100),
        nfse_pdf_url TEXT,
        nfse_xml_url TEXT,
        nfse_erro TEXT,
        email_enviado_em TIMESTAMP,
        lembrete_enviado_em TIMESTAMP,
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_emp_comp ON faturas(empresa_id, competencia);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_cliente ON faturas(cliente_id);`);
    // Um contrato gera no máximo uma fatura (não cancelada) por competência
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_faturas_contrato_comp
      ON faturas(contrato_id, competencia) WHERE contrato_id IS NOT NULL AND status <> 'cancelada';
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_nfse_asaas ON faturas(nfse_asaas_id);`);

    //     Retenções federais feitas pelo tomador (% sobre o valor da nota). Valor a receber = valor - retenções.
    //     Em contratos ficam NULL = usar o padrão da configuração.
    for (const t of ['financeiro_config', 'contratos', 'faturas']) {
      for (const r of ['ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins', 'ret_inss']) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${r} NUMERIC(5,2);`);
      }
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
