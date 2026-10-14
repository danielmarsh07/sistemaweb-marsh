const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const pool = require('./backend/db');

const app = express();

// Necessário no Render (e qualquer reverse proxy) para o req.ip refletir o IP real
// e o express-rate-limit funcionar corretamente.
app.set('trust proxy', 1);

// Middleware
app.use(cors());
// Chamado do Conector SAP traz a especificação em markdown (até 200 mil caracteres): limite maior só nessa rota
app.use('/api/licencas-conector/chamados', express.json({ limit: '2mb' }));
app.use(express.json());

// Toda resposta 5xx vira alerta (Sistema → Alertas + e-mail aos administradores, agrupado)
const { registrarAlerta, alertarErros500 } = require('./backend/services/alertas');
app.use(alertarErros500);

// Arquivos estáticos: três pastas servidas na raiz, então os endereços não dependem da pasta
//   frontend/site    → página institucional (/, /style.css, /landing-script.js)
//   frontend/sistema → dashboard, portal, login e proposta (/dashboard.html, /script.js...)
//   frontend/comum   → logo, tema, manifest e service worker (/img/..., /theme.js, /sw.js)
const FRONTEND = path.join(__dirname, 'frontend');
for (const pasta of ['comum', 'site', 'sistema']) {
  app.use(express.static(path.join(FRONTEND, pasta)));
}
//   frontend/site-classica → landing anterior (dark), guardada em /classica/ (noindex)
app.use('/classica', express.static(path.join(FRONTEND, 'site-classica'), { redirect: true }));

// Importar rotas
const authRoutes = require('./backend/routes/auth');
const empresasRoutes = require('./backend/routes/empresas');
const clientesRoutes = require('./backend/routes/clientes');
const fornecedoresRoutes = require('./backend/routes/fornecedores');
const transacoesRoutes = require('./backend/routes/transacoes');
const categoriasTransacaoRoutes = require('./backend/routes/categorias-transacao');
const tecnologiasRoutes = require('./backend/routes/tecnologias');
const chamadosRoutes = require('./backend/routes/chamados');
const atendimentosRoutes = require('./backend/routes/atendimentos');
const usuariosRoutes = require('./backend/routes/usuarios');
const anexosRoutes = require('./backend/routes/anexos');
const assistenteRoutes = require('./backend/routes/assistente');
const licencasRoutes = require('./backend/routes/licencas');
const licencasConectorRoutes = require('./backend/routes/licencas-conector');
const treinamentosRoutes = require('./backend/routes/treinamentos');
const financeiroRoutes = require('./backend/routes/financeiro');
const asaasWebhookRoutes = require('./backend/routes/asaas-webhook');
const comercialRoutes = require('./backend/routes/comercial');
const publicoRoutes = require('./backend/routes/publico');
const financeiroJobs = require('./backend/services/financeiro-jobs');
const autenticar = require('./backend/middleware/autenticar');
const apenasEquipe = require('./backend/middleware/apenas-equipe');
const alertasRoutes = require('./backend/routes/alertas');

// Rotas públicas
app.use('/api/auth', authRoutes);
app.use('/api/licencas-conector', licencasConectorRoutes); // conector SAP: autentica pela chave da licença
app.use('/api/asaas/webhook', asaasWebhookRoutes); // Asaas: autentica pelo header asaas-access-token
app.use('/api/publico', publicoRoutes); // lead do site e proposta por link (token), com limite de requisições

// Rotas protegidas
app.use('/api/empresas', autenticar, apenasEquipe, empresasRoutes); // portal do cliente não acessa
app.use('/api/clientes', autenticar, apenasEquipe, clientesRoutes); // portal do cliente não acessa
app.use('/api/fornecedores', autenticar, apenasEquipe, fornecedoresRoutes); // portal do cliente não acessa
app.use('/api/transacoes', autenticar, apenasEquipe, transacoesRoutes); // portal do cliente não acessa
app.use('/api/categorias-transacao', autenticar, apenasEquipe, categoriasTransacaoRoutes); // portal do cliente não acessa
app.use('/api/tecnologias', autenticar, tecnologiasRoutes);
app.use('/api/chamados', autenticar, chamadosRoutes);
app.use('/api/chamados', autenticar, anexosRoutes); // anexos sob /api/chamados/:id/anexos
app.use('/api/atendimentos', autenticar, atendimentosRoutes);
app.use('/api/usuarios', autenticar, usuariosRoutes);
app.use('/api/assistente', autenticar, assistenteRoutes);
app.use('/api/licencas', autenticar, licencasRoutes);
app.use('/api/treinamentos', autenticar, treinamentosRoutes);
app.use('/api/financeiro', autenticar, financeiroRoutes);
app.use('/api/comercial', autenticar, comercialRoutes);
app.use('/api/alertas', autenticar, alertasRoutes);

// Saúde: para monitor externo (UptimeRobot etc.). 200 = servidor e banco respondendo; 503 = banco fora.
app.get('/api/saude', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, banco: 'ok', em: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, banco: 'erro' });
  }
});

// Rota de teste
app.get('/api/ping', (req, res) => {
  res.json({ mensagem: 'Servidor está funcionando! ✅' });
});

// Rota raiz redireciona para landing
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND, 'site', 'index.html'));
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
    await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS nome_fantasia VARCHAR(255);`); // usado pela tela; faltava e travava o cadastro
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

    //     Titular, limite de máquinas e conexões SAP que o instalador recebe pré-preenchidas.
    //     conexoes = [{ sid, descricao, url, mandante, idioma }] — nunca usuário/senha do SAP
    await pool.query(`
      ALTER TABLE licencas
        ADD COLUMN IF NOT EXISTS titular_nome VARCHAR(150),
        ADD COLUMN IF NOT EXISTS titular_email VARCHAR(150),
        ADD COLUMN IF NOT EXISTS max_maquinas INTEGER,
        ADD COLUMN IF NOT EXISTS conexoes JSONB NOT NULL DEFAULT '[]';
    `);

    //     Máquinas ativadas pelo instalador (maquina_hash = SHA-256 gerado no cliente)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licencas_ativacoes (
        id SERIAL PRIMARY KEY,
        licenca_id INTEGER NOT NULL REFERENCES licencas(id),
        maquina_hash VARCHAR(64) NOT NULL,
        nome_maquina VARCHAR(100),
        usuario_windows VARCHAR(100),
        versao_conector VARCHAR(30),
        primeira_ativacao TIMESTAMP DEFAULT NOW(),
        ultima_validacao TIMESTAMP,
        revogada BOOLEAN DEFAULT FALSE,
        revogada_em TIMESTAMP,
        UNIQUE (licenca_id, maquina_hash)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_licencas_ativacoes_lic ON licencas_ativacoes(licenca_id);`);

    //     Instaladores do conector publicados pelo painel (zip no storage S3/R2; o portal entrega
    //     um link temporário só para quem tem licença ativa). O mais recente é o que vale.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conector_instaladores (
        id SERIAL PRIMARY KEY,
        versao VARCHAR(30) NOT NULL,
        storage_key VARCHAR(255) NOT NULL,
        nome_arquivo VARCHAR(150) NOT NULL,
        tamanho_bytes BIGINT NOT NULL,
        sha256 VARCHAR(64) NOT NULL,
        publicado_por_usuario_id INTEGER,
        data_publicacao TIMESTAMP DEFAULT NOW()
      );
    `);

    //     Chamados abertos pelo Conector SAP (ferramenta abrir_chamado): mesmo chamado do sistema, com a
    //     especificação em markdown e os dados do SAP. origem NULL = chamado do portal/painel (como antes).
    //     aprovacao_cliente: NULL (não se aplica) | pendente | aprovado | recusado — o gestor do cliente
    //     aprova no portal antes de a fábrica ABAP desenvolver (licencas.chamados_exigem_aprovacao).
    await pool.query(`
      ALTER TABLE chamados
        ADD COLUMN IF NOT EXISTS origem VARCHAR(20),
        ADD COLUMN IF NOT EXISTS licenca_id INTEGER,
        ADD COLUMN IF NOT EXISTS sid VARCHAR(10),
        ADD COLUMN IF NOT EXISTS modulo VARCHAR(20),
        ADD COLUMN IF NOT EXISTS tipo_demanda VARCHAR(30),
        ADD COLUMN IF NOT EXISTS pedido_original TEXT,
        ADD COLUMN IF NOT EXISTS especificacao TEXT,
        ADD COLUMN IF NOT EXISTS objetos_sap JSONB,
        ADD COLUMN IF NOT EXISTS solicitante_nome VARCHAR(150),
        ADD COLUMN IF NOT EXISTS solicitante_email VARCHAR(150),
        ADD COLUMN IF NOT EXISTS usuario_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS maquina_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS aprovacao_cliente VARCHAR(20),
        ADD COLUMN IF NOT EXISTS aprovado_por_usuario_id INTEGER,
        ADD COLUMN IF NOT EXISTS data_aprovacao TIMESTAMP;
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chamados_origem_aprov ON chamados(origem, aprovacao_cliente);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_chamados_licenca ON chamados(licenca_id) WHERE licenca_id IS NOT NULL;`);
    await pool.query(`ALTER TABLE licencas ADD COLUMN IF NOT EXISTS chamados_exigem_aprovacao BOOLEAN NOT NULL DEFAULT TRUE;`);

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

    // 23. Fase 2 do financeiro: contas a pagar, fluxo de caixa e DRE
    //     Categorias de despesa reaproveitam categorias_transacao (tipo 'saída') + a linha da DRE onde entram
    await pool.query(`ALTER TABLE categorias_transacao ADD COLUMN IF NOT EXISTS grupo_dre VARCHAR(30);`);
    //     Saldo bancário de partida do fluxo de caixa (saldo no início do dia saldo_inicial_data)
    await pool.query(`ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS saldo_inicial NUMERIC(12,2) DEFAULT 0;`);
    await pool.query(`ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS saldo_inicial_data DATE;`);

    //     status: aberta → paga | cancelada ("vencida" = aberta com vencimento < hoje)
    //     competencia = mês da despesa na DRE; data_pagamento = mês no fluxo de caixa
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contas_pagar (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        fornecedor_id INTEGER REFERENCES fornecedores(id),
        categoria_id INTEGER REFERENCES categorias_transacao(id),
        descricao VARCHAR(255) NOT NULL,
        documento VARCHAR(80),
        valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
        competencia DATE NOT NULL,
        data_vencimento DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'aberta',
        data_pagamento DATE,
        valor_pago NUMERIC(12,2),
        forma_pagamento VARCHAR(30),
        grupo_id UUID,
        parcela INTEGER,
        total_parcelas INTEGER,
        observacoes TEXT,
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contas_pagar_emp_venc ON contas_pagar(empresa_id, data_vencimento);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contas_pagar_emp_comp ON contas_pagar(empresa_id, competencia);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contas_pagar_grupo ON contas_pagar(grupo_id);`);

    // 24. Fase 3: funil de vendas (oportunidades) e propostas comerciais
    //     etapa: lead → qualificacao → proposta → negociacao → ganha | perdida
    //     Prospect sem cadastro: cliente_id NULL e os dados ficam em empresa_nome/contato_*
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oportunidades (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        cliente_id INTEGER REFERENCES clientes(id),
        titulo VARCHAR(255) NOT NULL,
        empresa_nome VARCHAR(255),
        contato_nome VARCHAR(255),
        contato_email VARCHAR(255),
        contato_telefone VARCHAR(50),
        interesse VARCHAR(60),
        origem VARCHAR(30) NOT NULL DEFAULT 'outro',
        etapa VARCHAR(20) NOT NULL DEFAULT 'lead',
        valor_mensal NUMERIC(12,2) NOT NULL DEFAULT 0,
        valor_unico NUMERIC(12,2) NOT NULL DEFAULT 0,
        probabilidade INTEGER CHECK (probabilidade BETWEEN 0 AND 100),
        previsao_fechamento DATE,
        data_fechamento DATE,
        motivo_perda VARCHAR(255),
        mensagem_origem TEXT,
        observacoes TEXT,
        contrato_id INTEGER REFERENCES contratos(id),
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_oportunidades_emp_etapa ON oportunidades(empresa_id, etapa);`);

    //     tipo: nota | etapa | proposta | sistema
    await pool.query(`
      CREATE TABLE IF NOT EXISTS oportunidades_historico (
        id SERIAL PRIMARY KEY,
        oportunidade_id INTEGER NOT NULL REFERENCES oportunidades(id) ON DELETE CASCADE,
        tipo VARCHAR(20) NOT NULL DEFAULT 'nota',
        texto TEXT NOT NULL,
        usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_oport_hist ON oportunidades_historico(oportunidade_id);`);

    //     status: rascunho → enviada → aceita | recusada. Itens em JSONB: [{descricao, tipo: mensal|unico, quantidade, valor_unitario}]
    //     token: link público para o cliente ver e responder (sem login)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS propostas (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        oportunidade_id INTEGER NOT NULL REFERENCES oportunidades(id) ON DELETE CASCADE,
        numero VARCHAR(20) NOT NULL,
        versao INTEGER NOT NULL DEFAULT 1,
        titulo VARCHAR(255) NOT NULL,
        introducao TEXT,
        escopo TEXT,
        condicoes TEXT,
        itens JSONB NOT NULL DEFAULT '[]',
        total_mensal NUMERIC(12,2) NOT NULL DEFAULT 0,
        total_unico NUMERIC(12,2) NOT NULL DEFAULT 0,
        validade DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'rascunho',
        token VARCHAR(64) UNIQUE,
        data_envio TIMESTAMP,
        data_visualizacao TIMESTAMP,
        data_resposta TIMESTAMP,
        resposta_nome VARCHAR(255),
        resposta_comentario TEXT,
        criado_por_usuario_id INTEGER,
        atualizado_por_usuario_id INTEGER,
        data_criacao TIMESTAMP DEFAULT NOW(),
        data_atualizacao TIMESTAMP
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_propostas_oport ON propostas(oportunidade_id);`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_propostas_numero ON propostas(empresa_id, numero, versao);`);

    // 25. Fase 4: cobrança PIX pelo Asaas (opcional, liga em financeiro_config.cobranca_pix)
    //     pix_status: pendente | pago | cancelado | estornado | erro. pix_qrcode = PNG em base64 (vai no portal)
    await pool.query(`ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS cobranca_pix BOOLEAN NOT NULL DEFAULT FALSE;`);
    for (const c of ['pix_asaas_id VARCHAR(50)', 'pix_status VARCHAR(20)', 'pix_payload TEXT', 'pix_qrcode TEXT',
                     'pix_url TEXT', 'pix_erro TEXT', 'pix_taxa NUMERIC(12,2)']) {
      await pool.query(`ALTER TABLE faturas ADD COLUMN IF NOT EXISTS ${c};`);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturas_pix_asaas ON faturas(pix_asaas_id);`);

    // 26. Controle mensal (substitui a planilha de custos): contas/cartões, natureza e recorrência
    //     tipo: conta | cartao. No cartão, o vencimento de cada lançamento = dia_vencimento da fatura do mês.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contas_financeiras (
        id SERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL DEFAULT 1,
        nome VARCHAR(80) NOT NULL,
        tipo VARCHAR(10) NOT NULL DEFAULT 'conta',
        dia_fechamento INTEGER CHECK (dia_fechamento BETWEEN 1 AND 31),
        dia_vencimento INTEGER CHECK (dia_vencimento BETWEEN 1 AND 31),
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        data_criacao TIMESTAMP DEFAULT NOW(),
        UNIQUE (empresa_id, nome)
      );
    `);
    //     natureza: empresa | pessoal (pessoal = retirada do sócio: entra no caixa, fica fora da DRE)
    //     recorrente: assinatura sem fim — a rotina horária mantém 12 meses à frente
    await pool.query(`ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS natureza VARCHAR(10) NOT NULL DEFAULT 'empresa';`);
    await pool.query(`ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS conta_financeira_id INTEGER REFERENCES contas_financeiras(id);`);
    await pool.query(`ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS recorrente BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contas_pagar_recorrente ON contas_pagar(grupo_id) WHERE recorrente;`);

    // 27. Alertas do sistema (falhas avisadas por e-mail e listadas em Sistema → Alertas)
    //     chave agrupa repetições do mesmo problema; e-mail no máximo a cada 6 h por chave
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alertas_sistema (
        id SERIAL PRIMARY KEY,
        chave VARCHAR(200) NOT NULL,
        nivel VARCHAR(10) NOT NULL DEFAULT 'erro',
        titulo VARCHAR(255) NOT NULL,
        detalhe TEXT,
        ocorrencias INTEGER NOT NULL DEFAULT 1,
        primeira_em TIMESTAMP NOT NULL DEFAULT NOW(),
        ultima_em TIMESTAMP NOT NULL DEFAULT NOW(),
        email_enviado_em TIMESTAMP,
        lido BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alertas_chave_aberto ON alertas_sistema(chave) WHERE NOT lido;`);

    // 28. Convite e redefinição de senha: guarda só o hash do token; vale uma vez e expira
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios_tokens (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo VARCHAR(12) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        expira_em TIMESTAMP NOT NULL,
        usado_em TIMESTAMP,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    //     Dados que aparecem no cabeçalho/rodapé da proposta (NULL = padrão do código)
    for (const c of ['prop_razao_social VARCHAR(255)', 'prop_cnpj VARCHAR(30)', 'prop_contato VARCHAR(255)',
                     'prop_apresentacao TEXT', 'prop_condicoes_padrao TEXT', 'prop_validade_dias INTEGER']) {
      await pool.query(`ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS ${c};`);
    }
    //     Tabela de preços do simulador do Conector SAP (Comercial). NULL/chave ausente = padrão do código
    //     (backend/services/precificacao-conector.js → PRECOS_PADRAO)
    await pool.query(`ALTER TABLE financeiro_config ADD COLUMN IF NOT EXISTS prop_precos_conector JSONB;`);

    console.log('✅ Banco de dados migrado e tabelas verificadas com sucesso!');
  } catch (err) {
    console.error('❌ Erro na migração do banco:', err.message);
    // O servidor sobe mesmo assim; o alerta avisa que alguma tabela/coluna pode não ter sido criada
    registrarAlerta({ chave: 'migracao', titulo: 'Falha ao atualizar o banco no deploy', detalhe: err.stack || err.message });
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    financeiroJobs.iniciar(); // NFS-e pendentes + lembretes de faturas vencidas, a cada hora
  });
}

// Erros que escaparam de todo tratamento: registra; o "uncaught" ainda encerra o processo (o Render reinicia)
process.on('unhandledRejection', err => {
  registrarAlerta({ chave: 'processo:promessa', titulo: 'Erro não tratado (promessa)', detalhe: (err && err.stack) || String(err) });
});
process.on('uncaughtException', err => {
  console.error('Erro fatal:', err);
  registrarAlerta({ chave: 'processo:fatal', titulo: 'Erro fatal: o servidor reiniciou', detalhe: err.stack || String(err) })
    .finally(() => setTimeout(() => process.exit(1), 3000));
});

iniciar();
