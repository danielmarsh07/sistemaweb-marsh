// ============================================================================
// Tools de gestão da assistente de voz (Ivy): só CONSULTAS, só administradores.
// Comercial (funil, propostas, simulador do Conector), contratos, DRE e projeção de caixa,
// marketing (Instagram), alertas do sistema e licenças do Conector.
//
// Mesmas regras de assistente-tools.js: empresa_id sempre do ctx (JWT), queries
// parametrizadas, listas curtas. Os cálculos vêm dos mesmos serviços das telas,
// para a Ivy nunca dizer um número diferente do que aparece no sistema.
// ============================================================================

const pool = require('../db');
const com = require('./comercial');
const relatorios = require('./relatorios-financeiros');
const mk = require('./marketing');

const MAX = 10;
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const NOME_CLIENTE = `COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome)`;
const FUSO = mk.FUSO || 'America/Sao_Paulo';
// Colunas TIMESTAMP sem fuso guardam o horário da sessão do banco: converte para Brasília
const local = col => `((${col}) AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${FUSO}'`;
const semParametros = { type: 'object', properties: {}, additionalProperties: false };
const fn = (name, description, parameters = semParametros) => ({ type: 'function', function: { name, description, parameters } });

// ---------------------------------------------------------------------------
// COMERCIAL
// ---------------------------------------------------------------------------

const resumo_comercial = {
  definition: fn('resumo_comercial',
    'Resumo do funil de vendas: oportunidades abertas por etapa, valor do pipeline (mensal cheio e ponderado pela probabilidade, e valores únicos), ganhas e perdidas nos últimos 90 dias, leads do site na semana, propostas por status e as maiores oportunidades abertas. Use para "como está o comercial?", "quanto tenho no funil?", "quais oportunidades estão em negociação?".',
    {
      type: 'object',
      properties: {
        etapa: { type: 'string', enum: ['lead', 'qualificacao', 'proposta', 'negociacao', 'ganha', 'perdida'], description: 'Lista só as oportunidades desta etapa.' },
        busca: { type: 'string', description: 'Nome (aproximado) da empresa, do cliente ou do título da oportunidade.' }
      },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let filtro = `o.etapa IN ('lead','qualificacao','proposta','negociacao')`;
    if (args.etapa) { params.push(args.etapa); filtro = `o.etapa = $${params.length}`; }
    if (args.busca) {
      params.push(`%${args.busca}%`);
      filtro += ` AND (o.titulo ILIKE $${params.length} OR o.empresa_nome ILIKE $${params.length} OR ${NOME_CLIENTE} ILIKE $${params.length})`;
    }
    const [resumo, porEtapa, lista, propostas] = await Promise.all([
      com.resumoFunil(ctx.empresa_id),
      pool.query(
        `SELECT etapa, COUNT(*)::int AS qtd, COALESCE(SUM(valor_mensal), 0)::float AS valor_mensal
         FROM oportunidades WHERE empresa_id = $1 AND etapa IN ('lead','qualificacao','proposta','negociacao')
         GROUP BY etapa`, [ctx.empresa_id]),
      pool.query(
        `SELECT o.titulo, COALESCE(${NOME_CLIENTE}, o.empresa_nome) AS empresa, o.etapa,
                o.valor_mensal::float AS valor_mensal, o.valor_unico::float AS valor_unico, o.probabilidade,
                to_char(o.previsao_fechamento, 'YYYY-MM-DD') AS previsao_fechamento, o.origem,
                to_char(o.data_atualizacao, 'YYYY-MM-DD') AS atualizada_em
         FROM oportunidades o LEFT JOIN clientes c ON c.id = o.cliente_id
         WHERE o.empresa_id = $1 AND ${filtro}
         ORDER BY COALESCE(o.valor_mensal, 0) DESC, o.data_atualizacao DESC LIMIT ${MAX}`, params),
      pool.query(
        `SELECT CASE WHEN status = 'enviada' AND validade < CURRENT_DATE THEN 'expirada' ELSE status END AS status,
                COUNT(*)::int AS qtd
         FROM propostas WHERE empresa_id = $1 GROUP BY 1`, [ctx.empresa_id])
    ]);
    const ordem = ['lead', 'qualificacao', 'proposta', 'negociacao'];
    return {
      resumo: { ...resumo, ponderado_mensal: r2(resumo.ponderado_mensal) },
      abertas_por_etapa: ordem.map(e => porEtapa.rows.find(r => r.etapa === e) || { etapa: e, qtd: 0, valor_mensal: 0 }),
      propostas_por_status: Object.fromEntries(propostas.rows.map(r => [r.status, r.qtd])),
      oportunidades: lista.rows,
      obs: 'valor_mensal = recorrente por mês; valor_unico = implantação/serviço único. Ponderado = valor × probabilidade.'
    };
  }
};

const listar_propostas = {
  definition: fn('listar_propostas',
    'Lista propostas comerciais (até 10) com número, cliente, totais mensal e único, validade e status. "expirada" = enviada e com a validade vencida. Use para "quais propostas estão esperando resposta?", "a proposta da empresa X foi aceita?".',
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['rascunho', 'enviada', 'aceita', 'recusada', 'expirada'] },
        busca: { type: 'string', description: 'Cliente, empresa ou título (aproximado).' }
      },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const params = [ctx.empresa_id];
    let where = 'p.empresa_id = $1';
    if (args.status === 'expirada') where += ` AND p.status = 'enviada' AND p.validade < CURRENT_DATE`;
    else if (args.status === 'enviada') where += ` AND p.status = 'enviada' AND (p.validade IS NULL OR p.validade >= CURRENT_DATE)`;
    else if (args.status) { params.push(args.status); where += ` AND p.status = $${params.length}`; }
    if (args.busca) {
      params.push(`%${args.busca}%`);
      where += ` AND (p.titulo ILIKE $${params.length} OR o.empresa_nome ILIKE $${params.length} OR ${NOME_CLIENTE} ILIKE $${params.length})`;
    }
    const from = `FROM propostas p JOIN oportunidades o ON o.id = p.oportunidade_id LEFT JOIN clientes c ON c.id = o.cliente_id WHERE ${where}`;
    const [total, r] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n ${from}`, params),
      pool.query(
        `SELECT p.numero, p.versao, p.titulo, COALESCE(${NOME_CLIENTE}, o.empresa_nome) AS cliente,
                CASE WHEN p.status = 'enviada' AND p.validade < CURRENT_DATE THEN 'expirada' ELSE p.status END AS status,
                p.total_mensal::float AS total_mensal, p.total_unico::float AS total_unico,
                to_char(p.validade, 'YYYY-MM-DD') AS validade, to_char(p.data_envio, 'YYYY-MM-DD') AS enviada_em,
                (p.data_visualizacao IS NOT NULL) AS cliente_visualizou, to_char(p.data_resposta, 'YYYY-MM-DD') AS respondida_em
         ${from} ORDER BY COALESCE(p.data_envio, p.data_criacao) DESC LIMIT ${MAX}`, params)
    ]);
    return { total_real: total.rows[0].n, propostas: r.rows };
  }
};

const simular_preco_conector = {
  definition: fn('simular_preco_conector',
    'Calcula o preço do Conector SAP Marsh pela tabela de preços da empresa (o mesmo cálculo do Simulador). Informe quantos usuários funcionais e ABAP, o ciclo (anual é o padrão) e, se o usuário citar, sistemas SAP, porte da implantação e desconto. Use para "quanto fica o conector para 5 funcionais e 2 ABAP?".',
    {
      type: 'object',
      properties: {
        funcionais: { type: 'integer', description: 'Usuários funcionais (licença de leitura).' },
        abaps: { type: 'integer', description: 'Usuários ABAP (licença de desenvolvimento).' },
        ciclo: { type: 'string', enum: ['anual', 'mensal'] },
        modalidade: { type: 'string', enum: ['automatico', 'individual', 'empresa'], description: 'automatico = escolhe a mais barata (padrão).' },
        sistemas: { type: 'integer', description: 'Quantidade de sistemas SAP (padrão 1).' },
        porte: { type: 'string', enum: ['pequeno', 'medio', 'grande', 'nenhum'], description: 'Porte da implantação; nenhum = sem implantação.' },
        desconto_pct: { type: 'number', description: 'Desconto em % nas licenças.' }
      },
      required: ['funcionais', 'abaps'],
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const entrada = {};
    for (const k of ['funcionais', 'abaps', 'ciclo', 'modalidade', 'sistemas', 'porte', 'desconto_pct']) {
      if (args[k] !== undefined && args[k] !== null) entrada[k] = args[k];
    }
    const s = await com.simularConector(entrada, ctx.empresa_id);
    if (s.erro) return { erro: s.erro };
    const { resultado } = s;
    return {
      entradas: resultado.entradas,
      modalidade_escolhida: resultado.modalidade_escolhida,
      comparacao: resultado.comparacao,
      totais: resultado.totais,
      itens: resultado.itens.map(i => ({ grupo: i.grupo, descricao: i.descricao, tipo: i.tipo, quantidade: i.quantidade, total: i.total })),
      obs: 'total_mensal = mensalidade com desconto; total_unico = implantação; primeiro_ano = custo total do 1º ano.'
    };
  }
};

// ---------------------------------------------------------------------------
// CONTRATOS, DRE E PROJEÇÃO DE CAIXA
// ---------------------------------------------------------------------------

const listar_contratos = {
  definition: fn('listar_contratos',
    'Contratos recorrentes dos clientes (até 10) e o MRR (soma mensal dos ativos). Filtros: status, contratos que terminam nos próximos N dias, ou com reajuste num mês. Use para "quais contratos vencem este mês?", "quanto é minha receita recorrente?", "quem tem reajuste em janeiro?".',
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ativo', 'suspenso', 'encerrado'], description: 'Padrão: ativo.' },
        terminam_em_dias: { type: 'integer', description: 'Só contratos com data de fim entre hoje e hoje + N dias.' },
        mes_reajuste: { type: 'integer', description: '1 a 12: só contratos com reajuste neste mês.' },
        busca: { type: 'string', description: 'Nome do cliente (aproximado).' }
      },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const params = [ctx.empresa_id, args.status || 'ativo'];
    let where = 'ct.empresa_id = $1 AND ct.status = $2';
    if (args.terminam_em_dias) {
      params.push(Math.max(0, Math.min(3650, Number(args.terminam_em_dias))));
      where += ` AND ct.data_fim BETWEEN CURRENT_DATE AND CURRENT_DATE + $${params.length}::int`;
    }
    if (args.mes_reajuste) { params.push(Number(args.mes_reajuste)); where += ` AND ct.mes_reajuste = $${params.length}`; }
    if (args.busca) { params.push(`%${args.busca}%`); where += ` AND ${NOME_CLIENTE} ILIKE $${params.length}`; }
    const from = `FROM contratos ct JOIN clientes c ON c.id = ct.cliente_id WHERE ${where}`;
    const [tot, lista, mrr] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(ct.valor), 0)::float AS soma ${from}`, params),
      pool.query(
        `SELECT ${NOME_CLIENTE} AS cliente, ct.descricao, ct.valor::float AS valor_mensal, ct.dia_vencimento,
                to_char(ct.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(ct.data_fim, 'YYYY-MM-DD') AS data_fim,
                ct.indice_reajuste, ct.mes_reajuste, ct.status
         ${from} ORDER BY ct.data_fim NULLS LAST, ct.valor DESC LIMIT ${MAX}`, params),
      pool.query(
        `SELECT COALESCE(SUM(valor), 0)::float AS mrr, COUNT(*)::int AS ativos FROM contratos
         WHERE empresa_id = $1 AND status = 'ativo' AND (data_fim IS NULL OR data_fim >= CURRENT_DATE)`, [ctx.empresa_id])
    ]);
    return {
      total_real: tot.rows[0].n, soma_mensal_filtrados: r2(tot.rows[0].soma),
      mrr_total: r2(mrr.rows[0].mrr), contratos_ativos: mrr.rows[0].ativos,
      contratos: lista.rows
    };
  }
};

// Linhas principais da DRE (sem o detalhe por categoria), na ordem da tela
const LINHAS_DRE = ['receita_bruta', 'impostos_receita', 'receita_liquida', 'custo_servico', 'lucro_bruto',
  'despesa_pessoal', 'despesa_administrativa', 'despesa_comercial', 'resultado_operacional',
  'despesa_financeira', 'resultado_antes_ir', 'ir_csll', 'resultado_liquido'];

const consultar_dre = {
  definition: fn('consultar_dre',
    'DRE gerencial (regime de competência), igual à tela de DRE: receita bruta, impostos, receita líquida, custos, lucro bruto, despesas por grupo, resultado operacional e resultado líquido, mais as maiores categorias de despesa e as retiradas pessoais (fora do resultado). Período: um mês, ou o acumulado do ano até um mês. Despesas vêm com sinal negativo. Use para "qual meu lucro esse mês?", "como está a DRE do ano?", "qual a margem de setembro?".',
    {
      type: 'object',
      properties: {
        ano: { type: 'integer', description: 'Padrão: ano atual.' },
        mes: { type: 'integer', description: '1 a 12: só este mês.' },
        acumulado_ate_mes: { type: 'integer', description: '1 a 12: soma de janeiro até este mês. Sem mes nem acumulado: acumulado do ano até o mês atual.' }
      },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const hoje = hojeISO();
    const ano = Number(args.ano || hoje.slice(0, 4));
    if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return { erro: 'Ano inválido.' };
    const mesAtual = ano === Number(hoje.slice(0, 4)) ? Number(hoje.slice(5, 7)) : 12;
    let de = 1, ate = mesAtual;
    if (args.mes) { de = ate = Number(args.mes); }
    else if (args.acumulado_ate_mes) { ate = Number(args.acumulado_ate_mes); }
    if (!(de >= 1 && ate <= 12 && de <= ate)) return { erro: 'Mês de 1 a 12.' };
    const dre = await relatorios.montarDre(ctx.empresa_id, ano);
    const soma = valores => r2(valores.slice(de - 1, ate).reduce((s, v) => s + v, 0));
    const porChave = Object.fromEntries(dre.linhas.map(l => [l.chave, l]));
    const linhas = LINHAS_DRE.filter(k => porChave[k]).map(k => ({ linha: porChave[k].rotulo, valor: soma(porChave[k].valores) }));
    const receita = soma(porChave.receita_bruta.valores);
    const liquido = soma(porChave.resultado_liquido.valores);
    const categorias = dre.linhas.filter(l => l.tipo === 'categoria')
      .map(l => ({ categoria: l.rotulo, valor: soma(l.valores) }))
      .filter(c => c.valor !== 0).sort((a, b) => a.valor - b.valor).slice(0, 6);
    return {
      periodo: de === ate ? `${ano}-${String(de).padStart(2, '0')}` : `${ano}-01 a ${ano}-${String(ate).padStart(2, '0')}`,
      linhas,
      margem_liquida_pct: receita ? r2(liquido / receita * 100) : null,
      maiores_despesas: categorias,
      retiradas_pessoais_fora_do_resultado: soma(dre.fora_resultado.valores)
    };
  }
};

const projecao_caixa = {
  definition: fn('projecao_caixa',
    'Projeção do fluxo de caixa mês a mês a partir do mês atual (igual à tela Fluxo de caixa): entradas (recebido + a receber + contratos ainda sem fatura), saídas (pago + a pagar) e saldo no fim de cada mês, o mês de menor saldo e o que está vencido. Use para "como fica meu caixa nos próximos meses?", "vai faltar dinheiro?".',
    {
      type: 'object',
      properties: { meses: { type: 'integer', description: '1 a 12 (padrão 3).' } },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const meses = Math.max(1, Math.min(12, Number(args.meses || 3)));
    const fluxo = await relatorios.montarFluxoCaixa(ctx.empresa_id, hojeISO().slice(0, 7), meses);
    const lista = fluxo.meses.map(m => ({
      mes: m.mes,
      entradas: r2(m.entradas_realizadas + m.entradas_previstas + m.contratos_estimados),
      dos_quais_contratos_estimados: m.contratos_estimados,
      saidas: r2(m.saidas_realizadas + m.saidas_previstas),
      saldo_inicio: m.saldo_abertura,
      saldo_fim: m.saldo_final
    }));
    const menor = lista.reduce((a, b) => (b.saldo_fim < a.saldo_fim ? b : a), lista[0]);
    const vencidos = fluxo.proximos.filter(p => p.vencida);
    const somaTipo = tipo => r2(vencidos.filter(p => p.tipo === tipo).reduce((s, p) => s + Number(p.valor), 0));
    return {
      saldo_inicial_configurado: !!fluxo.saldo_inicial_data,
      meses: lista,
      menor_saldo: menor ? { mes: menor.mes, saldo: menor.saldo_fim } : null,
      vencidos: { a_receber: somaTipo('receber'), a_pagar: somaTipo('pagar'), qtd: vencidos.length },
      proximos_vencimentos: fluxo.proximos.filter(p => !p.vencida).slice(0, 8)
        .map(p => ({ tipo: p.tipo, data: p.data_vencimento, valor: r2(p.valor), descricao: p.descricao }))
    };
  }
};

// ---------------------------------------------------------------------------
// MARKETING (Instagram)
// ---------------------------------------------------------------------------

const resumo_marketing = {
  definition: fn('resumo_marketing',
    'Instagram da empresa: conta conectada e validade do token, seguidores e variação em 7 e 30 dias, próximos posts agendados, posts com erro de publicação, publicados no mês e os posts com mais alcance nos últimos 30 dias. Use para "qual o próximo post?", "quantos seguidores ganhei?", "qual post foi melhor?", "algum post falhou?".',
    {
      type: 'object',
      properties: { proximos: { type: 'integer', description: 'Quantos agendados listar (padrão 5).' } },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const emp = ctx.empresa_id;
    const conta = await mk.dadosConta(emp);
    const ultimo = (await pool.query(
      `SELECT seguidores FROM marketing_seguidores WHERE empresa_id = $1 ORDER BY data DESC LIMIT 1`, [emp])).rows[0];
    const atual = conta && conta.seguidores != null ? conta.seguidores : (ultimo ? ultimo.seguidores : null);
    // Mesma regra da tela: seguidores de hoje menos o último registro de N dias atrás (ou antes)
    const variacao = async dias => {
      const r = await pool.query(
        `SELECT seguidores FROM marketing_seguidores WHERE empresa_id = $1
           AND data <= (NOW() AT TIME ZONE '${FUSO}')::date - $2::int ORDER BY data DESC LIMIT 1`, [emp, dias]);
      return r.rows.length && atual != null ? atual - r.rows[0].seguidores : null;
    };
    const quando = col => `to_char(${col} AT TIME ZONE '${FUSO}', 'YYYY-MM-DD HH24:MI')`;
    const [v7, v30, agendados, erros, mes, top] = await Promise.all([
      variacao(7), variacao(30),
      pool.query(
        `SELECT titulo, tipo, ${quando('data_agendada')} AS quando FROM marketing_posts
         WHERE empresa_id = $1 AND status = 'agendado' ORDER BY data_agendada LIMIT $2`,
        [emp, Math.max(1, Math.min(MAX, Number(args.proximos || 5)))]),
      pool.query(
        `SELECT titulo, ${quando('data_agendada')} AS agendado_para, LEFT(ultimo_erro, 200) AS erro FROM marketing_posts
         WHERE empresa_id = $1 AND status = 'erro' ORDER BY data_atualizacao DESC LIMIT 5`, [emp]),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM marketing_posts WHERE empresa_id = $1 AND status = 'publicado'
           AND date_trunc('month', data_publicacao AT TIME ZONE '${FUSO}') = date_trunc('month', NOW() AT TIME ZONE '${FUSO}')`, [emp]),
      pool.query(
        `SELECT p.titulo, ${quando('p.data_publicacao')} AS publicado_em, mt.alcance, mt.curtidas, mt.comentarios,
                mt.salvamentos, mt.compartilhamentos, mt.interacoes
         FROM marketing_posts p
         JOIN LATERAL (SELECT * FROM marketing_metricas x WHERE x.post_id = p.id ORDER BY x.data DESC LIMIT 1) mt ON TRUE
         WHERE p.empresa_id = $1 AND p.status = 'publicado' AND p.data_publicacao >= NOW() - INTERVAL '30 days'
         ORDER BY mt.alcance DESC NULLS LAST LIMIT 3`, [emp])
    ]);
    return {
      conta: conta ? {
        usuario: conta.username ? `@${conta.username}` : null,
        conectada: !!conta.conectada,
        token_expira_em: conta.token_expira_em ? new Date(conta.token_expira_em).toLocaleDateString('sv-SE', { timeZone: FUSO }) : null
      } : { conectada: false },
      seguidores: atual, variacao_7_dias: v7, variacao_30_dias: v30,
      publicados_no_mes: mes.rows[0].n,
      proximos_agendados: agendados.rows,
      posts_com_erro: erros.rows,
      mais_alcance_30_dias: top.rows,
      obs: 'Horários em Brasília. Métricas são atualizadas uma vez por dia.'
    };
  }
};

// ---------------------------------------------------------------------------
// ALERTAS E LICENÇAS
// ---------------------------------------------------------------------------

const listar_alertas = {
  definition: fn('listar_alertas',
    'Alertas do sistema ainda não resolvidos (falhas de publicação, integração, e-mail, OpenAI, erros do servidor), com quantas vezes ocorreram e quando foi a última. Use para "tem algum alerta?", "deu algum erro no sistema?".'),
  run: async () => {
    const [r, n] = await Promise.all([
      pool.query(
        `SELECT nivel, titulo, LEFT(detalhe, 300) AS detalhe, ocorrencias,
                to_char(${local('ultima_em')}, 'YYYY-MM-DD HH24:MI') AS ultima_vez
         FROM alertas_sistema WHERE NOT lido ORDER BY ultima_em DESC LIMIT ${MAX}`),
      pool.query(`SELECT COUNT(*)::int AS n FROM alertas_sistema WHERE NOT lido`)
    ]);
    return { nao_resolvidos: n.rows[0].n, alertas: r.rows, obs: 'Para resolver, use Sistema → Alertas.' };
  }
};

const resumo_licencas = {
  definition: fn('resumo_licencas',
    'Licenças do Conector SAP: quantas ativas, suspensas e vencidas, as que vencem nos próximos dias (cliente, plano, usuários, data de fim, máquinas ativas, última validação) e os chamados do conector aguardando aprovação do cliente. Use para "quantas licenças ativas?", "quais licenças vencem este mês?", "a licença do cliente X está em dia?".',
    {
      type: 'object',
      properties: {
        vencem_em_dias: { type: 'integer', description: 'Janela para "vencendo" (padrão 30).' },
        busca: { type: 'string', description: 'Nome do cliente (aproximado): lista as licenças dele.' }
      },
      additionalProperties: false
    }),
  run: async (ctx, args) => {
    const emp = ctx.empresa_id;
    const dias = Math.max(1, Math.min(365, Number(args.vencem_em_dias || 30)));
    const params = [emp];
    let filtro;
    if (args.busca) { params.push(`%${args.busca}%`); filtro = `${NOME_CLIENTE} ILIKE $2`; }
    else { params.push(dias); filtro = `l.status = 'ativa' AND l.data_fim <= CURRENT_DATE + $2::int`; }
    const [cont, lista, aprov] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'ativa' AND data_fim >= CURRENT_DATE)::int AS ativas,
                COUNT(*) FILTER (WHERE status = 'ativa' AND data_fim < CURRENT_DATE)::int AS vencidas,
                COUNT(*) FILTER (WHERE status = 'suspensa')::int AS suspensas,
                COALESCE(SUM(max_usuarios) FILTER (WHERE status = 'ativa' AND data_fim >= CURRENT_DATE), 0)::int AS usuarios_licenciados
         FROM licencas WHERE empresa_id = $1 AND ativo = TRUE`, [emp]),
      pool.query(
        `SELECT ${NOME_CLIENTE} AS cliente, l.plano, l.max_usuarios, l.status,
                to_char(l.data_fim, 'YYYY-MM-DD') AS data_fim, (l.data_fim < CURRENT_DATE) AS vencida,
                (SELECT COUNT(*)::int FROM licencas_ativacoes a WHERE a.licenca_id = l.id AND NOT a.revogada) AS maquinas_ativas,
                to_char(${local('l.ultima_validacao')}, 'YYYY-MM-DD') AS ultima_validacao
         FROM licencas l JOIN clientes c ON c.id = l.cliente_id
         WHERE l.empresa_id = $1 AND l.ativo = TRUE AND ${filtro}
         ORDER BY l.data_fim LIMIT ${MAX}`, params),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM chamados WHERE empresa_id = $1 AND ativo = TRUE
           AND origem = 'conector' AND aprovacao_cliente = 'pendente'`, [emp])
    ]);
    return {
      ...cont.rows[0],
      [args.busca ? 'licencas_do_cliente' : `vencendo_em_${dias}_dias_ou_vencidas`]: lista.rows,
      chamados_conector_aguardando_aprovacao: aprov.rows[0].n
    };
  }
};

const TOOLS_GESTAO = {
  resumo_comercial, listar_propostas, simular_preco_conector,
  listar_contratos, consultar_dre, projecao_caixa,
  resumo_marketing, listar_alertas, resumo_licencas
};

module.exports = { TOOLS_GESTAO };
