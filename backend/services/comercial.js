// Comercial (fase 3): regras compartilhadas entre as rotas internas (/api/comercial) e as públicas (/api/publico)
const pool = require('../db');
const conector = require('./precificacao-conector');

const BASE_URL = process.env.APP_URL || 'https://www.marshconsultoria.com.br';

const ETAPAS = {
  lead: { nome: 'Lead', prob: 10 },
  qualificacao: { nome: 'Qualificação', prob: 25 },
  proposta: { nome: 'Proposta', prob: 50 },
  negociacao: { nome: 'Negociação', prob: 75 },
  ganha: { nome: 'Ganha', prob: 100 },
  perdida: { nome: 'Perdida', prob: 0 }
};
const ETAPAS_ABERTAS = ['lead', 'qualificacao', 'proposta', 'negociacao'];

const ORIGENS = {
  site: 'Site', indicacao: 'Indicação', linkedin: 'LinkedIn', cliente_atual: 'Cliente atual',
  evento: 'Evento', prospeccao: 'Prospecção ativa', outro: 'Outro'
};

// Cabeçalho/rodapé da proposta quando a configuração está vazia
const PADRAO_PROPOSTA = {
  prop_razao_social: 'Marsh Consultoria e Desenvolvimento de Sistema LTDA',
  prop_cnpj: '42.567.285/0001-97',
  prop_contato: 'daniel.marsh@marshconsultoria.com.br · (21) 96780-6718 · Bragança Paulista – SP',
  prop_apresentacao: 'A Marsh Consultoria é especializada em consultoria SAP, integrações com SAP CPI, inteligência artificial aplicada e desenvolvimento de sistemas sob medida. Trabalhamos de forma próxima e orientada a resultado, com suporte contínuo depois da entrega.',
  prop_condicoes_padrao: '• Serviços mensais: faturados todo mês, com nota fiscal, vencimento no dia 10 do mês seguinte.\n• Serviços de valor único: 50% na aprovação e 50% na entrega.\n• Pagamento por transferência bancária ou PIX.\n• Reajuste anual pelo IPCA.',
  prop_validade_dias: 15
};

async function configProposta(empresa_id) {
  const r = await pool.query(
    `SELECT prop_razao_social, prop_cnpj, prop_contato, prop_apresentacao, prop_condicoes_padrao, prop_validade_dias
     FROM financeiro_config WHERE empresa_id = $1`, [empresa_id]);
  const c = r.rows[0] || {};
  return Object.fromEntries(Object.entries(PADRAO_PROPOSTA).map(([k, v]) => [k, c[k] ?? v]));
}

// Normaliza e soma os itens. Devolve { itens, total_mensal, total_unico } ou { erro }
function calcularItens(lista) {
  if (!Array.isArray(lista) || !lista.length) return { erro: 'Inclua ao menos um item na proposta.' };
  if (lista.length > 50) return { erro: 'Máximo de 50 itens.' };
  const itens = [];
  let mensal = 0, unico = 0;
  for (const it of lista) {
    const descricao = String(it.descricao || '').trim();
    const quantidade = Number(it.quantidade || 1);
    const valor = Number(it.valor_unitario);
    if (!descricao) return { erro: 'Todo item precisa de descrição.' };
    if (!['mensal', 'unico'].includes(it.tipo)) return { erro: 'Tipo do item: mensal ou único.' };
    if (!(quantidade > 0) || !(valor >= 0)) return { erro: `Quantidade/valor inválido em "${descricao}".` };
    const total = Math.round(quantidade * valor * 100) / 100;
    itens.push({ descricao: descricao.slice(0, 500), tipo: it.tipo, quantidade, valor_unitario: valor, total });
    if (it.tipo === 'mensal') mensal += total; else unico += total;
  }
  return { itens, total_mensal: Math.round(mensal * 100) / 100, total_unico: Math.round(unico * 100) / 100 };
}

// Próximo número do ano: AAAA-001, AAAA-002...
async function proximoNumero(client, empresa_id) {
  const ano = new Date().getFullYear();
  const r = await client.query(
    `SELECT COALESCE(MAX(SPLIT_PART(numero, '-', 2)::int), 0) + 1 AS n
     FROM propostas WHERE empresa_id = $1 AND numero LIKE $2`, [empresa_id, `${ano}-%`]);
  return `${ano}-${String(r.rows[0].n).padStart(3, '0')}`;
}

async function registrarHistorico(oportunidade_id, tipo, texto, usuario_id = null, client = pool) {
  await client.query(
    `INSERT INTO oportunidades_historico (oportunidade_id, tipo, texto, usuario_id) VALUES ($1, $2, $3, $4)`,
    [oportunidade_id, tipo, texto, usuario_id]);
}

// Muda a etapa, ajusta a probabilidade padrão e a data de fechamento, e registra no histórico
async function mudarEtapa(oportunidade_id, etapa, usuario_id, { motivo_perda, client = pool } = {}) {
  const r = await client.query('SELECT etapa FROM oportunidades WHERE id = $1', [oportunidade_id]);
  if (!r.rows.length || r.rows[0].etapa === etapa) return false;
  const fechada = etapa === 'ganha' || etapa === 'perdida';
  await client.query(
    `UPDATE oportunidades SET etapa = $1, probabilidade = $2,
       data_fechamento = ${fechada ? 'CURRENT_DATE' : 'NULL'},
       motivo_perda = $3, atualizado_por_usuario_id = $4, data_atualizacao = NOW()
     WHERE id = $5`,
    [etapa, ETAPAS[etapa].prob, etapa === 'perdida' ? (motivo_perda || null) : null, usuario_id, oportunidade_id]);
  await registrarHistorico(oportunidade_id, 'etapa',
    `${ETAPAS[r.rows[0].etapa].nome} → ${ETAPAS[etapa].nome}${etapa === 'perdida' && motivo_perda ? ` (${motivo_perda})` : ''}`,
    usuario_id, client);
  return true;
}

const COLUNAS_PROPOSTA = `
  p.id, p.oportunidade_id, p.numero, p.versao, p.titulo, p.introducao, p.escopo, p.condicoes, p.itens,
  p.total_mensal::float AS total_mensal, p.total_unico::float AS total_unico,
  to_char(p.validade, 'YYYY-MM-DD') AS validade, p.status, p.token,
  p.data_envio, p.data_visualizacao, p.data_resposta, p.resposta_nome, p.resposta_comentario,
  p.data_criacao, p.data_atualizacao, (p.validade < CURRENT_DATE) AS expirada`;

// Proposta + quem é o destinatário (cliente cadastrado ou prospect)
async function carregarProposta(where, params) {
  const r = await pool.query(
    `SELECT ${COLUNAS_PROPOSTA}, p.empresa_id,
            o.titulo AS oportunidade_titulo, o.etapa, o.cliente_id,
            COALESCE(NULLIF(c.razao_social, ''), NULLIF(c.nome_fantasia, ''), c.nome, o.empresa_nome) AS destinatario,
            COALESCE(o.contato_nome, c.responsavel_nome) AS contato_nome,
            COALESCE(o.contato_email, c.responsavel_email, c.email) AS contato_email
     FROM propostas p
     JOIN oportunidades o ON o.id = p.oportunidade_id
     LEFT JOIN clientes c ON c.id = o.cliente_id
     WHERE ${where}`, params);
  return r.rows[0] || null;
}

const linkPublico = token => `${BASE_URL}/proposta.html?t=${token}`;
const linkSistema = () => `${BASE_URL}/dashboard.html`;

// Resumo do funil: oportunidades abertas, valor do pipeline (cheio e ponderado pela probabilidade) e últimos 90 dias
async function resumoFunil(empresa_id) {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE etapa IN ('lead','qualificacao','proposta','negociacao'))::int AS abertas,
       COALESCE(SUM(valor_mensal) FILTER (WHERE etapa IN ('lead','qualificacao','proposta','negociacao')), 0)::float AS pipeline_mensal,
       COALESCE(SUM(valor_mensal * COALESCE(probabilidade, 0) / 100.0) FILTER (WHERE etapa IN ('lead','qualificacao','proposta','negociacao')), 0)::float AS ponderado_mensal,
       COALESCE(SUM(valor_unico) FILTER (WHERE etapa IN ('lead','qualificacao','proposta','negociacao')), 0)::float AS pipeline_unico,
       COUNT(*) FILTER (WHERE etapa = 'ganha' AND data_fechamento >= CURRENT_DATE - 90)::int AS ganhas_90,
       COUNT(*) FILTER (WHERE etapa = 'perdida' AND data_fechamento >= CURRENT_DATE - 90)::int AS perdidas_90,
       COALESCE(SUM(valor_mensal) FILTER (WHERE etapa = 'ganha' AND data_fechamento >= CURRENT_DATE - 90), 0)::float AS ganho_mensal_90,
       COUNT(*) FILTER (WHERE etapa = 'lead' AND origem = 'site' AND data_criacao >= NOW() - INTERVAL '7 days')::int AS leads_site_7
     FROM oportunidades WHERE empresa_id = $1`, [empresa_id]);
  return r.rows[0];
}

// Simulador de preço do Conector SAP: o cálculo é puro (precificacao-conector.js); aqui só carrega a tabela da empresa
async function precosConector(empresa_id) {
  const r = await pool.query('SELECT prop_precos_conector FROM financeiro_config WHERE empresa_id = $1', [empresa_id]);
  return conector.normalizarPrecos((r.rows[0] && r.rows[0].prop_precos_conector) || {}).precos;
}

// Valida as entradas (com a validade padrão do modelo da proposta) e calcula. Devolve { resultado, precos, cfg } ou { erro }
async function simularConector(b, empresa_id) {
  const [precos, cfg] = await Promise.all([precosConector(empresa_id), configProposta(empresa_id)]);
  const v = conector.validarEntradas({ validade_dias: cfg.prop_validade_dias, ...b }, precos);
  if (v.erro) return { erro: v.erro };
  return { resultado: conector.calcular(v.entradas, precos), precos, cfg };
}

module.exports = {
  ETAPAS, ETAPAS_ABERTAS, ORIGENS, PADRAO_PROPOSTA, COLUNAS_PROPOSTA,
  configProposta, calcularItens, proximoNumero, registrarHistorico, mudarEtapa, carregarProposta,
  linkPublico, linkSistema, resumoFunil, precosConector, simularConector
};
