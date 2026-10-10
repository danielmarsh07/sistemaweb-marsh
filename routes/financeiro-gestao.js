/**
 * Financeiro, fase 2 — montado dentro de /api/financeiro, depois da trava de administrador.
 *
 * Contas a pagar (com recorrência mensal), categorias de despesa (com a linha da DRE),
 * fluxo de caixa (realizado + previsto) e DRE gerencial por competência.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const fat = require('../services/faturamento');

const emp = req => req.usuario.empresa_id || 1;
const vazioNulo = v => (v === undefined || v === null || String(v).trim() === '' ? null : v);
const competenciaValida = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const r2 = n => Math.round(Number(n || 0) * 100) / 100;

function erro500(res, msg, err) {
  console.error(`[financeiro] ${msg}:`, err.message);
  res.status(500).json({ erro: msg, detalhe: err.message });
}

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
  fora_resultado: 'Fora do resultado (lucros, empréstimos, investimentos)'
};

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
  if (r.rows.length) return;
  for (const [nome, grupo] of CATEGORIAS_PADRAO) {
    await pool.query(
      `INSERT INTO categorias_transacao (empresa_id, nome, tipo, grupo_dre) VALUES ($1, $2, 'saída', $3)
       ON CONFLICT (empresa_id, nome, tipo) DO UPDATE SET grupo_dre = COALESCE(categorias_transacao.grupo_dre, EXCLUDED.grupo_dre)`,
      [empresa_id, nome, grupo]);
  }
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

// ===== Contas a pagar =====
const COLUNAS_CONTA = `
  cp.id, cp.fornecedor_id, cp.categoria_id, cp.descricao, cp.documento, cp.valor::float AS valor,
  to_char(cp.competencia, 'YYYY-MM-DD') AS competencia,
  to_char(cp.data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
  cp.status, to_char(cp.data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
  cp.valor_pago::float AS valor_pago, cp.forma_pagamento, cp.grupo_id, cp.parcela, cp.total_parcelas,
  cp.observacoes, cp.data_criacao,
  (cp.status = 'aberta' AND cp.data_vencimento < CURRENT_DATE) AS vencida,
  COALESCE(NULLIF(fo.nome, ''), fo.razao_social) AS fornecedor_nome,
  cat.nome AS categoria_nome, COALESCE(cat.grupo_dre, 'despesa_administrativa') AS grupo_dre`;

const FROM_CONTA = `
  FROM contas_pagar cp
  LEFT JOIN fornecedores fo ON fo.id = cp.fornecedor_id
  LEFT JOIN categorias_transacao cat ON cat.id = cp.categoria_id`;

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

async function validarConta(b, empresa_id) {
  if (!vazioNulo(b.descricao)) return 'Informe a descrição.';
  if (!(Number(b.valor) > 0)) return 'Valor deve ser maior que zero.';
  if (!dataValida(b.data_vencimento)) return 'Data de vencimento inválida.';
  if (!competenciaValida(b.competencia)) return 'Competência no formato AAAA-MM.';
  if (!b.categoria_id) return 'Escolha a categoria (define a linha da DRE).';
  const cat = await pool.query(
    `SELECT 1 FROM categorias_transacao WHERE id = $1 AND empresa_id = $2 AND tipo = 'saída'`, [b.categoria_id, empresa_id]);
  if (!cat.rows.length) return 'Categoria inválida.';
  if (vazioNulo(b.fornecedor_id) !== null) {
    const fo = await pool.query('SELECT 1 FROM fornecedores WHERE id = $1 AND empresa_id = $2', [b.fornecedor_id, empresa_id]);
    if (!fo.rows.length) return 'Fornecedor inválido.';
  }
  return null;
}

// POST /contas-pagar — repetir_meses > 1 cria uma conta por mês (mesmo dia de vencimento)
router.post('/contas-pagar', async (req, res) => {
  const b = req.body || {};
  const e = await validarConta(b, emp(req)).catch(err => err.message);
  if (e) return res.status(400).json({ erro: e });
  const n = Number(b.repetir_meses || 1);
  if (!Number.isInteger(n) || n < 1 || n > 60) return res.status(400).json({ erro: 'Repetição: de 1 a 60 meses.' });
  const pagaAgora = !!b.ja_paga;
  if (pagaAgora && !dataValida(b.data_pagamento)) return res.status(400).json({ erro: 'Data do pagamento inválida.' });

  const grupo = n > 1 ? crypto.randomUUID() : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < n; i++) {
      const paga = pagaAgora && i === 0; // só a primeira entra como paga
      await client.query(
        `INSERT INTO contas_pagar (empresa_id, fornecedor_id, categoria_id, descricao, documento, valor, competencia,
           data_vencimento, status, data_pagamento, valor_pago, forma_pagamento, grupo_id, parcela, total_parcelas,
           observacoes, criado_por_usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [emp(req), vazioNulo(b.fornecedor_id), b.categoria_id, b.descricao.trim(), vazioNulo(b.documento), Number(b.valor),
         somarMeses(`${b.competencia}-01`, i), somarMeses(b.data_vencimento, i),
         paga ? 'paga' : 'aberta', paga ? b.data_pagamento : null, paga ? Number(b.valor) : null,
         paga ? (vazioNulo(b.forma_pagamento) || 'transferencia') : null,
         grupo, grupo ? i + 1 : null, grupo ? n : null, vazioNulo(b.observacoes), req.usuario.id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ mensagem: n > 1 ? `${n} contas criadas (uma por mês).` : 'Conta criada!' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    erro500(res, 'Erro ao criar conta', err);
  } finally { client.release(); }
});

// PUT /contas-pagar/:id — aplicar_seguintes: replica descrição, valor, categoria e fornecedor nas próximas em aberto da série
router.put('/contas-pagar/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const c = await carregarConta(req.params.id, emp(req));
    if (!c) return res.status(404).json({ erro: 'Conta não encontrada.' });
    if (c.status === 'cancelada') return res.status(400).json({ erro: 'Conta cancelada não pode ser editada.' });
    const e = await validarConta(b, emp(req));
    if (e) return res.status(400).json({ erro: e });
    await pool.query(
      `UPDATE contas_pagar SET fornecedor_id=$1, categoria_id=$2, descricao=$3, documento=$4, valor=$5,
         competencia=$6::date, data_vencimento=$7::date, observacoes=$8,
         atualizado_por_usuario_id=$9, data_atualizacao=NOW()
       WHERE id=$10`,
      [vazioNulo(b.fornecedor_id), b.categoria_id, b.descricao.trim(), vazioNulo(b.documento), Number(b.valor),
       `${b.competencia}-01`, b.data_vencimento, vazioNulo(b.observacoes), req.usuario.id, c.id]);
    let extras = 0;
    if (b.aplicar_seguintes && c.grupo_id) {
      const r = await pool.query(
        `UPDATE contas_pagar SET fornecedor_id=$1, categoria_id=$2, descricao=$3, valor=$4,
           atualizado_por_usuario_id=$5, data_atualizacao=NOW()
         WHERE grupo_id=$6 AND empresa_id=$7 AND parcela > $8 AND status = 'aberta'`,
        [vazioNulo(b.fornecedor_id), b.categoria_id, b.descricao.trim(), Number(b.valor), req.usuario.id,
         c.grupo_id, emp(req), c.parcela]);
      extras = r.rowCount;
    }
    res.json({ mensagem: extras ? `Conta atualizada, e mais ${extras} da série.` : 'Conta atualizada!' });
  } catch (err) { erro500(res, 'Erro ao atualizar conta', err); }
});

// DELETE /contas-pagar/:id?seguintes=1 — só em aberto; com seguintes, apaga também as próximas da série
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
    } else {
      r = await pool.query('DELETE FROM contas_pagar WHERE id = $1', [c.id]);
    }
    res.json({ mensagem: r.rowCount > 1 ? `${r.rowCount} contas excluídas.` : 'Conta excluída.' });
  } catch (err) { erro500(res, 'Erro ao excluir conta', err); }
});

router.post('/contas-pagar/:id/baixa', async (req, res) => {
  const b = req.body || {};
  if (!dataValida(b.data_pagamento)) return res.status(400).json({ erro: 'Data do pagamento inválida.' });
  if (!(Number(b.valor_pago) > 0)) return res.status(400).json({ erro: 'Valor pago deve ser maior que zero.' });
  try {
    const r = await pool.query(
      `UPDATE contas_pagar SET status = 'paga', data_pagamento = $1, valor_pago = $2, forma_pagamento = $3,
         atualizado_por_usuario_id = $4, data_atualizacao = NOW()
       WHERE id = $5 AND empresa_id = $6 AND status = 'aberta' RETURNING id`,
      [b.data_pagamento, Number(b.valor_pago), vazioNulo(b.forma_pagamento) || 'transferencia', req.usuario.id,
       req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só contas em aberto recebem baixa.' });
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

// ===== Fluxo de caixa =====
// Realizado = faturas recebidas e contas pagas (pela data do pagamento).
// Previsto  = faturas e contas em aberto (atrasadas caem no mês atual) + contratos ativos ainda sem fatura (estimado).
router.get('/fluxo-caixa', async (req, res) => {
  const inicio = req.query.inicio;
  const meses = Number(req.query.meses || 12);
  if (!competenciaValida(inicio)) return res.status(400).json({ erro: 'Início no formato AAAA-MM.' });
  if (!Number.isInteger(meses) || meses < 1 || meses > 24) return res.status(400).json({ erro: 'Período: 1 a 24 meses.' });
  const empresa = emp(req);
  const ini = `${inicio}-01`;
  const fim = somarMeses(ini, meses); // exclusivo
  try {
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

    res.json({
      saldo_inicial: saldoIni, saldo_inicial_data: dataSaldo, mes_atual: mesAtual,
      meses: resultado, proximos: proximos.rows
    });
  } catch (err) { erro500(res, 'Erro ao montar fluxo de caixa', err); }
});

// ===== DRE gerencial (regime de competência) =====
// Receita = faturas aprovadas da competência. Retenções feitas pelo cliente entram como imposto:
// PIS/COFINS/INSS e ISS retido → impostos sobre o faturamento; IRRF/CSLL → IRPJ e CSLL (são antecipação).
// Despesas = contas a pagar não canceladas, pela competência, na linha da DRE da categoria.
router.get('/dre', async (req, res) => {
  const ano = Number(req.query.ano);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return res.status(400).json({ erro: 'Ano inválido.' });
  const empresa = emp(req);
  try {
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
        `SELECT EXTRACT(MONTH FROM cp.competencia)::int AS mes, COALESCE(cat.grupo_dre, 'despesa_administrativa') AS grupo,
                COALESCE(cat.nome, 'Sem categoria') AS categoria, SUM(cp.valor)::float AS total
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
    res.json({
      ano, linhas,
      fora_resultado: { valores: fora.map(r2), total: r2(fora.reduce((s, v) => s + v, 0)) }
    });
  } catch (err) { erro500(res, 'Erro ao montar DRE', err); }
});

module.exports = router;
