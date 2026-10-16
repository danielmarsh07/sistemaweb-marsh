// ============================================================================
// Catálogo de tools do assistente de voz.
//
// Cada tool tem:
//   - definition: schema JSON no formato OpenAI function tool
//   - run(ctx, args): implementação. ctx = { empresa_id, usuario_id, tipo, nome }
//                     vem SEMPRE do JWT — o LLM nunca passa empresa_id.
//
// Regras de segurança aplicadas em todas as tools:
//   1. Queries parametrizadas (nunca interpolação)
//   2. empresa_id e usuario_id vêm do ctx (JWT), nunca dos args
//   3. Resultados truncados pra não estourar contexto/custo do LLM
// ============================================================================

const pool = require('../db');
const { validarDocumento, validarCNPJ } = require('./validacao');
const { notificarNovoChamado, notificarNovoAtendimento } = require('./email');
const fat = require('./faturamento');
const cp = require('./contas-pagar');
const { TOOLS_GESTAO } = require('./assistente-tools-gestao');
const { TOOLS_SISTEMA } = require('./assistente-tools-sistema');
const { TOOLS_ACOES } = require('./assistente-tools-acoes');

const MAX_LIST_ROWS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtData(d) {
  if (!d) return null;
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// "Hoje" no fuso de Brasília (o servidor roda em UTC: depois das 21h já seria amanhã)
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const NOME_CLIENTE = `COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome)`;
const NOME_FORNECEDOR = `COALESCE(NULLIF(fo.nome_fantasia, ''), NULLIF(fo.nome, ''), fo.razao_social)`;

// Acha um registro pelo nome: exato (sem caixa) primeiro, depois aproximado.
// Retorna { item } | { erro, opcoes }
async function resolverPorNome(sqlBase, params, nome, rotulo) {
  const exato = await pool.query(`${sqlBase} AND LOWER(nome_resolvido) = LOWER($${params.length + 1}) LIMIT 2`, [...params, nome]);
  if (exato.rows.length === 1) return { item: exato.rows[0] };
  const aprox = await pool.query(`${sqlBase} AND nome_resolvido ILIKE $${params.length + 1} ORDER BY nome_resolvido LIMIT 6`,
    [...params, `%${nome}%`]);
  if (aprox.rows.length === 1) return { item: aprox.rows[0] };
  if (aprox.rows.length > 1) {
    return { erro: `Há mais de uma opção de ${rotulo} parecida com "${nome}". Pergunte qual.`, opcoes: aprox.rows.map(r => r.nome_resolvido) };
  }
  return { erro: `Não encontrei ${rotulo} "${nome}".` };
}

const sqlCategoria = `SELECT * FROM (SELECT id, nome AS nome_resolvido, COALESCE(grupo_dre, 'despesa_administrativa') AS grupo_dre
  FROM categorias_transacao WHERE empresa_id = $1 AND tipo = 'saída' AND ativo = TRUE) x WHERE TRUE`;
const sqlFornecedor = `SELECT * FROM (SELECT fo.id, ${NOME_FORNECEDOR} AS nome_resolvido
  FROM fornecedores fo WHERE fo.empresa_id = $1 AND fo.ativo = TRUE) x WHERE TRUE`;
const sqlContaFinanceira = `SELECT * FROM (SELECT id, nome AS nome_resolvido, tipo, dia_fechamento, dia_vencimento
  FROM contas_financeiras WHERE empresa_id = $1 AND ativo = TRUE) x WHERE TRUE`;

// Mês da fatura do cartão para uma compra feita hoje: compra depois do fechamento cai na fatura seguinte
function mesFaturaCartao(cartao, hoje) {
  if (!cartao.dia_fechamento) return null;
  const dia = Number(hoje.slice(8, 10));
  const fechamento = dia < cartao.dia_fechamento ? hoje.slice(0, 7) : cp.mesDe(cp.somarMeses(`${hoje.slice(0, 7)}-01`, 1));
  return cartao.dia_vencimento > cartao.dia_fechamento ? fechamento : cp.mesDe(cp.somarMeses(`${fechamento}-01`, 1));
}

// ---------------------------------------------------------------------------
// TOOL: data_hoje — helper pro modelo entender datas relativas
// ---------------------------------------------------------------------------

const data_hoje = {
  definition: {
    type: 'function',
    function: {
      name: 'data_hoje',
      description: 'Retorna a data atual (formato YYYY-MM-DD, fuso de Brasília) e o nome do dia da semana. Use sempre que precisar resolver expressões como "hoje", "ontem", "esse mês", "no dia 5".',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async () => {
    const hoje = hojeISO();
    const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    return {
      data: hoje,
      dia_semana: dias[new Date(`${hoje}T12:00:00Z`).getUTCDay()],
      mes: Number(hoje.slice(5, 7)),
      ano: Number(hoje.slice(0, 4))
    };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: financeiro (faturas, contas a pagar, caixa) — só administradores
// ---------------------------------------------------------------------------

const consultar_saldo = {
  definition: {
    type: 'function',
    function: {
      name: 'consultar_saldo',
      description: 'Saldo em caixa hoje (saldo inicial + recebimentos − pagamentos já feitos) e o que está em aberto: a receber de clientes, a pagar, vencidos e o que vence nos próximos 7 dias. Use para "qual meu saldo?", "quanto tenho em caixa?", "quanto tenho a pagar?".',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async (ctx) => {
    const hoje = hojeISO();
    const config = await fat.carregarConfig(ctx.empresa_id);
    const dataSaldo = config.saldo_inicial_data ? fmtData(config.saldo_inicial_data) : null;
    const [mov, receber, pagar] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(v), 0)::float AS total FROM (
           SELECT valor_pago AS v, data_pagamento AS dia FROM faturas WHERE empresa_id = $1 AND status = 'paga'
           UNION ALL
           SELECT -valor_pago, data_pagamento FROM contas_pagar WHERE empresa_id = $1 AND status = 'paga') m
         WHERE dia >= $2::date AND dia <= $3::date`, [ctx.empresa_id, dataSaldo || '1900-01-01', hoje]),
      pool.query(
        `SELECT COALESCE(SUM(l) FILTER (WHERE data_vencimento >= $2::date), 0)::float AS a_vencer,
                COUNT(*) FILTER (WHERE data_vencimento >= $2::date)::int AS qtd_a_vencer,
                COALESCE(SUM(l) FILTER (WHERE data_vencimento < $2::date), 0)::float AS vencido,
                COUNT(*) FILTER (WHERE data_vencimento < $2::date)::int AS qtd_vencido
         FROM (SELECT f.data_vencimento, ${fat.sqlValorLiquido('f')} AS l FROM faturas f
               WHERE f.empresa_id = $1 AND f.status = 'aberta') x`, [ctx.empresa_id, hoje]),
      pool.query(
        `SELECT COALESCE(SUM(valor) FILTER (WHERE data_vencimento >= $2::date), 0)::float AS a_vencer,
                COUNT(*) FILTER (WHERE data_vencimento >= $2::date)::int AS qtd_a_vencer,
                COALESCE(SUM(valor) FILTER (WHERE data_vencimento < $2::date), 0)::float AS vencido,
                COUNT(*) FILTER (WHERE data_vencimento < $2::date)::int AS qtd_vencido,
                COALESCE(SUM(valor) FILTER (WHERE data_vencimento BETWEEN $2::date AND $2::date + 7), 0)::float AS proximos_7_dias,
                COUNT(*) FILTER (WHERE data_vencimento BETWEEN $2::date AND $2::date + 7)::int AS qtd_proximos_7_dias
         FROM contas_pagar WHERE empresa_id = $1 AND status = 'aberta'`, [ctx.empresa_id, hoje])
    ]);
    // a_vencer e vencido são partes separadas; total_em_aberto = a soma das duas
    const comTotal = x => ({ total_em_aberto: r2(x.a_vencer + x.vencido), ...x });
    return {
      data: hoje,
      saldo_em_caixa: r2(Number(config.saldo_inicial || 0) + mov.rows[0].total),
      saldo_inicial_configurado: !!dataSaldo,
      aviso: dataSaldo ? null : 'O saldo inicial do caixa não foi informado (Fluxo de caixa → Saldo inicial); o saldo é só a soma dos movimentos.',
      a_receber_de_clientes: comTotal(receber.rows[0]),
      a_pagar: comTotal(pagar.rows[0])
    };
  }
};

const resumo_financeiro_mes = {
  definition: {
    type: 'function',
    function: {
      name: 'resumo_financeiro_mes',
      description: 'Resumo de um mês: faturado e recebido dos clientes, contas do mês (total, pagas, em aberto), receita recorrente dos contratos (MRR) e o resultado de caixa (recebido − pago). Use para "como foi outubro?", "quanto faturei esse mês?".',
      parameters: {
        type: 'object',
        properties: { mes: { type: 'string', description: 'AAAA-MM. Se omitido, o mês atual.' } },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const mes = args.mes || hojeISO().slice(0, 7);
    if (!cp.competenciaValida(mes)) return { erro: 'Mês no formato AAAA-MM.' };
    const ini = `${mes}-01`;
    const [fx, cx, mrr] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(valor) FILTER (WHERE competencia = $2::date AND status IN ('aberta','paga')), 0)::float AS faturado_bruto,
                COUNT(*) FILTER (WHERE competencia = $2::date AND status IN ('aberta','paga'))::int AS qtd_faturas,
                COALESCE(SUM(valor_pago) FILTER (WHERE status = 'paga' AND data_pagamento >= $2::date
                  AND data_pagamento < $2::date + INTERVAL '1 month'), 0)::float AS recebido_no_mes,
                COUNT(*) FILTER (WHERE status = 'rascunho')::int AS rascunhos_para_aprovar
         FROM faturas WHERE empresa_id = $1`, [ctx.empresa_id, ini]),
      pool.query(
        `SELECT COALESCE(SUM(valor) FILTER (WHERE status <> 'cancelada' AND vence_no_mes), 0)::float AS contas_do_mes,
                COUNT(*) FILTER (WHERE status <> 'cancelada' AND vence_no_mes)::int AS qtd_contas_do_mes,
                COALESCE(SUM(valor) FILTER (WHERE status = 'aberta' AND vence_no_mes), 0)::float AS em_aberto_do_mes,
                COALESCE(SUM(valor_pago) FILTER (WHERE status = 'paga' AND data_pagamento >= $2::date
                  AND data_pagamento < $2::date + INTERVAL '1 month'), 0)::float AS pago_no_mes
         FROM (SELECT *, (data_vencimento >= $2::date AND data_vencimento < $2::date + INTERVAL '1 month') AS vence_no_mes
               FROM contas_pagar WHERE empresa_id = $1) x`, [ctx.empresa_id, ini]),
      pool.query(
        `SELECT COALESCE(SUM(valor), 0)::float AS mrr, COUNT(*)::int AS contratos_ativos
         FROM contratos WHERE empresa_id = $1 AND status = 'ativo' AND (data_fim IS NULL OR data_fim >= CURRENT_DATE)`,
        [ctx.empresa_id])
    ]);
    const f = fx.rows[0], c = cx.rows[0];
    return {
      mes, faturamento: f, contas_a_pagar: c, contratos: mrr.rows[0],
      resultado_de_caixa_no_mes: r2(f.recebido_no_mes - c.pago_no_mes)
    };
  }
};

const listar_contas_pagar = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_contas_pagar',
      description: 'Lista contas a pagar (até 30) e o total real que casa com o filtro. Sem mês: as contas em aberto (vencidas e a vencer). Use antes de dar baixa ("paguei a conta de luz") para achar o id.',
      parameters: {
        type: 'object',
        properties: {
          mes: { type: 'string', description: 'AAAA-MM — contas que vencem nesse mês' },
          status: { type: 'string', enum: ['aberta', 'paga', 'vencida', 'todas'], description: 'Padrão: aberta' },
          busca: { type: 'string', description: 'Termo na descrição, fornecedor ou categoria' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id, hojeISO()];
    const where = ['cp.empresa_id = $1', `cp.status <> 'cancelada'`];
    const status = args.status || 'aberta';
    if (status === 'aberta') where.push(`cp.status = 'aberta'`);
    else if (status === 'paga') where.push(`cp.status = 'paga'`);
    else if (status === 'vencida') where.push(`cp.status = 'aberta' AND cp.data_vencimento < $2::date`);
    if (args.mes) {
      if (!cp.competenciaValida(args.mes)) return { erro: 'Mês no formato AAAA-MM.' };
      params.push(`${args.mes}-01`);
      where.push(`cp.data_vencimento >= $${params.length}::date AND cp.data_vencimento < $${params.length}::date + INTERVAL '1 month'`);
    }
    if (args.busca) {
      params.push(`%${args.busca}%`);
      where.push(`(cp.descricao ILIKE $${params.length} OR cat.nome ILIKE $${params.length} OR ${NOME_FORNECEDOR} ILIKE $${params.length})`);
    }
    const from = `FROM contas_pagar cp
      LEFT JOIN categorias_transacao cat ON cat.id = cp.categoria_id
      LEFT JOIN fornecedores fo ON fo.id = cp.fornecedor_id
      LEFT JOIN contas_financeiras cf ON cf.id = cp.conta_financeira_id
      WHERE ${where.join(' AND ')}`;
    const [tot, r] = await Promise.all([
      // $2 (hoje) entra no SELECT para o Postgres saber o tipo mesmo quando o filtro não o usa
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(cp.valor), 0)::float AS soma, $2::date AS hoje ${from}`, params),
      pool.query(
        `SELECT cp.id, cp.descricao, cp.valor::float AS valor, to_char(cp.data_vencimento, 'YYYY-MM-DD') AS vencimento,
                cp.status, to_char(cp.data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
                (cp.status = 'aberta' AND cp.data_vencimento < $2::date) AS vencida,
                cat.nome AS categoria, ${NOME_FORNECEDOR} AS fornecedor, cf.nome AS conta_ou_cartao,
                cp.parcela, cp.total_parcelas
         ${from} ORDER BY cp.data_vencimento, cp.descricao LIMIT ${MAX_LIST_ROWS}`, params)
    ]);
    return { total_real: tot.rows[0].n, soma_valor: r2(tot.rows[0].soma), mostrados: r.rows.length, contas: r.rows };
  }
};

const listar_faturas = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_faturas',
      description: 'Lista faturas dos clientes (até 30) e o total real. Valor líquido = o que o cliente paga (descontadas as retenções). Use para "quem está me devendo?", "faturas de outubro", "a fatura da Multi-Rio foi paga?".',
      parameters: {
        type: 'object',
        properties: {
          competencia: { type: 'string', description: 'AAAA-MM — mês de referência do serviço' },
          status: { type: 'string', enum: ['rascunho', 'aberta', 'vencida', 'paga', 'cancelada'] },
          cliente: { type: 'string', description: 'Nome aproximado do cliente' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id, hojeISO()];
    const where = ['f.empresa_id = $1'];
    if (args.status === 'vencida') where.push(`f.status = 'aberta' AND f.data_vencimento < $2::date`);
    else if (args.status) { params.push(args.status); where.push(`f.status = $${params.length}`); }
    if (args.competencia) {
      if (!cp.competenciaValida(args.competencia)) return { erro: 'Competência no formato AAAA-MM.' };
      params.push(`${args.competencia}-01`); where.push(`f.competencia = $${params.length}::date`);
    }
    if (args.cliente) {
      params.push(`%${args.cliente}%`);
      where.push(`(c.razao_social ILIKE $${params.length} OR c.nome ILIKE $${params.length} OR c.nome_fantasia ILIKE $${params.length})`);
    }
    const from = `FROM faturas f JOIN clientes c ON c.id = f.cliente_id WHERE ${where.join(' AND ')}`;
    const [tot, r] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(${fat.sqlValorLiquido('f')}), 0)::float AS soma, $2::date AS hoje ${from}`, params),
      pool.query(
        `SELECT f.id, ${NOME_CLIENTE} AS cliente, to_char(f.competencia, 'YYYY-MM') AS competencia, f.descricao,
                f.valor::float AS valor_nota, ${fat.sqlValorLiquido('f')} AS valor_liquido,
                to_char(f.data_vencimento, 'YYYY-MM-DD') AS vencimento, f.status,
                (f.status = 'aberta' AND f.data_vencimento < $2::date) AS vencida,
                to_char(f.data_pagamento, 'YYYY-MM-DD') AS data_pagamento, f.nfse_status
         ${from} ORDER BY f.data_vencimento DESC, cliente LIMIT ${MAX_LIST_ROWS}`, params)
    ]);
    return { total_real: tot.rows[0].n, soma_valor_liquido: r2(tot.rows[0].soma), mostrados: r.rows.length, faturas: r.rows };
  }
};

const resumo_despesas = {
  definition: {
    type: 'function',
    function: {
      name: 'resumo_despesas',
      description: 'Despesas agrupadas por categoria em um período (pela competência, sem as canceladas), da maior para a menor. Ideal para "onde gastei mais em setembro?".',
      parameters: {
        type: 'object',
        properties: {
          mes_de: { type: 'string', description: 'AAAA-MM (inclusivo). Padrão: mês atual.' },
          mes_ate: { type: 'string', description: 'AAAA-MM (inclusivo). Padrão: igual a mes_de.' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const de = args.mes_de || hojeISO().slice(0, 7);
    const ate = args.mes_ate || de;
    if (!cp.competenciaValida(de) || !cp.competenciaValida(ate)) return { erro: 'Meses no formato AAAA-MM.' };
    const r = await pool.query(
      `SELECT COALESCE(cat.nome, 'Sem categoria') AS categoria, cp.natureza, SUM(cp.valor)::float AS total, COUNT(*)::int AS qtd
       FROM contas_pagar cp LEFT JOIN categorias_transacao cat ON cat.id = cp.categoria_id
       WHERE cp.empresa_id = $1 AND cp.status <> 'cancelada'
         AND cp.competencia >= $2::date AND cp.competencia < $3::date + INTERVAL '1 month'
       GROUP BY 1, 2 ORDER BY total DESC`, [ctx.empresa_id, `${de}-01`, `${ate}-01`]);
    return {
      periodo: { mes_de: de, mes_ate: ate },
      total: r2(r.rows.reduce((s, x) => s + x.total, 0)),
      por_categoria: r.rows.map(x => ({ ...x, total: r2(x.total) }))
    };
  }
};

const listar_categorias_despesa = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_categorias_despesa',
      description: 'Lista as categorias de despesa ativas (cada uma define a linha da DRE). Use quando não tiver certeza da categoria de um lançamento.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async (ctx) => {
    await cp.garantirCategoriasPadrao(ctx.empresa_id);
    const r = await pool.query(
      `SELECT nome, COALESCE(grupo_dre, 'despesa_administrativa') AS grupo_dre FROM categorias_transacao
       WHERE empresa_id = $1 AND tipo = 'saída' AND ativo = TRUE ORDER BY nome`, [ctx.empresa_id]);
    return { categorias: r.rows.map(c => ({ nome: c.nome, linha_dre: cp.GRUPOS_DRE[c.grupo_dre] || c.grupo_dre })) };
  }
};

const listar_contas_financeiras = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_contas_financeiras',
      description: 'Lista as contas bancárias e cartões de crédito cadastrados (de onde sai o pagamento).',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async (ctx) => {
    const r = await pool.query(
      `SELECT nome, tipo, dia_fechamento, dia_vencimento FROM contas_financeiras
       WHERE empresa_id = $1 AND ativo = TRUE ORDER BY tipo, nome`, [ctx.empresa_id]);
    return { contas: r.rows };
  }
};

const lancar_conta_pagar = {
  definition: {
    type: 'function',
    function: {
      name: 'lancar_conta_pagar',
      description: 'Lança uma despesa em contas a pagar (é o que alimenta o fluxo de caixa e a DRE). Única, parcelada ou assinatura mensal recorrente. A categoria precisa existir (use o nome exato de listar_categorias_despesa). Para parcelada ou recorrente, confirme com o usuário antes e passe usuario_confirmou=true.',
      parameters: {
        type: 'object',
        properties: {
          descricao: { type: 'string', description: 'Ex.: "Conta de luz", "Contador outubro"' },
          valor: { type: 'number', description: 'Valor em reais (de cada parcela, se parcelada)' },
          categoria: { type: 'string', description: 'Nome da categoria de despesa' },
          data_vencimento: { type: 'string', description: 'YYYY-MM-DD. Padrão: hoje. Ignorado no cartão (vence no dia da fatura).' },
          competencia: { type: 'string', description: 'AAAA-MM a que a despesa se refere (DRE). Padrão: mês do vencimento (no cartão, mês atual).' },
          fornecedor: { type: 'string', description: 'Opcional. Nome do fornecedor já cadastrado.' },
          conta_ou_cartao: { type: 'string', description: 'Opcional. Nome da conta ou cartão (listar_contas_financeiras).' },
          mes_fatura: { type: 'string', description: 'Só no cartão: AAAA-MM da fatura. Se omitido, calcula pelo dia de fechamento.' },
          tipo: { type: 'string', enum: ['unica', 'parcelada', 'recorrente'], description: 'Padrão: unica. recorrente = assinatura mensal (lança 12 meses e renova sozinha).' },
          total_parcelas: { type: 'number', description: 'Só parcelada: total de parcelas (2 a 120)' },
          parcela_inicial: { type: 'number', description: 'Só parcelada: parcela atual (padrão 1)' },
          ja_paga: { type: 'boolean', description: 'true se o usuário disse que já pagou' },
          data_pagamento: { type: 'string', description: 'YYYY-MM-DD, quando ja_paga. Padrão: hoje.' },
          natureza: { type: 'string', enum: ['empresa', 'pessoal'], description: 'pessoal = gasto pessoal do sócio (sai da DRE). Padrão: empresa.' },
          usuario_confirmou: { type: 'boolean', description: 'Obrigatório true em parcelada/recorrente, depois de o usuário confirmar.' }
        },
        required: ['descricao', 'valor', 'categoria'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const tipo = args.tipo || 'unica';
    if (tipo !== 'unica' && args.usuario_confirmou !== true) {
      return { erro: 'Lançamento parcelado ou recorrente precisa de confirmação. Resuma (valor, quantidade, primeiro vencimento) e pergunte antes.' };
    }
    const hoje = hojeISO();
    await cp.garantirCategoriasPadrao(ctx.empresa_id);
    const cat = await resolverPorNome(sqlCategoria, [ctx.empresa_id], String(args.categoria || ''), 'categoria');
    if (cat.erro) {
      const todas = await pool.query(
        `SELECT nome FROM categorias_transacao WHERE empresa_id = $1 AND tipo = 'saída' AND ativo = TRUE ORDER BY nome`, [ctx.empresa_id]);
      return { erro: cat.erro, categorias_disponiveis: cat.opcoes || todas.rows.map(r => r.nome) };
    }
    let fornecedor = null;
    if (args.fornecedor) {
      const fo = await resolverPorNome(sqlFornecedor, [ctx.empresa_id], args.fornecedor, 'fornecedor');
      if (fo.erro) return { erro: `${fo.erro} Lance sem fornecedor ou cadastre-o antes.`, opcoes: fo.opcoes };
      fornecedor = fo.item;
    }
    let conta = null;
    if (args.conta_ou_cartao) {
      const cf = await resolverPorNome(sqlContaFinanceira, [ctx.empresa_id], args.conta_ou_cartao, 'conta ou cartão');
      if (cf.erro) return { erro: cf.erro, opcoes: cf.opcoes };
      conta = cf.item;
    }
    const cartao = conta && conta.tipo === 'cartao';
    const mesFatura = cartao ? (args.mes_fatura || mesFaturaCartao(conta, hoje)) : null;
    if (cartao && !mesFatura) return { erro: `O cartão ${conta.nome_resolvido} não tem dia de fechamento: pergunte em qual fatura (mês) entra.` };
    const vencimento = args.data_vencimento || hoje;

    const b = {
      descricao: args.descricao, valor: args.valor, categoria_id: cat.item.id,
      competencia: args.competencia || (cartao ? hoje.slice(0, 7) : String(vencimento).slice(0, 7)),
      data_vencimento: vencimento, mes_fatura: mesFatura,
      fornecedor_id: fornecedor && fornecedor.id, conta_financeira_id: conta && conta.id,
      tipo, total_parcelas: args.total_parcelas, parcela_inicial: args.parcela_inicial,
      ja_paga: !!args.ja_paga, data_pagamento: args.ja_paga ? (args.data_pagamento || hoje) : null,
      natureza: args.natureza || 'empresa',
      observacoes: 'Lançada pelo assistente de voz.'
    };
    const r = await cp.criarContaPagar(ctx.empresa_id, ctx.usuario_id, b);
    if (r.erro) return { erro: r.erro };
    return {
      sucesso: true, mensagem: r.mensagem, lancamentos: r.qtd,
      descricao: b.descricao, valor: Number(b.valor), categoria: cat.item.nome_resolvido,
      primeiro_vencimento: r.vencimento, competencia: b.competencia, ja_paga: b.ja_paga,
      fornecedor: fornecedor && fornecedor.nome_resolvido, conta_ou_cartao: conta && conta.nome_resolvido,
      _ui_refresh: ['contas-pagar', 'fluxo-caixa', 'dashboard']
    };
  }
};

const pagar_conta = {
  definition: {
    type: 'function',
    function: {
      name: 'pagar_conta',
      description: 'Dá baixa (marca como paga) numa conta a pagar em aberto. Pegue o id com listar_contas_pagar; se houver mais de uma candidata, pergunte qual.',
      parameters: {
        type: 'object',
        properties: {
          conta_id: { type: 'number' },
          data_pagamento: { type: 'string', description: 'YYYY-MM-DD. Padrão: hoje.' },
          valor_pago: { type: 'number', description: 'Padrão: o valor da conta' },
          forma_pagamento: { type: 'string', enum: ['transferencia', 'pix', 'boleto', 'cartao', 'debito', 'dinheiro'] }
        },
        required: ['conta_id'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const c = await pool.query(
      `SELECT id, descricao, valor::float AS valor, status FROM contas_pagar WHERE id = $1 AND empresa_id = $2`,
      [args.conta_id, ctx.empresa_id]);
    if (!c.rows.length) return { erro: 'Conta não encontrada.' };
    if (c.rows[0].status !== 'aberta') return { erro: `A conta "${c.rows[0].descricao}" não está em aberto (${c.rows[0].status}).` };
    const data = args.data_pagamento || hojeISO();
    if (!cp.dataValida(data)) return { erro: 'Data do pagamento inválida.' };
    const valor = Number(args.valor_pago || c.rows[0].valor);
    if (!(valor > 0)) return { erro: 'Valor pago deve ser maior que zero.' };
    const ok = await cp.darBaixaConta(ctx.empresa_id, ctx.usuario_id, c.rows[0].id,
      { data_pagamento: data, valor_pago: valor, forma_pagamento: args.forma_pagamento });
    if (!ok) return { erro: 'Só contas em aberto recebem baixa.' };
    return { sucesso: true, descricao: c.rows[0].descricao, valor_pago: valor, data_pagamento: data,
      _ui_refresh: ['contas-pagar', 'fluxo-caixa', 'dashboard'] };
  }
};

const registrar_recebimento = {
  definition: {
    type: 'function',
    function: {
      name: 'registrar_recebimento',
      description: 'Registra que o cliente pagou uma fatura em aberto (baixa manual, ex.: transferência). Pegue o id com listar_faturas status "aberta"; se houver mais de uma candidata, pergunte qual.',
      parameters: {
        type: 'object',
        properties: {
          fatura_id: { type: 'number' },
          data_pagamento: { type: 'string', description: 'YYYY-MM-DD. Padrão: hoje.' },
          valor_recebido: { type: 'number', description: 'Padrão: o valor líquido da fatura' }
        },
        required: ['fatura_id'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const f = await fat.carregarFatura(args.fatura_id, ctx.empresa_id);
    if (!f) return { erro: 'Fatura não encontrada.' };
    if (f.status !== 'aberta') return { erro: `Essa fatura não está em aberto (${f.status}).` };
    const data = args.data_pagamento || hojeISO();
    if (!cp.dataValida(data)) return { erro: 'Data do pagamento inválida.' };
    const valor = Number(args.valor_recebido || f.valor_liquido);
    if (!(valor > 0)) return { erro: 'Valor recebido deve ser maior que zero.' };
    const ok = await fat.registrarPagamento(f.id, ctx.empresa_id, ctx.usuario_id,
      { data_pagamento: data, valor_pago: valor, forma_pagamento: 'transferencia' });
    if (!ok) return { erro: 'Só faturas em aberto recebem baixa.' };
    return { sucesso: true, fatura_id: f.id, valor_recebido: valor, data_pagamento: data,
      _ui_refresh: ['faturamento', 'fluxo-caixa', 'dashboard'] };
  }
};

const criar_categoria_despesa = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_categoria_despesa',
      description: 'Cria uma categoria de despesa. CRÍTICO: só chame APÓS o usuário confirmar explicitamente (nome e linha da DRE). Depois, normalmente chame lancar_conta_pagar com ela.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          grupo_dre: { type: 'string', enum: Object.keys(cp.GRUPOS_DRE), description: Object.entries(cp.GRUPOS_DRE).map(([k, v]) => `${k} = ${v}`).join('; ') },
          usuario_confirmou: { type: 'boolean', description: 'true SOMENTE se o usuário respondeu afirmativamente à pergunta de confirmação.' }
        },
        required: ['nome', 'grupo_dre', 'usuario_confirmou'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (args.usuario_confirmou !== true) return { erro: 'Criar categoria requer confirmação explícita do usuário.' };
    const nome = String(args.nome || '').trim();
    if (!nome || nome.length > 120) return { erro: 'Nome da categoria inválido.' };
    if (!cp.GRUPOS_DRE[args.grupo_dre]) return { erro: 'Linha da DRE inválida.' };
    try {
      await pool.query(
        `INSERT INTO categorias_transacao (empresa_id, nome, tipo, grupo_dre, criado_por_usuario_id)
         VALUES ($1, $2, 'saída', $3, $4)`, [ctx.empresa_id, nome, args.grupo_dre, ctx.usuario_id]);
    } catch (err) {
      if (err.code === '23505') return { erro: `Já existe uma categoria de despesa "${nome}".` };
      throw err;
    }
    return { sucesso: true, categoria: nome, linha_dre: cp.GRUPOS_DRE[args.grupo_dre], _ui_refresh: ['categorias-despesa'] };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: clientes
// ---------------------------------------------------------------------------

const listar_clientes = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_clientes',
      description: 'Lista clientes da empresa (no máximo 30). Aceita filtro por nome.',
      parameters: {
        type: 'object',
        properties: {
          busca: { type: 'string', description: 'Termo buscado no nome/razão social' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1 AND ativo = TRUE';
    if (args.busca) {
      where += ` AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2)`;
      params.push(`%${args.busca}%`);
    }
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cpf_cnpj, telefone, email, status
       FROM clientes ${where}
       ORDER BY COALESCE(razao_social, nome)
       LIMIT ${MAX_LIST_ROWS}`,
      params
    );
    return { total: r.rows.length, clientes: r.rows };
  }
};

const buscar_cliente = {
  definition: {
    type: 'function',
    function: {
      name: 'buscar_cliente',
      description: 'Busca um cliente específico por nome aproximado ou CPF/CNPJ. Retorna o melhor match com todos os dados.',
      parameters: {
        type: 'object',
        properties: {
          termo: { type: 'string', description: 'Nome, razão social ou documento' }
        },
        required: ['termo'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cpf_cnpj,
              email, telefone, celular, cidade, uf, status, segmento, porte
       FROM clientes
       WHERE empresa_id = $1 AND ativo = TRUE
         AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2 OR cpf_cnpj = $3)
       ORDER BY COALESCE(razao_social, nome)
       LIMIT 5`,
      [ctx.empresa_id, `%${args.termo}%`, args.termo.replace(/\D/g, '')]
    );
    if (r.rows.length === 0) return { encontrados: 0, clientes: [] };
    return { encontrados: r.rows.length, clientes: r.rows };
  }
};

const criar_cliente = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_cliente',
      description: 'Cria um novo cliente. Apenas razao_social é obrigatório. CPF/CNPJ é validado se informado.',
      parameters: {
        type: 'object',
        properties: {
          razao_social: { type: 'string' },
          nome_fantasia: { type: 'string' },
          cpf_cnpj: { type: 'string' },
          email: { type: 'string' },
          telefone: { type: 'string' },
          celular: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string', description: 'Sigla do estado, 2 letras' }
        },
        required: ['razao_social'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (args.cpf_cnpj && !validarDocumento(args.cpf_cnpj)) {
      return { erro: 'CPF/CNPJ inválido. Verifique os dígitos.' };
    }
    if (args.cpf_cnpj) {
      const dup = await pool.query(
        "SELECT id FROM clientes WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g') AND empresa_id = $2 AND ativo = TRUE",
        [args.cpf_cnpj, ctx.empresa_id]
      );
      if (dup.rows.length > 0) return { erro: 'CPF/CNPJ já cadastrado para outro cliente.' };
    }
    const r = await pool.query(
      `INSERT INTO clientes (empresa_id, nome, razao_social, nome_fantasia, cpf_cnpj,
        email, telefone, celular, cidade, uf, status, criado_por_usuario_id, ativo)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'ativo', $10, TRUE)
       RETURNING id, razao_social, nome_fantasia`,
      [ctx.empresa_id, args.razao_social, args.nome_fantasia || null, args.cpf_cnpj || null,
       args.email || null, args.telefone || null, args.celular || null,
       args.cidade || null, args.uf || null, ctx.usuario_id]
    );
    return { sucesso: true, cliente: r.rows[0], _ui_refresh: ['clientes'] };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: fornecedores
// ---------------------------------------------------------------------------

const listar_fornecedores = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_fornecedores',
      description: 'Lista fornecedores da empresa (máx 30). Filtro opcional por nome.',
      parameters: {
        type: 'object',
        properties: { busca: { type: 'string' } },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE empresa_id = $1 AND ativo = TRUE';
    if (args.busca) {
      where += ` AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2)`;
      params.push(`%${args.busca}%`);
    }
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cnpj, ramo, telefone, email, status
       FROM fornecedores ${where}
       ORDER BY COALESCE(razao_social, nome)
       LIMIT ${MAX_LIST_ROWS}`,
      params
    );
    return { total: r.rows.length, fornecedores: r.rows };
  }
};

const buscar_fornecedor = {
  definition: {
    type: 'function',
    function: {
      name: 'buscar_fornecedor',
      description: 'Busca um fornecedor por nome aproximado ou CNPJ.',
      parameters: {
        type: 'object',
        properties: { termo: { type: 'string' } },
        required: ['termo'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const r = await pool.query(
      `SELECT id, COALESCE(razao_social, nome) AS nome, nome_fantasia, cnpj,
              ramo, email, telefone, celular, cidade, uf, status
       FROM fornecedores
       WHERE empresa_id = $1 AND ativo = TRUE
         AND (razao_social ILIKE $2 OR nome ILIKE $2 OR nome_fantasia ILIKE $2 OR cnpj = $3)
       ORDER BY COALESCE(razao_social, nome)
       LIMIT 5`,
      [ctx.empresa_id, `%${args.termo}%`, args.termo.replace(/\D/g, '')]
    );
    return { encontrados: r.rows.length, fornecedores: r.rows };
  }
};

const criar_fornecedor = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_fornecedor',
      description: 'Cria um novo fornecedor. Apenas razao_social é obrigatório. CNPJ é validado se informado.',
      parameters: {
        type: 'object',
        properties: {
          razao_social: { type: 'string' },
          nome_fantasia: { type: 'string' },
          cnpj: { type: 'string' },
          email: { type: 'string' },
          telefone: { type: 'string' },
          ramo: { type: 'string' },
          cidade: { type: 'string' },
          uf: { type: 'string' }
        },
        required: ['razao_social'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (args.cnpj && !validarCNPJ(args.cnpj)) return { erro: 'CNPJ inválido.' };
    if (args.cnpj) {
      const dup = await pool.query(
        'SELECT id FROM fornecedores WHERE cnpj = $1 AND empresa_id = $2 AND ativo = TRUE',
        [args.cnpj, ctx.empresa_id]
      );
      if (dup.rows.length > 0) return { erro: 'CNPJ já cadastrado.' };
    }
    const r = await pool.query(
      `INSERT INTO fornecedores (empresa_id, nome, razao_social, nome_fantasia, cnpj,
        email, telefone, ramo, cidade, uf, status, criado_por_usuario_id, ativo)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'ativo', $10, TRUE)
       RETURNING id, razao_social, nome_fantasia`,
      [ctx.empresa_id, args.razao_social, args.nome_fantasia || null, args.cnpj || null,
       args.email || null, args.telefone || null, args.ramo || null,
       args.cidade || null, args.uf || null, ctx.usuario_id]
    );
    return { sucesso: true, fornecedor: r.rows[0], _ui_refresh: ['fornecedores'] };
  }
};

// ---------------------------------------------------------------------------
// TOOLS: chamados
// ---------------------------------------------------------------------------

const listar_tecnologias_do_cliente = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_tecnologias_do_cliente',
      description: 'Retorna as tecnologias (produtos) que o cliente da conta atual tem habilitadas para abrir chamados. Use ANTES de criar um chamado quando o usuário do portal não disser explicitamente qual tecnologia é, ou quando precisar confirmar se ele tem mais de uma. Cada tecnologia retornada tem id, nome e categoria.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  run: async (ctx) => {
    if (ctx.tipo !== 'cliente') return { erro: 'Esta tool é apenas para usuários do portal do cliente.' };
    if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente.' };
    const r = await pool.query(
      `SELECT t.id, t.nome, t.categoria
       FROM cliente_tecnologias ct
       JOIN tecnologias t ON t.id = ct.tecnologia_id
       WHERE ct.cliente_id = $1 AND ct.status = 'ativo' AND t.ativo = TRUE
       ORDER BY t.nome`,
      [ctx.cliente_id]
    );
    return { total: r.rows.length, tecnologias: r.rows };
  }
};

const listar_chamados = {
  definition: {
    type: 'function',
    function: {
      name: 'listar_chamados',
      description: 'Lista chamados com filtros (status, prioridade, cliente, tecnologia, data). Retorna até 30 chamados (mais recentes primeiro) E o TOTAL real de chamados que casam com o filtro (mesmo se passar de 30). Use sempre que o usuário perguntar sobre quantidade, listagem, status, ou chamados de uma tecnologia/data específica. Quando o usuário citar uma tecnologia pelo nome ("telemedicina", "holter"), passe o nome em tecnologia_nome.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['aberto', 'em_andamento', 'aguardando_cliente', 'resolvido', 'fechado'] },
          prioridade: { type: 'string', enum: ['baixa', 'media', 'alta', 'critica'] },
          cliente_id: { type: 'number' },
          tecnologia_id: { type: 'number' },
          tecnologia_nome: { type: 'string', description: 'Nome aproximado da tecnologia (busca ILIKE em tecnologias.nome e tecnologias.categoria). Use quando o usuário falar "telemedicina", "holter", etc.' },
          data: { type: 'string', description: 'YYYY-MM-DD — chamados criados nesse dia exato' },
          data_de: { type: 'string', description: 'YYYY-MM-DD inclusivo (criados a partir desta data)' },
          data_ate: { type: 'string', description: 'YYYY-MM-DD inclusivo (criados até esta data)' },
          busca: { type: 'string', description: 'Termo livre em título/descrição' },
          origem: { type: 'string', enum: ['conector', 'portal'], description: 'conector = abertos pelo Conector SAP; portal = abertos no portal ou no painel.' },
          aprovacao: { type: 'string', enum: ['pendente', 'aprovado', 'recusado'], description: 'Aprovação do cliente (só chamados do Conector). pendente = aguardando o cliente aprovar.' }
        },
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'WHERE ch.empresa_id = $1 AND ch.ativo = TRUE';
    let i = 2;

    // Cliente: força filtro pelo cliente_id do JWT (não vê chamados de outros)
    if (ctx.tipo === 'cliente') {
      if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente.' };
      where += ` AND ch.cliente_id = $${i++}`;
      params.push(ctx.cliente_id);
    } else if (args.cliente_id) {
      where += ` AND ch.cliente_id = $${i++}`;
      params.push(args.cliente_id);
    }

    if (args.status) { where += ` AND ch.status = $${i++}`; params.push(args.status); }
    if (args.prioridade) { where += ` AND ch.prioridade = $${i++}`; params.push(args.prioridade); }
    if (args.tecnologia_id) { where += ` AND ch.tecnologia_id = $${i++}`; params.push(args.tecnologia_id); }
    if (args.tecnologia_nome) {
      where += ` AND EXISTS (
        SELECT 1 FROM tecnologias t
        WHERE t.id = ch.tecnologia_id AND (t.nome ILIKE $${i} OR t.categoria ILIKE $${i})
      )`;
      params.push(`%${args.tecnologia_nome}%`);
      i++;
    }
    if (args.data) {
      where += ` AND ch.data_criacao::date = $${i++}::date`;
      params.push(args.data);
    } else {
      if (args.data_de)  { where += ` AND ch.data_criacao::date >= $${i++}::date`; params.push(args.data_de); }
      if (args.data_ate) { where += ` AND ch.data_criacao::date <= $${i++}::date`; params.push(args.data_ate); }
    }
    if (args.busca) {
      where += ` AND (ch.titulo ILIKE $${i} OR ch.descricao ILIKE $${i})`;
      params.push(`%${args.busca}%`); i++;
    }
    if (args.origem === 'conector') where += " AND ch.origem = 'conector'";
    else if (args.origem === 'portal') where += ' AND ch.origem IS NULL';
    if (args.aprovacao) { where += ` AND ch.aprovacao_cliente = $${i++}`; params.push(args.aprovacao); }

    // Total real (sem LIMIT) pra IA poder responder "tenho 47 chamados abertos" mesmo que só mostre 30
    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM chamados ch ${where}`,
      params
    );
    const totalReal = totalRes.rows[0].total;

    const r = await pool.query(
      `SELECT ch.id, ch.titulo, ch.status, ch.prioridade, ch.data_criacao,
              ch.tecnologia_id, ch.origem, ch.aprovacao_cliente,
              COALESCE(c.razao_social, c.nome) AS cliente_nome,
              t.nome AS tecnologia_nome,
              t.categoria AS tecnologia_categoria
       FROM chamados ch
       LEFT JOIN clientes c ON c.id = ch.cliente_id
       LEFT JOIN tecnologias t ON t.id = ch.tecnologia_id
       ${where}
       ORDER BY ch.data_criacao DESC
       LIMIT ${MAX_LIST_ROWS}`,
      params
    );

    return {
      total_real: totalReal,
      mostrados: r.rows.length,
      filtros_aplicados: {
        status: args.status || null,
        prioridade: args.prioridade || null,
        tecnologia_nome: args.tecnologia_nome || null,
        tecnologia_id: args.tecnologia_id || null,
        data: args.data || null,
        data_de: args.data_de || null,
        data_ate: args.data_ate || null,
        cliente_id: args.cliente_id || (ctx.tipo === 'cliente' ? ctx.cliente_id : null),
        busca: args.busca || null,
        origem: args.origem || null,
        aprovacao: args.aprovacao || null
      },
      chamados: r.rows.map(c => ({
        id: c.id,
        titulo: c.titulo,
        status: c.status,
        prioridade: c.prioridade,
        data_criacao: c.data_criacao,
        cliente: c.cliente_nome,
        tecnologia: c.tecnologia_nome,
        categoria: c.tecnologia_categoria,
        origem: c.origem === 'conector' ? 'Conector SAP' : 'portal/painel',
        aprovacao_cliente: c.aprovacao_cliente
      }))
    };
  }
};

const criar_chamado = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_chamado',
      description: 'Abre um novo chamado. Para o tipo "cliente" o sistema vincula automaticamente ao cliente da conta (não passe cliente_id). Para admin/técnico, cliente_id é obrigatório (use buscar_cliente antes). Se a tecnologia for relevante para o chamado, passe tecnologia_id (no caso do cliente, ela precisa estar nas tecnologias liberadas para a conta dele).',
      parameters: {
        type: 'object',
        properties: {
          cliente_id: { type: 'number', description: 'Obrigatório para admin/técnico; ignorado para cliente (vem do JWT).' },
          tecnologia_id: { type: 'number', description: 'ID da tecnologia/produto do chamado. Para clientes do portal, OBRIGATÓRIO e deve vir de listar_tecnologias_do_cliente.' },
          titulo: { type: 'string' },
          descricao: { type: 'string', description: 'Telemedicina: use bloco estruturado (Paciente/Unidade/Exame/Problema). Outras tecnologias: descreva o que está acontecendo de forma clara.' },
          prioridade: { type: 'string', enum: ['baixa', 'media', 'alta', 'critica'] }
        },
        required: ['titulo'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    // Cliente: cliente_id sempre vem do JWT, ignora args
    let cliente_id;
    if (ctx.tipo === 'cliente') {
      if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente. Contate o administrador.' };
      cliente_id = ctx.cliente_id;
    } else {
      cliente_id = args.cliente_id;
      if (!cliente_id) return { erro: 'cliente_id é obrigatório para admins/técnicos. Use buscar_cliente antes.' };
    }

    const cliExiste = await pool.query(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [cliente_id, ctx.empresa_id]
    );
    if (cliExiste.rows.length === 0) return { erro: 'Cliente não encontrado.' };

    // Valida tecnologia_id (se informada)
    let tecnologia_id = args.tecnologia_id || null;
    if (tecnologia_id) {
      const tecCheck = await pool.query(
        `SELECT t.id, t.nome FROM tecnologias t
         WHERE t.id = $1 AND t.empresa_id = $2 AND t.ativo = TRUE`,
        [tecnologia_id, ctx.empresa_id]
      );
      if (tecCheck.rows.length === 0) return { erro: 'Tecnologia não encontrada nesta empresa.' };

      // Cliente: tecnologia precisa estar vinculada à conta dele
      if (ctx.tipo === 'cliente') {
        const link = await pool.query(
          `SELECT 1 FROM cliente_tecnologias
           WHERE cliente_id = $1 AND tecnologia_id = $2 AND status = 'ativo'`,
          [cliente_id, tecnologia_id]
        );
        if (link.rows.length === 0) {
          return { erro: `Sua conta não está habilitada para abrir chamados da tecnologia "${tecCheck.rows[0].nome}". Solicite a liberação ao administrador.` };
        }
      }
    }

    // Cliente DEVE informar tecnologia (regra de negócio do portal)
    if (ctx.tipo === 'cliente' && !tecnologia_id) {
      return { erro: 'tecnologia_id é obrigatória para abrir chamados pelo portal. Use listar_tecnologias_do_cliente antes.' };
    }

    const r = await pool.query(
      `INSERT INTO chamados (empresa_id, cliente_id, tecnologia_id, aberto_por_usuario_id,
        titulo, descricao, prioridade, status, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'aberto', TRUE)
       RETURNING id, titulo, descricao, status, prioridade, tecnologia_id, cliente_id`,
      [ctx.empresa_id, cliente_id, tecnologia_id, ctx.usuario_id,
       args.titulo, args.descricao || null, args.prioridade || 'media']
    );
    const chamado = r.rows[0];
    await pool.query(
      `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
       VALUES ($1, $2, $3, NULL, 'aberto', 'Chamado aberto via assistente de voz')`,
      [chamado.id, ctx.empresa_id, ctx.usuario_id]
    );

    // Dispara notificação de e-mail aos admins/técnicos da empresa (fire-and-forget)
    notificarNovoChamado({
      chamado,
      empresa_id: ctx.empresa_id,
      aberto_por: ctx.nome || 'Assistente Ivy'
    }).catch(err => console.error('[Ivy criar_chamado] falha ao notificar:', err.message));

    return { sucesso: true, chamado, _ui_refresh: ['chamados', 'dashboard'] };
  }
};

const criar_atendimento = {
  definition: {
    type: 'function',
    function: {
      name: 'criar_atendimento',
      description: 'Registra um atendimento (comentário, solução ou escalonamento) em um chamado existente. tipo="solucao" muda o chamado para resolvido.',
      parameters: {
        type: 'object',
        properties: {
          chamado_id: { type: 'number' },
          descricao: { type: 'string' },
          tipo: { type: 'string', enum: ['comentario', 'solucao', 'escalonamento'] },
          tempo_gasto_minutos: { type: 'number' }
        },
        required: ['chamado_id', 'descricao'],
        additionalProperties: false
      }
    }
  },
  run: async (ctx, args) => {
    if (ctx.tipo === 'cliente') args.tipo = 'comentario';

    // Busca chamado (incluindo titulo e cliente_id) — cliente só pode comentar nos próprios
    let q = 'SELECT id, status, titulo, cliente_id FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE';
    const params = [args.chamado_id, ctx.empresa_id];
    if (ctx.tipo === 'cliente') {
      if (!ctx.cliente_id) return { erro: 'Sua conta não está vinculada a um cliente.' };
      q += ' AND cliente_id = $3';
      params.push(ctx.cliente_id);
    }
    const ch = await pool.query(q, params);
    if (ch.rows.length === 0) return { erro: 'Chamado não encontrado.' };
    const chamado = ch.rows[0];

    const tipo = args.tipo || 'comentario';
    const r = await pool.query(
      `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, tempo_gasto_minutos, data_atendimento)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, tipo, descricao`,
      [args.chamado_id, ctx.usuario_id, tipo, args.descricao, args.tempo_gasto_minutos || 0]
    );
    const atendimento = r.rows[0];

    const statusAtual = chamado.status;
    if (tipo === 'solucao' && statusAtual !== 'resolvido') {
      await pool.query(
        `UPDATE chamados SET status = 'resolvido', data_fechamento = NOW() WHERE id = $1`,
        [args.chamado_id]
      );
    } else if (tipo !== 'solucao' && statusAtual === 'aberto') {
      await pool.query(
        `UPDATE chamados SET status = 'em_andamento' WHERE id = $1`,
        [args.chamado_id]
      );
    }

    // Notifica a outra parte (cliente comentou → avisa admins; admin comentou → avisa cliente)
    notificarNovoAtendimento({
      atendimento,
      chamado,
      remetente_tipo: ctx.tipo || 'admin_empresa',
      remetente_nome: ctx.nome || 'Assistente Ivy',
      empresa_id: ctx.empresa_id
    }).catch(err => console.error('[Ivy criar_atendimento] falha ao notificar:', err.message));

    return {
      sucesso: true,
      atendimento_id: atendimento.id,
      chamado_id: args.chamado_id,
      tipo,
      _ui_refresh: ['chamados']
    };
  }
};

// ---------------------------------------------------------------------------
// Catálogo + dispatcher
// ---------------------------------------------------------------------------

const TOOLS = {
  data_hoje,
  consultar_saldo,
  resumo_financeiro_mes,
  listar_contas_pagar,
  listar_faturas,
  resumo_despesas,
  listar_categorias_despesa,
  listar_contas_financeiras,
  lancar_conta_pagar,
  pagar_conta,
  registrar_recebimento,
  criar_categoria_despesa,
  listar_clientes,
  buscar_cliente,
  criar_cliente,
  listar_fornecedores,
  buscar_fornecedor,
  criar_fornecedor,
  listar_tecnologias_do_cliente,
  listar_chamados,
  criar_chamado,
  criar_atendimento,
  ...TOOLS_GESTAO,
  ...TOOLS_SISTEMA,
  ...TOOLS_ACOES
};

// Tools que clientes (usuários do portal) podem acessar via voz.
// Tudo mais é admin/técnico-only.
const TOOLS_PERMITIDAS_CLIENTE = new Set([
  'data_hoje',
  'listar_tecnologias_do_cliente',
  'criar_chamado',
  'listar_chamados',
  'criar_atendimento'
]);

// Financeiro: só administradores (mesma trava das rotas /api/financeiro)
const TOOLS_FINANCEIRO = new Set([
  'consultar_saldo', 'resumo_financeiro_mes', 'listar_contas_pagar', 'listar_faturas', 'resumo_despesas',
  'listar_categorias_despesa', 'listar_contas_financeiras', 'lancar_conta_pagar', 'pagar_conta',
  'registrar_recebimento', 'criar_categoria_despesa'
]);
// Gestão (comercial, contratos, DRE, caixa, marketing, alertas, licenças): só administradores, como as rotas
const TOOLS_SO_ADMIN = new Set([...TOOLS_FINANCEIRO, ...Object.keys(TOOLS_GESTAO), ...Object.keys(TOOLS_ACOES)]);
const ehAdmin = ctx => !!ctx && (ctx.tipo === 'admin_empresa' || ctx.tipo === 'admin_sistema');

function permitida(name, ctx) {
  // Super usuário (dono do sistema) usa tudo, inclusive a leitura livre do banco
  if (ctx && ctx.super_usuario) return true;
  if (TOOLS_SISTEMA[name]) return false;
  if (ctx && ctx.tipo === 'cliente') return TOOLS_PERMITIDAS_CLIENTE.has(name);
  if (TOOLS_SO_ADMIN.has(name)) return ehAdmin(ctx);
  return true;
}

function getToolDefinitions() {
  return Object.values(TOOLS).map(t => t.definition);
}

function getToolDefinitionsParaContexto(ctx) {
  return Object.entries(TOOLS)
    .filter(([name]) => permitida(name, ctx))
    .map(([, t]) => t.definition);
}

async function runTool(name, ctx, args) {
  const tool = TOOLS[name];
  if (!tool) return { erro: `Tool desconhecida: ${name}` };
  // Defense-in-depth: a lista enviada ao modelo já é filtrada, mas a execução confere de novo
  if (!permitida(name, ctx)) {
    return { erro: ctx && ctx.tipo === 'cliente'
      ? `Operação "${name}" não está disponível pelo portal do cliente.`
      : TOOLS_SISTEMA[name] ? 'Essa consulta é exclusiva do super usuário.'
      : (TOOLS_FINANCEIRO.has(name) ? 'O financeiro é restrito aos administradores.' : 'Essa consulta é restrita aos administradores.') };
  }
  try {
    return await tool.run(ctx, args || {});
  } catch (e) {
    return { erro: `Falha ao executar ${name}: ${e.message}` };
  }
}

module.exports = { getToolDefinitions, getToolDefinitionsParaContexto, runTool, TOOLS, ehAdmin, hojeISO };
