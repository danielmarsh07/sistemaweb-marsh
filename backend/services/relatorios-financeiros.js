// Fluxo de caixa e DRE gerencial: usados pelas telas (/api/financeiro) e pela assistente de voz.
const pool = require('../db');
const fat = require('./faturamento');
const { GRUPOS_DRE, somarMeses, mesDe } = require('./contas-pagar');

const r2 = n => Math.round(Number(n || 0) * 100) / 100;

// ===== Fluxo de caixa =====
// Realizado = faturas recebidas e contas pagas (pela data do pagamento).
// Previsto  = faturas e contas em aberto (atrasadas caem no mês atual) + contratos ativos ainda sem fatura (estimado).
// inicio = 'AAAA-MM', meses = 1..24 (validados por quem chama)
async function montarFluxoCaixa(empresa, inicio, meses) {
  const ini = `${inicio}-01`;
  const fim = somarMeses(ini, meses); // exclusivo
  const config = await fat.carregarConfig(empresa);
  const base = (await pool.query(
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM') AS mes_atual,
            (SELECT to_char(saldo_inicial_data, 'YYYY-MM-DD') FROM financeiro_config WHERE empresa_id = $1) AS data_saldo`,
    [empresa])).rows[0];
  const saldoIni = Number(config.saldo_inicial || 0);
  const dataSaldo = base.data_saldo;
  const mesAtual = base.mes_atual;

  // Movimento realizado com sinal (entrada +, saída -), por dia
  const MOV_REALIZADO = `
    SELECT data_pagamento AS dia, valor_pago AS v FROM faturas WHERE empresa_id = $1 AND status = 'paga'
    UNION ALL
    SELECT data_pagamento, -valor_pago FROM contas_pagar WHERE empresa_id = $1 AND status = 'paga'`;

  const [realizado, previsto, antes, contratos, faturasExist] = await Promise.all([
    pool.query(
      `SELECT to_char(data_pagamento, 'YYYY-MM') AS mes, 'entrada' AS tipo, SUM(valor_pago)::float AS total
       FROM faturas WHERE empresa_id = $1 AND status = 'paga' AND data_pagamento >= $2::date AND data_pagamento < $3::date
       GROUP BY 1
       UNION ALL
       SELECT to_char(data_pagamento, 'YYYY-MM'), 'saida', SUM(valor_pago)::float
       FROM contas_pagar WHERE empresa_id = $1 AND status = 'paga' AND data_pagamento >= $2::date AND data_pagamento < $3::date
       GROUP BY 1`, [empresa, ini, fim]),
    pool.query(
      `SELECT to_char(GREATEST(f.data_vencimento, CURRENT_DATE), 'YYYY-MM') AS mes, 'entrada' AS tipo,
              SUM(${fat.sqlValorLiquido('f')})::float AS total
       FROM faturas f WHERE f.empresa_id = $1 AND f.status = 'aberta'
       GROUP BY 1
       UNION ALL
       SELECT to_char(GREATEST(data_vencimento, CURRENT_DATE), 'YYYY-MM'), 'saida', SUM(valor)::float
       FROM contas_pagar WHERE empresa_id = $1 AND status = 'aberta'
       GROUP BY 1`, [empresa]),
    // Saldo antes do 1º mês = saldo inicial + movimento entre a data do saldo e o início do período
    pool.query(
      `SELECT COALESCE(SUM(v) FILTER (WHERE dia < $2::date), 0)::float AS ate_inicio,
              COALESCE(SUM(v) FILTER (WHERE dia < $3::date), 0)::float AS ate_data_saldo
       FROM (${MOV_REALIZADO}) m`, [empresa, ini, dataSaldo || '1900-01-01']),
    pool.query(
      `SELECT ct.id, ct.valor::float AS valor, to_char(ct.data_inicio, 'YYYY-MM-DD') AS data_inicio,
              to_char(ct.data_fim, 'YYYY-MM-DD') AS data_fim, ct.reter_iss, ct.aliquota_iss::float AS aliquota_iss,
              ct.ret_ir::float AS ret_ir, ct.ret_csll::float AS ret_csll, ct.ret_pis::float AS ret_pis,
              ct.ret_cofins::float AS ret_cofins, ct.ret_inss::float AS ret_inss
       FROM contratos ct WHERE ct.empresa_id = $1 AND ct.status = 'ativo'`, [empresa]),
    pool.query(
      `SELECT contrato_id, to_char(competencia, 'YYYY-MM') AS comp FROM faturas
       WHERE empresa_id = $1 AND contrato_id IS NOT NULL AND status <> 'cancelada' AND competencia >= CURRENT_DATE - INTERVAL '2 months'`,
      [empresa])
  ]);

  const lista = [];
  for (let i = 0; i < meses; i++) lista.push(mesDe(somarMeses(ini, i)));
  const linha = Object.fromEntries(lista.map(m => [m, {
    mes: m, entradas_realizadas: 0, saidas_realizadas: 0, entradas_previstas: 0, saidas_previstas: 0, contratos_estimados: 0
  }]));
  for (const r of realizado.rows) if (linha[r.mes]) linha[r.mes][r.tipo === 'entrada' ? 'entradas_realizadas' : 'saidas_realizadas'] += r.total;
  for (const r of previsto.rows) if (linha[r.mes]) linha[r.mes][r.tipo === 'entrada' ? 'entradas_previstas' : 'saidas_previstas'] += r.total;

  // Contratos: fatura da competência C entra no caixa no mês do vencimento (C+1 ou C, conforme a configuração)
  const deslocamento = config.vencimento_mes_seguinte === false ? 0 : 1;
  const jaFaturado = new Set(faturasExist.rows.map(f => `${f.contrato_id}|${f.comp}`));
  for (const m of lista) {
    if (m < mesAtual) continue;
    const comp = mesDe(somarMeses(`${m}-01`, -deslocamento));
    if (comp < mesDe(somarMeses(`${mesAtual}-01`, -1))) continue; // não inventa faturas de meses já fechados
    for (const ct of contratos.rows) {
      if (jaFaturado.has(`${ct.id}|${comp}`)) continue;
      if (mesDe(ct.data_inicio) > comp || (ct.data_fim && mesDe(ct.data_fim) < comp)) continue;
      const ret = fat.RETENCOES.reduce((s, r) => s + Number(ct[r] ?? config[r] ?? 0), 0);
      const iss = ct.reter_iss ? Number(ct.aliquota_iss ?? config.aliquota_iss ?? 0) : 0;
      linha[m].contratos_estimados += ct.valor * (1 - (ret + iss) / 100);
    }
  }

  let saldo = saldoIni + antes.rows[0].ate_inicio - antes.rows[0].ate_data_saldo;
  const resultado = lista.map(m => {
    const l = linha[m];
    const abertura = saldo;
    const entradas = l.entradas_realizadas + l.entradas_previstas + l.contratos_estimados;
    const saidas = l.saidas_realizadas + l.saidas_previstas;
    saldo = abertura + entradas - saidas;
    return Object.fromEntries(Object.entries({ ...l, saldo_abertura: abertura, saldo_final: saldo })
      .map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
  });

  // Próximos 30 dias + atrasados, para a lista do dia a dia
  const proximos = await pool.query(
    `SELECT 'receber' AS tipo, f.id, to_char(f.data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
            ${fat.sqlValorLiquido('f')} AS valor, COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS descricao,
            f.data_vencimento < CURRENT_DATE AS vencida
     FROM faturas f JOIN clientes c ON c.id = f.cliente_id
     WHERE f.empresa_id = $1 AND f.status = 'aberta' AND f.data_vencimento <= CURRENT_DATE + 30
     UNION ALL
     SELECT 'pagar', cp.id, to_char(cp.data_vencimento, 'YYYY-MM-DD'), cp.valor::float, cp.descricao,
            cp.data_vencimento < CURRENT_DATE
     FROM contas_pagar cp
     WHERE cp.empresa_id = $1 AND cp.status = 'aberta' AND cp.data_vencimento <= CURRENT_DATE + 30
     ORDER BY 3, 1 DESC
     LIMIT 100`, [empresa]);

  return {
    saldo_inicial: saldoIni, saldo_inicial_data: dataSaldo, mes_atual: mesAtual,
    meses: resultado, proximos: proximos.rows
  };
}

// ===== DRE gerencial (regime de competência) =====
// Receita = faturas aprovadas da competência. Retenções feitas pelo cliente entram como imposto:
// PIS/COFINS/INSS e ISS retido → impostos sobre o faturamento; IRRF/CSLL → IRPJ e CSLL (são antecipação).
// Despesas = contas a pagar não canceladas, pela competência, na linha da DRE da categoria.
async function montarDre(empresa, ano) {
  const [receitas, despesas] = await Promise.all([
    pool.query(
      `SELECT EXTRACT(MONTH FROM competencia)::int AS mes,
              SUM(valor)::float AS receita,
              SUM(valor * (COALESCE(ret_pis,0) + COALESCE(ret_cofins,0) + COALESCE(ret_inss,0)) / 100
                  + CASE WHEN reter_iss THEN valor * COALESCE(aliquota_iss,0) / 100 ELSE 0 END)::float AS ret_receita,
              SUM(valor * (COALESCE(ret_ir,0) + COALESCE(ret_csll,0)) / 100)::float AS ret_ir_csll
       FROM faturas
       WHERE empresa_id = $1 AND status IN ('aberta','paga') AND EXTRACT(YEAR FROM competencia) = $2
       GROUP BY 1`, [empresa, ano]),
    pool.query(
      // Pessoal = retirada do sócio: sai da DRE (vai para "fora do resultado"), mesmo com categoria de despesa
      `SELECT EXTRACT(MONTH FROM cp.competencia)::int AS mes,
              CASE WHEN cp.natureza = 'pessoal' THEN 'fora_resultado' ELSE COALESCE(cat.grupo_dre, 'despesa_administrativa') END AS grupo,
              CASE WHEN cp.natureza = 'pessoal' THEN 'Retiradas pessoais' ELSE COALESCE(cat.nome, 'Sem categoria') END AS categoria,
              SUM(cp.valor)::float AS total
       FROM contas_pagar cp LEFT JOIN categorias_transacao cat ON cat.id = cp.categoria_id
       WHERE cp.empresa_id = $1 AND cp.status <> 'cancelada' AND EXTRACT(YEAR FROM cp.competencia) = $2
       GROUP BY 1, 2, 3`, [empresa, ano])
  ]);

  const zeros = () => Array(12).fill(0);
  const receita = zeros(), retReceita = zeros(), retIrCsll = zeros();
  for (const r of receitas.rows) {
    receita[r.mes - 1] = r.receita; retReceita[r.mes - 1] = r.ret_receita; retIrCsll[r.mes - 1] = r.ret_ir_csll;
  }
  // grupo → { total: [12], categorias: { nome: [12] } }
  const grupos = Object.fromEntries(Object.keys(GRUPOS_DRE).map(g => [g, { total: zeros(), categorias: {} }]));
  const somar = (g, cat, mes, v) => {
    const G = grupos[g] || grupos.despesa_administrativa;
    G.total[mes] += v;
    (G.categorias[cat] = G.categorias[cat] || zeros())[mes] += v;
  };
  for (const d of despesas.rows) somar(d.grupo, d.categoria, d.mes - 1, d.total);
  retReceita.forEach((v, i) => { if (v) somar('impostos_receita', 'Retido pelo cliente na nota', i, v); });
  retIrCsll.forEach((v, i) => { if (v) somar('ir_csll', 'IRRF e CSLL retidos na nota', i, v); });

  const sub = (a, ...bs) => a.map((v, i) => bs.reduce((s, b) => s - b[i], v));
  const linhas = [];
  const L = (chave, rotulo, valores, tipo, sinal = 1) =>
    linhas.push({ chave, rotulo, tipo, valores: valores.map(v => r2(v * sinal)), total: r2(valores.reduce((s, v) => s + v, 0) * sinal) });
  const grupo = (g, rotulo) => {
    L(g, rotulo || GRUPOS_DRE[g], grupos[g].total, 'grupo', -1);
    Object.entries(grupos[g].categorias).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))
      .forEach(([nome, v]) => L(`${g}:${nome}`, nome, v, 'categoria', -1));
  };

  const receitaLiq = sub(receita, grupos.impostos_receita.total);
  const lucroBruto = sub(receitaLiq, grupos.custo_servico.total);
  const operacionais = ['despesa_pessoal', 'despesa_administrativa', 'despesa_comercial'];
  const ebitda = sub(lucroBruto, ...operacionais.map(g => grupos[g].total));
  const antesIr = sub(ebitda, grupos.despesa_financeira.total);
  const liquido = sub(antesIr, grupos.ir_csll.total);

  L('receita_bruta', 'Receita bruta de serviços', receita, 'grupo');
  grupo('impostos_receita', '(−) Impostos sobre o faturamento');
  L('receita_liquida', 'Receita líquida', receitaLiq, 'subtotal');
  grupo('custo_servico', '(−) Custo dos serviços');
  L('lucro_bruto', 'Lucro bruto', lucroBruto, 'subtotal');
  operacionais.forEach(g => grupo(g, `(−) ${GRUPOS_DRE[g]}`));
  L('resultado_operacional', 'Resultado operacional', ebitda, 'subtotal');
  grupo('despesa_financeira', '(−) Despesas financeiras');
  L('resultado_antes_ir', 'Resultado antes do IR e CSLL', antesIr, 'subtotal');
  grupo('ir_csll', '(−) IRPJ e CSLL');
  L('resultado_liquido', 'Resultado líquido', liquido, 'resultado');

  const fora = grupos.fora_resultado.total;
  return {
    ano, linhas,
    fora_resultado: {
      valores: fora.map(r2), total: r2(fora.reduce((s, v) => s + v, 0)),
      categorias: Object.entries(grupos.fora_resultado.categorias)
        .map(([nome, v]) => ({ nome, total: r2(v.reduce((s, x) => s + x, 0)) }))
        .sort((a, b) => b.total - a.total)
    }
  };
}

module.exports = { montarFluxoCaixa, montarDre };
