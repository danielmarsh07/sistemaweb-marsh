// Regras de contas a pagar e categorias de despesa, usadas pelas rotas do financeiro e pelo assistente de voz.
const crypto = require('crypto');
const pool = require('../db');

const vazioNulo = v => (v === undefined || v === null || String(v).trim() === '' ? null : v);
const competenciaValida = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));

// Soma n meses a AAAA-MM-DD mantendo o dia (limitado ao último dia do mês)
function somarMeses(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}
const mesDe = iso => iso.slice(0, 7);

// ===== Linhas da DRE =====
// Ordem importa: é a ordem de exibição. 'fora_resultado' só aparece no fluxo de caixa.
const GRUPOS_DRE = {
  impostos_receita: 'Impostos sobre o faturamento',
  custo_servico: 'Custo dos serviços',
  despesa_pessoal: 'Pessoal e pró-labore',
  despesa_administrativa: 'Despesas administrativas',
  despesa_comercial: 'Despesas comerciais',
  despesa_financeira: 'Despesas financeiras',
  ir_csll: 'IRPJ e CSLL',
  fora_resultado: 'Fora do resultado (retiradas, lucros, empréstimos, parcelamentos)'
};

// Acrescentadas com o controle mensal (planilha de custos): entram uma vez por empresa, sem mexer nas existentes
const CATEGORIAS_V2 = [
  ['Telefonia e internet', 'despesa_administrativa'],
  ['Veículo', 'despesa_administrativa'],
  ['Parcelamentos de impostos', 'fora_resultado'],
  ['Empréstimos e financiamentos', 'fora_resultado'],
  ['Moradia (pessoal)', 'fora_resultado'],
  ['Compras pessoais', 'fora_resultado'],
  ['Saúde (pessoal)', 'fora_resultado'],
  ['Lazer e assinaturas pessoais', 'fora_resultado']
];
const NATUREZAS = ['empresa', 'pessoal'];

const CATEGORIAS_PADRAO = [
  ['ISS', 'impostos_receita'],
  ['PIS e COFINS', 'impostos_receita'],
  ['Serviços de terceiros', 'custo_servico'],
  ['Hospedagem e infraestrutura', 'custo_servico'],
  ['Pró-labore e INSS', 'despesa_pessoal'],
  ['Contabilidade', 'despesa_administrativa'],
  ['Softwares e assinaturas', 'despesa_administrativa'],
  ['Outras despesas', 'despesa_administrativa'],
  ['Marketing', 'despesa_comercial'],
  ['Tarifas bancárias', 'despesa_financeira'],
  ['IRPJ e CSLL', 'ir_csll'],
  ['Distribuição de lucros', 'fora_resultado']
];

// Na primeira vez cria as categorias de despesa padrão (sem sobrescrever as que já existem)
async function garantirCategoriasPadrao(empresa_id) {
  const r = await pool.query(
    `SELECT 1 FROM categorias_transacao WHERE empresa_id = $1 AND tipo = 'saída' AND grupo_dre IS NOT NULL LIMIT 1`,
    [empresa_id]);
  if (!r.rows.length) {
    for (const [nome, grupo] of CATEGORIAS_PADRAO) {
      await pool.query(
        `INSERT INTO categorias_transacao (empresa_id, nome, tipo, grupo_dre) VALUES ($1, $2, 'saída', $3)
         ON CONFLICT (empresa_id, nome, tipo) DO UPDATE SET grupo_dre = COALESCE(categorias_transacao.grupo_dre, EXCLUDED.grupo_dre)`,
        [empresa_id, nome, grupo]);
    }
  }
  // Segunda leva: uma única vez por empresa (se o usuário apagar/renomear depois, não volta)
  const v2 = await pool.query(
    `INSERT INTO migracoes_app (nome) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nome`, [`categorias_v2_emp_${empresa_id}`]);
  if (v2.rowCount) {
    for (const [nome, grupo] of CATEGORIAS_V2) {
      await pool.query(
        `INSERT INTO categorias_transacao (empresa_id, nome, tipo, grupo_dre) VALUES ($1, $2, 'saída', $3)
         ON CONFLICT (empresa_id, nome, tipo) DO NOTHING`, [empresa_id, nome, grupo]);
    }
  }
}

// Vencimento de um lançamento no cartão: dia da fatura no mês (limitado ao último dia do mês)
function vencimentoFatura(mes, dia) {
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${mes}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
}

// Valida e, se for cartão com mes_fatura, calcula o vencimento. Retorna { erro } ou { cartao, vencimento }
async function validarConta(b, empresa_id) {
  if (!vazioNulo(b.descricao)) return { erro: 'Informe a descrição.' };
  if (!(Number(b.valor) > 0)) return { erro: 'Valor deve ser maior que zero.' };
  if (!competenciaValida(b.competencia)) return { erro: 'Competência no formato AAAA-MM.' };
  if (!b.categoria_id) return { erro: 'Escolha a categoria (define a linha da DRE).' };
  if (b.natureza && !NATUREZAS.includes(b.natureza)) return { erro: 'Natureza: empresa ou pessoal.' };
  const cat = await pool.query(
    `SELECT 1 FROM categorias_transacao WHERE id = $1 AND empresa_id = $2 AND tipo = 'saída'`, [b.categoria_id, empresa_id]);
  if (!cat.rows.length) return { erro: 'Categoria inválida.' };
  if (vazioNulo(b.fornecedor_id) !== null) {
    const fo = await pool.query('SELECT 1 FROM fornecedores WHERE id = $1 AND empresa_id = $2', [b.fornecedor_id, empresa_id]);
    if (!fo.rows.length) return { erro: 'Fornecedor inválido.' };
  }
  let cartao = null;
  if (vazioNulo(b.conta_financeira_id) !== null) {
    const cf = await pool.query('SELECT id, tipo, dia_vencimento FROM contas_financeiras WHERE id = $1 AND empresa_id = $2',
      [b.conta_financeira_id, empresa_id]);
    if (!cf.rows.length) return { erro: 'Conta ou cartão inválido.' };
    if (cf.rows[0].tipo === 'cartao') cartao = cf.rows[0];
  }
  // Cartão: o vencimento sai do mês da fatura; nos demais, da data informada
  if (cartao && competenciaValida(b.mes_fatura)) return { cartao, vencimento: vencimentoFatura(b.mes_fatura, cartao.dia_vencimento) };
  if (!dataValida(b.data_vencimento)) return { erro: cartao ? 'Informe o mês da fatura.' : 'Data de vencimento inválida.' };
  return { cartao, vencimento: b.data_vencimento };
}

// Vencimento da n-ésima repetição: no cartão, sempre o dia da fatura; nos demais, mesmo dia do mês
const vencimentoN = (cartao, base, n) =>
  cartao ? vencimentoFatura(mesDe(somarMeses(`${mesDe(base)}-01`, n)), cartao.dia_vencimento) : somarMeses(base, n);

// Cria a conta (ou a série). tipo: unica | parcelada { parcela_inicial, total_parcelas } | recorrente (12 meses,
// renovados pela rotina). Aceita o antigo repetir_meses = parcelada de 1 até N.
// Retorna { erro } (validação) ou { mensagem, qtd, vencimento }; falha de banco lança exceção.
async function criarContaPagar(empresa_id, usuario_id, b) {
  const v = await validarConta(b, empresa_id);
  if (v.erro) return { erro: v.erro };

  let tipo = b.tipo || 'unica';
  let inicial = 1, total = 1;
  if (tipo === 'unica' && Number(b.repetir_meses) > 1) { tipo = 'parcelada'; total = Number(b.repetir_meses); }
  else if (tipo === 'parcelada') { inicial = Number(b.parcela_inicial || 1); total = Number(b.total_parcelas); }
  if (!['unica', 'parcelada', 'recorrente'].includes(tipo)) return { erro: 'Tipo de lançamento inválido.' };
  if (tipo === 'parcelada' && !(Number.isInteger(total) && total >= 2 && total <= 120 && Number.isInteger(inicial) && inicial >= 1 && inicial <= total)) {
    return { erro: 'Parcelas: total de 2 a 120 e parcela atual entre 1 e o total.' };
  }
  const qtd = tipo === 'unica' ? 1 : tipo === 'recorrente' ? 12 : total - inicial + 1;
  const pagaAgora = !!b.ja_paga;
  if (pagaAgora && !dataValida(b.data_pagamento)) return { erro: 'Data do pagamento inválida.' };

  const grupo = tipo === 'unica' ? null : crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < qtd; i++) {
      const paga = pagaAgora && i === 0; // só a primeira entra como paga
      await client.query(
        `INSERT INTO contas_pagar (empresa_id, fornecedor_id, categoria_id, descricao, documento, valor, competencia,
           data_vencimento, status, data_pagamento, valor_pago, forma_pagamento, grupo_id, parcela, total_parcelas,
           observacoes, criado_por_usuario_id, natureza, conta_financeira_id, recorrente)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [empresa_id, vazioNulo(b.fornecedor_id), b.categoria_id, b.descricao.trim(), vazioNulo(b.documento), Number(b.valor),
         somarMeses(`${b.competencia}-01`, i), vencimentoN(v.cartao, v.vencimento, i),
         paga ? 'paga' : 'aberta', paga ? b.data_pagamento : null, paga ? Number(b.valor) : null,
         paga ? (vazioNulo(b.forma_pagamento) || (v.cartao ? 'cartao' : 'transferencia')) : null,
         grupo, grupo ? inicial + i : null, tipo === 'parcelada' ? total : null, vazioNulo(b.observacoes), usuario_id,
         b.natureza || 'empresa', vazioNulo(b.conta_financeira_id), tipo === 'recorrente']);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }

  const mensagem = tipo === 'recorrente' ? 'Assinatura criada: 12 meses lançados, renovados automaticamente.'
    : tipo === 'parcelada' ? `${qtd} parcela(s) criada(s) (${inicial} a ${total} de ${total}).` : 'Conta criada!';
  return { mensagem, qtd, vencimento: v.vencimento };
}

// Baixa de uma conta em aberto. Retorna true se baixou.
async function darBaixaConta(empresa_id, usuario_id, id, { data_pagamento, valor_pago, forma_pagamento }) {
  const r = await pool.query(
    `UPDATE contas_pagar SET status = 'paga', data_pagamento = $1, valor_pago = $2, forma_pagamento = $3,
       atualizado_por_usuario_id = $4, data_atualizacao = NOW()
     WHERE id = $5 AND empresa_id = $6 AND status = 'aberta' RETURNING id`,
    [data_pagamento, Number(valor_pago), vazioNulo(forma_pagamento) || 'transferencia', usuario_id, id, empresa_id]);
  return r.rows.length > 0;
}

module.exports = {
  GRUPOS_DRE, NATUREZAS, somarMeses, mesDe, competenciaValida, dataValida,
  garantirCategoriasPadrao, vencimentoFatura, validarConta, criarContaPagar, darBaixaConta
};
