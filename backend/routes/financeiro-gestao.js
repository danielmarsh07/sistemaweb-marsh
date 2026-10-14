/**
 * Financeiro, fase 2 — montado dentro de /api/financeiro, depois da trava de administrador.
 *
 * Contas a pagar (com recorrência mensal), categorias de despesa (com a linha da DRE),
 * fluxo de caixa (realizado + previsto) e DRE gerencial por competência.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const fat = require('../services/faturamento');
const relatorios = require('../services/relatorios-financeiros');
const {
  GRUPOS_DRE, somarMeses, mesDe, competenciaValida, dataValida,
  garantirCategoriasPadrao, validarConta, criarContaPagar, darBaixaConta
} = require('../services/contas-pagar');

const emp = req => req.usuario.empresa_id || 1;
const vazioNulo = v => (v === undefined || v === null || String(v).trim() === '' ? null : v);
const r2 = n => Math.round(Number(n || 0) * 100) / 100;

function erro500(res, msg, err) {
  console.error(`[financeiro] ${msg}:`, err.message);
  res.status(500).json({ erro: msg, detalhe: err.message });
}

// ===== Categorias de despesa =====
router.get('/grupos-dre', (req, res) => {
  res.json(Object.entries(GRUPOS_DRE).map(([id, nome]) => ({ id, nome })));
});

router.get('/categorias-despesa', async (req, res) => {
  try {
    await garantirCategoriasPadrao(emp(req));
    const r = await pool.query(
      `SELECT c.id, c.nome, COALESCE(c.grupo_dre, 'despesa_administrativa') AS grupo_dre, c.ativo,
              (SELECT COUNT(*) FROM contas_pagar cp WHERE cp.categoria_id = c.id)::int AS total_uso
       FROM categorias_transacao c
       WHERE c.empresa_id = $1 AND c.tipo = 'saída'
       ORDER BY c.ativo DESC, c.nome`, [emp(req)]);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao buscar categorias', err); }
});

function validarCategoria(b) {
  if (!vazioNulo(b.nome)) return 'Informe o nome da categoria.';
  if (String(b.nome).trim().length > 120) return 'Nome muito longo (máx. 120).';
  if (!GRUPOS_DRE[b.grupo_dre]) return 'Escolha a linha da DRE.';
  return null;
}

router.post('/categorias-despesa', async (req, res) => {
  const b = req.body || {};
  const e = validarCategoria(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const r = await pool.query(
      `INSERT INTO categorias_transacao (empresa_id, nome, tipo, grupo_dre, criado_por_usuario_id)
       VALUES ($1, $2, 'saída', $3, $4) RETURNING id`,
      [emp(req), b.nome.trim(), b.grupo_dre, req.usuario.id]);
    res.status(201).json({ mensagem: 'Categoria criada!', id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe uma categoria de despesa com esse nome.' });
    erro500(res, 'Erro ao criar categoria', err);
  }
});

router.put('/categorias-despesa/:id', async (req, res) => {
  const b = req.body || {};
  const e = validarCategoria(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const r = await pool.query(
      `UPDATE categorias_transacao SET nome = $1, grupo_dre = $2, ativo = $3,
         atualizado_por_usuario_id = $4, data_atualizacao = NOW()
       WHERE id = $5 AND empresa_id = $6 AND tipo = 'saída' RETURNING id`,
      [b.nome.trim(), b.grupo_dre, b.ativo !== false, req.usuario.id, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Categoria não encontrada.' });
    res.json({ mensagem: 'Categoria atualizada!' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe uma categoria de despesa com esse nome.' });
    erro500(res, 'Erro ao atualizar categoria', err);
  }
});

// ===== Contas e cartões (de onde sai o pagamento) =====
// No cartão, todo lançamento vence no dia da fatura do mês escolhido; "pagar fatura" baixa todos de uma vez.
const COLUNAS_CF = `cf.id, cf.nome, cf.tipo, cf.dia_fechamento, cf.dia_vencimento, cf.ativo`;

router.get('/contas-financeiras', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${COLUNAS_CF}, (SELECT COUNT(*) FROM contas_pagar cp WHERE cp.conta_financeira_id = cf.id)::int AS total_uso
       FROM contas_financeiras cf WHERE cf.empresa_id = $1
       ORDER BY cf.ativo DESC, cf.tipo, cf.nome`, [emp(req)]);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao buscar contas e cartões', err); }
});

function validarContaFinanceira(b) {
  if (!vazioNulo(b.nome)) return 'Informe o nome (ex.: Cartão Porto, Conta Bradesco).';
  if (String(b.nome).trim().length > 80) return 'Nome muito longo (máx. 80).';
  if (!['conta', 'cartao'].includes(b.tipo)) return 'Tipo: conta ou cartão.';
  if (b.tipo === 'cartao') {
    const v = Number(b.dia_vencimento);
    if (!Number.isInteger(v) || v < 1 || v > 31) return 'Informe o dia de vencimento da fatura (1 a 31).';
    if (vazioNulo(b.dia_fechamento) !== null && !(Number(b.dia_fechamento) >= 1 && Number(b.dia_fechamento) <= 31)) return 'Dia de fechamento: 1 a 31.';
  }
  return null;
}

function paramsContaFinanceira(b) {
  const cartao = b.tipo === 'cartao';
  return [String(b.nome).trim(), b.tipo, cartao && vazioNulo(b.dia_fechamento) !== null ? Number(b.dia_fechamento) : null,
    cartao ? Number(b.dia_vencimento) : null];
}

router.post('/contas-financeiras', async (req, res) => {
  const b = req.body || {};
  const e = validarContaFinanceira(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const r = await pool.query(
      `INSERT INTO contas_financeiras (nome, tipo, dia_fechamento, dia_vencimento, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [...paramsContaFinanceira(b), emp(req)]);
    res.status(201).json({ mensagem: 'Cadastrado!', id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe uma conta ou cartão com esse nome.' });
    erro500(res, 'Erro ao cadastrar', err);
  }
});

router.put('/contas-financeiras/:id', async (req, res) => {
  const b = req.body || {};
  const e = validarContaFinanceira(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const r = await pool.query(
      `UPDATE contas_financeiras SET nome=$1, tipo=$2, dia_fechamento=$3, dia_vencimento=$4, ativo=$5
       WHERE id=$6 AND empresa_id=$7 RETURNING id`,
      [...paramsContaFinanceira(b), b.ativo !== false, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Não encontrado.' });
    res.json({ mensagem: 'Atualizado! Lançamentos já feitos mantêm o vencimento.' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe uma conta ou cartão com esse nome.' });
    erro500(res, 'Erro ao atualizar', err);
  }
});

// POST /contas-financeiras/:id/pagar-fatura { mes: AAAA-MM, data_pagamento } — baixa todos os lançamentos em aberto da fatura
router.post('/contas-financeiras/:id/pagar-fatura', async (req, res) => {
  const b = req.body || {};
  if (!competenciaValida(b.mes)) return res.status(400).json({ erro: 'Mês da fatura no formato AAAA-MM.' });
  if (!dataValida(b.data_pagamento)) return res.status(400).json({ erro: 'Data do pagamento inválida.' });
  try {
    const r = await pool.query(
      `UPDATE contas_pagar SET status = 'paga', data_pagamento = $1, valor_pago = valor, forma_pagamento = 'cartao',
         atualizado_por_usuario_id = $2, data_atualizacao = NOW()
       WHERE empresa_id = $3 AND conta_financeira_id = $4 AND status = 'aberta'
         AND data_vencimento >= $5::date AND data_vencimento < $5::date + INTERVAL '1 month'
       RETURNING valor::float AS valor`,
      [b.data_pagamento, req.usuario.id, emp(req), req.params.id, `${b.mes}-01`]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Nenhum lançamento em aberto nessa fatura.' });
    const total = r2(r.rows.reduce((s, x) => s + x.valor, 0));
    res.json({ mensagem: `Fatura paga: ${r.rows.length} lançamento(s), total R$ ${total.toFixed(2).replace('.', ',')}.`, qtd: r.rows.length, total });
  } catch (err) { erro500(res, 'Erro ao pagar fatura', err); }
});

// ===== Contas a pagar =====
const COLUNAS_CONTA = `
  cp.id, cp.fornecedor_id, cp.categoria_id, cp.descricao, cp.documento, cp.valor::float AS valor,
  to_char(cp.competencia, 'YYYY-MM-DD') AS competencia,
  to_char(cp.data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
  cp.status, to_char(cp.data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
  cp.valor_pago::float AS valor_pago, cp.forma_pagamento, cp.grupo_id, cp.parcela, cp.total_parcelas,
  cp.observacoes, cp.data_criacao, cp.natureza, cp.conta_financeira_id, cp.recorrente,
  (cp.status = 'aberta' AND cp.data_vencimento < CURRENT_DATE) AS vencida,
  COALESCE(NULLIF(fo.nome, ''), fo.razao_social) AS fornecedor_nome,
  cat.nome AS categoria_nome, COALESCE(cat.grupo_dre, 'despesa_administrativa') AS grupo_dre,
  cf.nome AS conta_financeira_nome, cf.tipo AS conta_financeira_tipo`;

const FROM_CONTA = `
  FROM contas_pagar cp
  LEFT JOIN fornecedores fo ON fo.id = cp.fornecedor_id
  LEFT JOIN categorias_transacao cat ON cat.id = cp.categoria_id
  LEFT JOIN contas_financeiras cf ON cf.id = cp.conta_financeira_id`;

async function carregarConta(id, empresa_id) {
  const r = await pool.query(`SELECT ${COLUNAS_CONTA} ${FROM_CONTA} WHERE cp.id = $1 AND cp.empresa_id = $2`, [id, empresa_id]);
  return r.rows[0] || null;
}

// GET /contas-pagar?mes=AAAA-MM — contas que vencem no mês + as em aberto de meses anteriores (atrasadas)
router.get('/contas-pagar', async (req, res) => {
  const mes = req.query.mes;
  if (!competenciaValida(mes)) return res.status(400).json({ erro: 'Mês no formato AAAA-MM.' });
  try {
    const r = await pool.query(
      `SELECT ${COLUNAS_CONTA} ${FROM_CONTA}
       WHERE cp.empresa_id = $1
         AND ((cp.data_vencimento >= $2::date AND cp.data_vencimento < $2::date + INTERVAL '1 month')
              OR (cp.status = 'aberta' AND cp.data_vencimento < $2::date))
       ORDER BY cp.status = 'aberta' DESC, cp.data_vencimento, cp.descricao
       LIMIT 500`, [emp(req), `${mes}-01`]);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao buscar contas a pagar', err); }
});

router.get('/contas-pagar/resumo', async (req, res) => {
  const mes = req.query.mes;
  if (!competenciaValida(mes)) return res.status(400).json({ erro: 'Mês no formato AAAA-MM.' });
  try {
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(valor) FILTER (WHERE em_mes AND status <> 'cancelada'), 0)::float AS total_mes,
         COUNT(*) FILTER (WHERE em_mes AND status <> 'cancelada')::int AS qtd_mes,
         COALESCE(SUM(valor_pago) FILTER (WHERE status = 'paga' AND data_pagamento >= $2::date
                                          AND data_pagamento < $2::date + INTERVAL '1 month'), 0)::float AS pago_mes,
         COUNT(*) FILTER (WHERE status = 'paga' AND data_pagamento >= $2::date
                          AND data_pagamento < $2::date + INTERVAL '1 month')::int AS qtd_pago,
         COALESCE(SUM(valor) FILTER (WHERE status = 'aberta' AND data_vencimento >= CURRENT_DATE
                                     AND data_vencimento <= CURRENT_DATE + 7), 0)::float AS proximos_7,
         COUNT(*) FILTER (WHERE status = 'aberta' AND data_vencimento >= CURRENT_DATE
                          AND data_vencimento <= CURRENT_DATE + 7)::int AS qtd_proximos_7,
         COALESCE(SUM(valor) FILTER (WHERE status = 'aberta' AND data_vencimento < CURRENT_DATE), 0)::float AS vencido,
         COUNT(*) FILTER (WHERE status = 'aberta' AND data_vencimento < CURRENT_DATE)::int AS qtd_vencido
       FROM (SELECT cp.*, (cp.data_vencimento >= $2::date AND cp.data_vencimento < $2::date + INTERVAL '1 month') AS em_mes
             FROM contas_pagar cp WHERE cp.empresa_id = $1) cp`,
      [emp(req), `${mes}-01`]);
    res.json(r.rows[0]);
  } catch (err) { erro500(res, 'Erro ao montar resumo', err); }
});

router.get('/contas-pagar/:id', async (req, res) => {
  try {
    const c = await carregarConta(req.params.id, emp(req));
    if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
    res.json(c);
  } catch (err) { erro500(res, 'Erro ao buscar conta', err); }
});

// POST /contas-pagar — tipo: unica | parcelada { parcela_inicial, total_parcelas } | recorrente (12 meses, renovados pela rotina)
// (aceita o antigo repetir_meses = parcelada de 1 até N)
router.post('/contas-pagar', async (req, res) => {
  try {
    const r = await criarContaPagar(emp(req), req.usuario.id, req.body || {});
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.status(201).json({ mensagem: r.mensagem });
  } catch (err) { erro500(res, 'Erro ao criar conta', err); }
});

// PUT /contas-pagar/:id — aplicar_seguintes: replica descrição, valor, categoria, fornecedor, natureza e conta nas próximas em aberto da série
router.put('/contas-pagar/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const c = await carregarConta(req.params.id, emp(req));
    if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
    if (c.status === 'cancelada') return res.status(400).json({ erro: 'Conta cancelada não pode ser editada.' });
    const v = await validarConta(b, emp(req));
    if (v.erro) return res.status(400).json({ erro: v.erro });
    await pool.query(
      `UPDATE contas_pagar SET fornecedor_id=$1, categoria_id=$2, descricao=$3, documento=$4, valor=$5,
         competencia=$6::date, data_vencimento=$7::date, observacoes=$8, natureza=$9, conta_financeira_id=$10,
         atualizado_por_usuario_id=$11, data_atualizacao=NOW()
       WHERE id=$12`,
      [vazioNulo(b.fornecedor_id), b.categoria_id, b.descricao.trim(), vazioNulo(b.documento), Number(b.valor),
       `${b.competencia}-01`, v.vencimento, vazioNulo(b.observacoes), b.natureza || c.natureza,
       vazioNulo(b.conta_financeira_id), req.usuario.id, c.id]);
    let extras = 0;
    if (b.aplicar_seguintes && c.grupo_id) {
      const r = await pool.query(
        `UPDATE contas_pagar SET fornecedor_id=$1, categoria_id=$2, descricao=$3, valor=$4, natureza=$5, conta_financeira_id=$6,
           atualizado_por_usuario_id=$7, data_atualizacao=NOW()
         WHERE grupo_id=$8 AND empresa_id=$9 AND parcela > $10 AND status = 'aberta'`,
        [vazioNulo(b.fornecedor_id), b.categoria_id, b.descricao.trim(), Number(b.valor), b.natureza || c.natureza,
         vazioNulo(b.conta_financeira_id), req.usuario.id, c.grupo_id, emp(req), c.parcela]);
      extras = r.rowCount;
    }
    res.json({ mensagem: extras ? `Conta atualizada, e mais ${extras} da série.` : 'Conta atualizada!' });
  } catch (err) { erro500(res, 'Erro ao atualizar conta', err); }
});

// DELETE /contas-pagar/:id?seguintes=1 — só em aberto; com seguintes, apaga também as próximas da série
// (numa assinatura recorrente, isso a encerra: a rotina para de renovar)
router.delete('/contas-pagar/:id', async (req, res) => {
  try {
    const c = await carregarConta(req.params.id, emp(req));
    if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
    if (c.status === 'paga') return res.status(400).json({ erro: 'Desfaça o pagamento antes de excluir.' });
    let r;
    if (req.query.seguintes === '1' && c.grupo_id) {
      r = await pool.query(
        `DELETE FROM contas_pagar WHERE grupo_id = $1 AND empresa_id = $2 AND parcela >= $3 AND status <> 'paga'`,
        [c.grupo_id, emp(req), c.parcela]);
      await pool.query('UPDATE contas_pagar SET recorrente = FALSE WHERE grupo_id = $1 AND empresa_id = $2', [c.grupo_id, emp(req)]);
    } else {
      r = await pool.query('DELETE FROM contas_pagar WHERE id = $1', [c.id]);
    }
    const fim = req.query.seguintes === '1' && c.recorrente ? ' Assinatura encerrada.' : '';
    res.json({ mensagem: (r.rowCount > 1 ? `${r.rowCount} contas excluídas.` : 'Conta excluída.') + fim });
  } catch (err) { erro500(res, 'Erro ao excluir conta', err); }
});

router.post('/contas-pagar/:id/baixa', async (req, res) => {
  const b = req.body || {};
  if (!dataValida(b.data_pagamento)) return res.status(400).json({ erro: 'Data do pagamento inválida.' });
  if (!(Number(b.valor_pago) > 0)) return res.status(400).json({ erro: 'Valor pago deve ser maior que zero.' });
  try {
    if (!(await darBaixaConta(emp(req), req.usuario.id, req.params.id, b))) {
      return res.status(400).json({ erro: 'Só contas em aberto recebem baixa.' });
    }
    res.json({ mensagem: 'Pagamento registrado!' });
  } catch (err) { erro500(res, 'Erro ao registrar pagamento', err); }
});

router.post('/contas-pagar/:id/estornar-baixa', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE contas_pagar SET status = 'aberta', data_pagamento = NULL, valor_pago = NULL, forma_pagamento = NULL,
         atualizado_por_usuario_id = $1, data_atualizacao = NOW()
       WHERE id = $2 AND empresa_id = $3 AND status = 'paga' RETURNING id`, [req.usuario.id, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só contas pagas podem ter o pagamento desfeito.' });
    res.json({ mensagem: 'Pagamento desfeito: a conta voltou para em aberto.' });
  } catch (err) { erro500(res, 'Erro ao desfazer pagamento', err); }
});

// ===== Saldo inicial do fluxo de caixa =====
router.put('/saldo-inicial', async (req, res) => {
  const b = req.body || {};
  const saldo = Number(b.saldo_inicial);
  if (isNaN(saldo)) return res.status(400).json({ erro: 'Saldo inicial inválido.' });
  if (!dataValida(b.saldo_inicial_data)) return res.status(400).json({ erro: 'Informe a data do saldo.' });
  try {
    await pool.query(
      `INSERT INTO financeiro_config (empresa_id, saldo_inicial, saldo_inicial_data, data_atualizacao)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET saldo_inicial = EXCLUDED.saldo_inicial,
         saldo_inicial_data = EXCLUDED.saldo_inicial_data, data_atualizacao = NOW()`,
      [emp(req), saldo, b.saldo_inicial_data]);
    res.json({ mensagem: 'Saldo inicial salvo!' });
  } catch (err) { erro500(res, 'Erro ao salvar saldo inicial', err); }
});

// ===== Fluxo de caixa (cálculo em services/relatorios-financeiros.js) =====
router.get('/fluxo-caixa', async (req, res) => {
  const inicio = req.query.inicio;
  const meses = Number(req.query.meses || 12);
  if (!competenciaValida(inicio)) return res.status(400).json({ erro: 'Início no formato AAAA-MM.' });
  if (!Number.isInteger(meses) || meses < 1 || meses > 24) return res.status(400).json({ erro: 'Período: 1 a 24 meses.' });
  try {
    res.json(await relatorios.montarFluxoCaixa(emp(req), inicio, meses));
  } catch (err) { erro500(res, 'Erro ao montar fluxo de caixa', err); }
});

// ===== DRE gerencial (cálculo em services/relatorios-financeiros.js) =====
router.get('/dre', async (req, res) => {
  const ano = Number(req.query.ano);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return res.status(400).json({ erro: 'Ano inválido.' });
  try {
    res.json(await relatorios.montarDre(emp(req), ano));
  } catch (err) { erro500(res, 'Erro ao montar DRE', err); }
});

// ===== Visão mensal (substitui a planilha de custos) =====
// Linhas = lançamentos agrupados (uma série/assinatura = uma linha), colunas = meses pelo VENCIMENTO (visão de caixa).
// Seções: por conta/cartão (padrão) ou por categoria. Receitas = faturas (valor líquido) + contratos ainda sem fatura (estimado).

// Contratos ativos que ainda não geraram a fatura cujo vencimento cai no mês m (m >= mês atual)
async function estimarContratos(empresa, lista, mesAtual, config) {
  const [contratos, faturasExist] = await Promise.all([
    pool.query(
      `SELECT ct.id, ct.cliente_id, COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS cliente_nome,
              ct.valor::float AS valor, to_char(ct.data_inicio, 'YYYY-MM-DD') AS data_inicio,
              to_char(ct.data_fim, 'YYYY-MM-DD') AS data_fim, ct.reter_iss, ct.aliquota_iss::float AS aliquota_iss,
              ct.ret_ir::float AS ret_ir, ct.ret_csll::float AS ret_csll, ct.ret_pis::float AS ret_pis,
              ct.ret_cofins::float AS ret_cofins, ct.ret_inss::float AS ret_inss
       FROM contratos ct JOIN clientes c ON c.id = ct.cliente_id
       WHERE ct.empresa_id = $1 AND ct.status = 'ativo'`, [empresa]),
    pool.query(
      `SELECT contrato_id, to_char(competencia, 'YYYY-MM') AS comp FROM faturas
       WHERE empresa_id = $1 AND contrato_id IS NOT NULL AND status <> 'cancelada' AND competencia >= CURRENT_DATE - INTERVAL '2 months'`,
      [empresa])
  ]);
  const deslocamento = config.vencimento_mes_seguinte === false ? 0 : 1;
  const jaFaturado = new Set(faturasExist.rows.map(f => `${f.contrato_id}|${f.comp}`));
  const saida = [];
  for (const m of lista) {
    if (m < mesAtual) continue;
    const comp = mesDe(somarMeses(`${m}-01`, -deslocamento));
    if (comp < mesDe(somarMeses(`${mesAtual}-01`, -1))) continue;
    for (const ct of contratos.rows) {
      if (jaFaturado.has(`${ct.id}|${comp}`)) continue;
      if (mesDe(ct.data_inicio) > comp || (ct.data_fim && mesDe(ct.data_fim) < comp)) continue;
      const ret = fat.RETENCOES.reduce((s, r) => s + Number(ct[r] ?? config[r] ?? 0), 0);
      const iss = ct.reter_iss ? Number(ct.aliquota_iss ?? config.aliquota_iss ?? 0) : 0;
      saida.push({ mes: m, cliente_id: ct.cliente_id, cliente_nome: ct.cliente_nome, valor: r2(ct.valor * (1 - (ret + iss) / 100)) });
    }
  }
  return saida;
}

router.get('/visao-mensal', async (req, res) => {
  const inicio = req.query.inicio;
  const meses = Number(req.query.meses || 6);
  const agrupar = req.query.agrupar === 'categoria' ? 'categoria' : 'meio';
  if (!competenciaValida(inicio)) return res.status(400).json({ erro: 'Início no formato AAAA-MM.' });
  if (!Number.isInteger(meses) || meses < 1 || meses > 12) return res.status(400).json({ erro: 'Período: 1 a 12 meses.' });
  const empresa = emp(req);
  const ini = `${inicio}-01`;
  const fim = somarMeses(ini, meses);
  const lista = [];
  for (let i = 0; i < meses; i++) lista.push(mesDe(somarMeses(ini, i)));
  try {
    const config = await fat.carregarConfig(empresa);
    const mesAtual = (await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM') AS m`)).rows[0].m;
    const [contas, faturas, estimados, cartoes] = await Promise.all([
      pool.query(
        `SELECT ${COLUNAS_CONTA}, to_char(cp.data_vencimento, 'YYYY-MM') AS mes ${FROM_CONTA}
         WHERE cp.empresa_id = $1 AND cp.status <> 'cancelada' AND cp.data_vencimento >= $2::date AND cp.data_vencimento < $3::date
         ORDER BY cp.descricao, cp.data_vencimento`, [empresa, ini, fim]),
      pool.query(
        `SELECT f.id, f.cliente_id, COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS cliente_nome,
                to_char(f.data_vencimento, 'YYYY-MM') AS mes, f.status,
                CASE WHEN f.status = 'paga' THEN f.valor_pago::float ELSE ${fat.sqlValorLiquido('f')} END AS valor,
                (f.status = 'aberta' AND f.data_vencimento < CURRENT_DATE) AS vencida
         FROM faturas f JOIN clientes c ON c.id = f.cliente_id
         WHERE f.empresa_id = $1 AND f.status <> 'cancelada' AND f.data_vencimento >= $2::date AND f.data_vencimento < $3::date`,
        [empresa, ini, fim]),
      estimarContratos(empresa, lista, mesAtual, config),
      pool.query(`SELECT id, nome, dia_vencimento FROM contas_financeiras WHERE empresa_id = $1 AND tipo = 'cartao'`, [empresa])
    ]);

    const celulaVazia = () => ({ valor: 0, ids: [], pagas: 0, abertas: 0, vencidas: 0, parcelas: [] });
    const statusCelula = c => (!c.ids.length ? null : c.vencidas ? 'vencida' : c.abertas === 0 ? 'paga' : c.pagas ? 'misto' : 'aberta');
    const secoes = new Map();
    for (const c of contas.rows) {
      const secaoChave = agrupar === 'categoria' ? `cat:${c.categoria_id}` : `cf:${c.conta_financeira_id || 0}`;
      const secaoTitulo = agrupar === 'categoria' ? (c.categoria_nome || 'Sem categoria') : (c.conta_financeira_nome || 'Conta / sem cartão');
      if (!secoes.has(secaoChave)) {
        secoes.set(secaoChave, {
          chave: secaoChave, titulo: secaoTitulo, linhas: new Map(),
          cartao: agrupar === 'meio' && c.conta_financeira_tipo === 'cartao' ? { id: c.conta_financeira_id } : null
        });
      }
      const sec = secoes.get(secaoChave);
      // Uma série (parcelada/assinatura) é uma linha; lançamentos soltos com a mesma descrição também se juntam
      const chave = c.grupo_id || `d|${c.descricao.trim().toLowerCase()}|${c.categoria_id}|${c.conta_financeira_id || 0}|${c.natureza}`;
      if (!sec.linhas.has(chave)) {
        sec.linhas.set(chave, {
          chave, descricao: c.descricao, categoria: c.categoria_nome, natureza: c.natureza, recorrente: c.recorrente,
          total_parcelas: c.total_parcelas, meio: c.conta_financeira_nome,
          modelo: { descricao: c.descricao, categoria_id: c.categoria_id, natureza: c.natureza, conta_financeira_id: c.conta_financeira_id,
                    fornecedor_id: c.fornecedor_id, valor: c.valor },
          celulas: Object.fromEntries(lista.map(m => [m, celulaVazia()]))
        });
      }
      const ln = sec.linhas.get(chave);
      ln.modelo.valor = c.valor; // o último valor da série é o padrão para lançar um mês vazio
      const cel = ln.celulas[c.mes];
      cel.valor += c.valor; cel.ids.push(c.id);
      if (c.status === 'paga') cel.pagas++; else { cel.abertas++; if (c.vencida) cel.vencidas++; }
      if (c.parcela) cel.parcelas.push(c.total_parcelas ? `${c.parcela}/${c.total_parcelas}` : null);
    }

    const finalizarLinha = ln => ({
      ...ln,
      celulas: Object.fromEntries(Object.entries(ln.celulas).map(([m, c]) => [m, {
        valor: r2(c.valor), ids: c.ids, status: statusCelula(c), parcela: c.parcelas.filter(Boolean)[0] || null
      }]))
    });
    const somaMeses = linhas => Object.fromEntries(lista.map(m => [m, r2(linhas.reduce((s, l) => s + l.celulas[m].valor, 0))]));

    const secoesSaida = [...secoes.values()].map(s => {
      const linhas = [...s.linhas.values()].map(finalizarLinha).sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR'));
      const totais = somaMeses(linhas);
      // Cartão: a fatura do mês está toda paga?
      const faturaPaga = s.cartao ? Object.fromEntries(lista.map(m => {
        const cels = linhas.map(l => l.celulas[m]).filter(c => c.ids.length);
        return [m, cels.length ? cels.every(c => c.status === 'paga') : null];
      })) : null;
      return { chave: s.chave, titulo: s.titulo, cartao: s.cartao, linhas, totais, fatura_paga: faturaPaga };
    }).sort((a, b) => (a.cartao ? 1 : 0) - (b.cartao ? 1 : 0) || a.titulo.localeCompare(b.titulo, 'pt-BR'));

    // Receitas por cliente
    const rec = new Map();
    const linhaCliente = (id, nome) => {
      if (!rec.has(id)) rec.set(id, { chave: `cli:${id}`, descricao: nome, celulas: Object.fromEntries(lista.map(m => [m, { valor: 0, ids: [], estimado: 0, pagas: 0, abertas: 0, vencidas: 0 }])) });
      return rec.get(id);
    };
    for (const f of faturas.rows) {
      const cel = linhaCliente(f.cliente_id, f.cliente_nome).celulas[f.mes];
      cel.valor += f.valor; cel.ids.push(f.id);
      if (f.status === 'paga') cel.pagas++; else { cel.abertas++; if (f.vencida) cel.vencidas++; }
    }
    for (const e of estimados) {
      const cel = linhaCliente(e.cliente_id, e.cliente_nome).celulas[e.mes];
      cel.valor += e.valor; cel.estimado += e.valor;
    }
    const receitas = [...rec.values()].map(l => ({
      ...l,
      celulas: Object.fromEntries(Object.entries(l.celulas).map(([m, c]) => [m, {
        valor: r2(c.valor), ids: c.ids, estimado: r2(c.estimado) > 0,
        status: c.ids.length ? statusCelula(c) : (c.estimado ? 'estimado' : null)
      }]))
    })).sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR'));

    const todasLinhas = secoesSaida.flatMap(s => s.linhas);
    const totais = Object.fromEntries(lista.map(m => {
      const pagar = r2(todasLinhas.reduce((s, l) => s + l.celulas[m].valor, 0));
      const pessoal = r2(todasLinhas.filter(l => l.natureza === 'pessoal').reduce((s, l) => s + l.celulas[m].valor, 0));
      const receber = r2(receitas.reduce((s, l) => s + l.celulas[m].valor, 0));
      return [m, { pagar, pagar_empresa: r2(pagar - pessoal), pagar_pessoal: pessoal, receber, saldo: r2(receber - pagar) }];
    }));

    res.json({ meses: lista, mes_atual: mesAtual, agrupar, secoes: secoesSaida, receitas, totais,
      cartoes: cartoes.rows });
  } catch (err) { erro500(res, 'Erro ao montar a visão mensal', err); }
});

// ===== Relatórios (fase 4) =====
// GET /relatorios?meses=12 — MRR, faturado × recebido, receita por cliente, atraso, prazo de recebimento e funil
router.get('/relatorios', async (req, res) => {
  const meses = Number(req.query.meses || 12);
  if (![6, 12, 24].includes(meses)) return res.status(400).json({ erro: 'Período: 6, 12 ou 24 meses.' });
  const empresa = emp(req);
  try {
    const base = (await pool.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD') AS mes_atual`)).rows[0];
    const ini = somarMeses(base.mes_atual, -(meses - 1)); // 1º dia do primeiro mês
    const fim = somarMeses(base.mes_atual, 1);           // exclusivo

    const [mrr, fatur, receb, clientes, aging, prazo, funil, motivos] = await Promise.all([
      // MRR no fim de cada mês, novos e encerrados (pelo valor atual do contrato; suspensos ficam de fora)
      pool.query(
        `SELECT to_char(m, 'YYYY-MM') AS mes,
                COALESCE(SUM(ct.valor) FILTER (WHERE ct.data_inicio <= fm AND (ct.data_fim IS NULL OR ct.data_fim >= fm)), 0)::float AS mrr,
                COALESCE(SUM(ct.valor) FILTER (WHERE ct.data_inicio >= m AND ct.data_inicio <= fm), 0)::float AS novo,
                COALESCE(SUM(ct.valor) FILTER (WHERE ct.data_fim >= m AND ct.data_fim <= fm), 0)::float AS encerrado,
                COUNT(ct.id) FILTER (WHERE ct.data_inicio <= fm AND (ct.data_fim IS NULL OR ct.data_fim >= fm))::int AS contratos
         FROM generate_series($2::date, $3::date - INTERVAL '1 month', INTERVAL '1 month') m
         CROSS JOIN LATERAL (SELECT (m + INTERVAL '1 month - 1 day')::date AS fm) x
         LEFT JOIN contratos ct ON ct.empresa_id = $1 AND ct.status <> 'suspenso'
         GROUP BY m ORDER BY m`, [empresa, ini, fim]),
      pool.query(
        `SELECT to_char(competencia, 'YYYY-MM') AS mes, SUM(valor)::float AS total
         FROM faturas WHERE empresa_id = $1 AND status IN ('aberta','paga') AND competencia >= $2 AND competencia < $3
         GROUP BY 1`, [empresa, ini, fim]),
      pool.query(
        `SELECT to_char(data_pagamento, 'YYYY-MM') AS mes, SUM(valor_pago)::float AS total
         FROM faturas WHERE empresa_id = $1 AND status = 'paga' AND data_pagamento >= $2 AND data_pagamento < $3
         GROUP BY 1`, [empresa, ini, fim]),
      pool.query(
        `SELECT c.id, COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome) AS cliente,
                SUM(f.valor)::float AS faturado,
                COALESCE(SUM(f.valor_pago) FILTER (WHERE f.status = 'paga'), 0)::float AS recebido,
                COUNT(*)::int AS faturas
         FROM faturas f JOIN clientes c ON c.id = f.cliente_id
         WHERE f.empresa_id = $1 AND f.status IN ('aberta','paga') AND f.competencia >= $2 AND f.competencia < $3
         GROUP BY c.id ORDER BY faturado DESC LIMIT 50`, [empresa, ini, fim]),
      pool.query(
        `SELECT CASE WHEN dias <= 0 THEN 'a_vencer' WHEN dias <= 30 THEN 'd1_30' WHEN dias <= 60 THEN 'd31_60'
                     WHEN dias <= 90 THEN 'd61_90' ELSE 'd90' END AS faixa,
                SUM(liquido)::float AS total, COUNT(*)::int AS qtd
         FROM (SELECT CURRENT_DATE - f.data_vencimento AS dias, ${fat.sqlValorLiquido('f')} AS liquido
               FROM faturas f WHERE f.empresa_id = $1 AND f.status = 'aberta') a
         GROUP BY 1`, [empresa]),
      pool.query(
        `SELECT COUNT(*)::int AS pagas,
                ROUND(AVG(data_pagamento - data_vencimento), 1)::float AS dias_medio,
                COUNT(*) FILTER (WHERE data_pagamento <= data_vencimento)::int AS em_dia
         FROM faturas WHERE empresa_id = $1 AND status = 'paga' AND data_pagamento >= $2 AND data_pagamento < $3`,
        [empresa, ini, fim]),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE etapa = 'ganha')::int AS ganhas,
                COUNT(*) FILTER (WHERE etapa = 'perdida')::int AS perdidas,
                COALESCE(AVG(valor_mensal) FILTER (WHERE etapa = 'ganha' AND valor_mensal > 0), 0)::float AS ticket_mensal,
                ROUND(AVG(data_fechamento - data_criacao::date) FILTER (WHERE etapa = 'ganha'))::int AS ciclo_dias,
                (SELECT COUNT(*) FROM oportunidades o2 WHERE o2.empresa_id = $1 AND o2.data_criacao >= $2)::int AS criadas
         FROM oportunidades WHERE empresa_id = $1 AND etapa IN ('ganha','perdida') AND data_fechamento >= $2`,
        [empresa, ini]),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(motivo_perda), ''), 'Sem motivo') AS motivo, COUNT(*)::int AS qtd
         FROM oportunidades WHERE empresa_id = $1 AND etapa = 'perdida' AND data_fechamento >= $2
         GROUP BY 1 ORDER BY qtd DESC LIMIT 5`, [empresa, ini])
    ]);

    const porMes = rows => Object.fromEntries(rows.map(r => [r.mes, r.total]));
    const f = porMes(fatur.rows), rc = porMes(receb.rows);
    const totalFat = clientes.rows.reduce((s, c) => s + c.faturado, 0);
    const faixas = ['a_vencer', 'd1_30', 'd31_60', 'd61_90', 'd90'];
    res.json({
      inicio: mesDe(ini), mes_atual: mesDe(base.mes_atual),
      meses: mrr.rows.map(m => ({
        ...m, faturado: r2(f[m.mes] || 0), recebido: r2(rc[m.mes] || 0), liquido: r2(m.novo - m.encerrado)
      })),
      clientes: clientes.rows.map(c => ({ ...c, participacao: totalFat ? Math.round((c.faturado / totalFat) * 1000) / 10 : 0 })),
      aging: faixas.map(k => aging.rows.find(a => a.faixa === k) || { faixa: k, total: 0, qtd: 0 }),
      recebimento: prazo.rows[0],
      funil: { ...funil.rows[0], motivos: motivos.rows }
    });
  } catch (err) { erro500(res, 'Erro ao montar relatórios', err); }
});

// ===== Exportação CSV para o contador (Excel pt-BR: ; e vírgula decimal, com BOM) =====
const csvCampo = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function enviarCsv(res, nome, cabecalho, linhas) {
  const corpo = [cabecalho, ...linhas].map(l => l.map(csvCampo).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.send('﻿' + corpo);
}

function periodoCsv(req, res) {
  const { inicio, fim } = req.query;
  if (!competenciaValida(inicio) || !competenciaValida(fim) || fim < inicio) {
    res.status(400).json({ erro: 'Período no formato AAAA-MM (início ≤ fim).' });
    return null;
  }
  return [`${inicio}-01`, somarMeses(`${fim}-01`, 1)];
}

router.get('/exportar/faturas.csv', async (req, res) => {
  const p = periodoCsv(req, res);
  if (!p) return;
  try {
    const r = await pool.query(
      `SELECT f.id, to_char(f.competencia, 'MM/YYYY') AS competencia,
              COALESCE(NULLIF(c.razao_social, ''), c.nome) AS cliente, c.cpf_cnpj, f.descricao,
              f.valor::float AS valor, ${fat.sqlValorLiquido('f')} AS liquido,
              f.ret_ir::float AS ir, f.ret_csll::float AS csll, f.ret_pis::float AS pis, f.ret_cofins::float AS cofins,
              f.ret_inss::float AS inss, f.aliquota_iss::float AS iss, f.reter_iss,
              to_char(f.data_vencimento, 'DD/MM/YYYY') AS vencimento, f.status,
              to_char(f.data_pagamento, 'DD/MM/YYYY') AS pagamento, f.valor_pago::float AS valor_pago, f.forma_pagamento,
              f.nfse_numero, f.nfse_status
       FROM faturas f JOIN clientes c ON c.id = f.cliente_id
       WHERE f.empresa_id = $1 AND f.status <> 'rascunho' AND f.competencia >= $2 AND f.competencia < $3
       ORDER BY f.competencia, cliente`, [emp(req), ...p]);
    enviarCsv(res, `faturas_${req.query.inicio}_a_${req.query.fim}.csv`,
      ['Fatura', 'Competência', 'Cliente', 'CPF/CNPJ', 'Descrição', 'Valor da nota', 'Valor líquido', 'IRRF %', 'CSLL %',
       'PIS %', 'COFINS %', 'INSS %', 'ISS %', 'ISS retido', 'Vencimento', 'Situação', 'Pagamento', 'Valor pago', 'Forma',
       'NFS-e nº', 'NFS-e situação'],
      r.rows.map(x => [x.id, x.competencia, x.cliente, x.cpf_cnpj, x.descricao, x.valor, x.liquido, x.ir, x.csll, x.pis,
        x.cofins, x.inss, x.iss, x.reter_iss ? 'sim' : 'não', x.vencimento, x.status, x.pagamento, x.valor_pago,
        x.forma_pagamento, x.nfse_numero, x.nfse_status]));
  } catch (err) { erro500(res, 'Erro ao exportar faturas', err); }
});

router.get('/exportar/contas-pagar.csv', async (req, res) => {
  const p = periodoCsv(req, res);
  if (!p) return;
  try {
    const r = await pool.query(
      `SELECT cp.id, to_char(cp.competencia, 'MM/YYYY') AS competencia, cp.descricao, cp.documento,
              COALESCE(NULLIF(fo.razao_social, ''), fo.nome) AS fornecedor, fo.cnpj, cat.nome AS categoria,
              cp.valor::float AS valor, to_char(cp.data_vencimento, 'DD/MM/YYYY') AS vencimento, cp.status,
              to_char(cp.data_pagamento, 'DD/MM/YYYY') AS pagamento, cp.valor_pago::float AS valor_pago, cp.forma_pagamento
       ${FROM_CONTA}
       WHERE cp.empresa_id = $1 AND cp.status <> 'cancelada' AND cp.competencia >= $2 AND cp.competencia < $3
       ORDER BY cp.competencia, cp.data_vencimento`, [emp(req), ...p]);
    enviarCsv(res, `contas_pagar_${req.query.inicio}_a_${req.query.fim}.csv`,
      ['Conta', 'Competência', 'Descrição', 'Documento', 'Fornecedor', 'CNPJ', 'Categoria', 'Valor', 'Vencimento',
       'Situação', 'Pagamento', 'Valor pago', 'Forma'],
      r.rows.map(x => [x.id, x.competencia, x.descricao, x.documento, x.fornecedor, x.cnpj, x.categoria, x.valor,
        x.vencimento, x.status, x.pagamento, x.valor_pago, x.forma_pagamento]));
  } catch (err) { erro500(res, 'Erro ao exportar contas a pagar', err); }
});

module.exports = router;
