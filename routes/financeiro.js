/**
 * /api/financeiro — faturamento mensal (requer login).
 *
 * Cliente: GET /minhas-faturas (portal).
 * Admin: contratos recorrentes, fechamento do mês (gera rascunhos), aprovação (NFS-e via Asaas + e-mail),
 *        baixa manual de pagamento, cancelamento, resumo e configuração.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const asaas = require('../services/asaas');
const email = require('../services/email');
const fat = require('../services/faturamento');

const COLUNAS_CONTRATO = `
  ct.id, ct.cliente_id, ct.descricao, ct.descricao_servico, ct.valor::float AS valor, ct.dia_vencimento,
  to_char(ct.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(ct.data_fim, 'YYYY-MM-DD') AS data_fim,
  ct.indice_reajuste, ct.mes_reajuste, ct.emitir_nfse, ct.codigo_servico, ct.nome_servico,
  ct.aliquota_iss::float AS aliquota_iss, ct.reter_iss, ct.status, ct.observacoes, ct.data_criacao,
  ct.ret_ir::float AS ret_ir, ct.ret_csll::float AS ret_csll, ct.ret_pis::float AS ret_pis,
  ct.ret_cofins::float AS ret_cofins, ct.ret_inss::float AS ret_inss`;

const NOME_CLIENTE = `COALESCE(NULLIF(c.nome_fantasia, ''), c.razao_social, c.nome)`;

const emp = req => req.usuario.empresa_id || 1;
const vazioNulo = v => (v === undefined || v === null || String(v).trim() === '' ? null : v);
const RET = fat.RETENCOES;
const pctOuNulo = v => (vazioNulo(v) === null ? null : Number(v));
function validarRetencoes(b) {
  for (const r of RET) {
    if (vazioNulo(b[r]) !== null && !(Number(b[r]) >= 0 && Number(b[r]) <= 20)) return 'Retenções devem estar entre 0 e 20%.';
  }
  return null;
}
const competenciaValida = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));

function erro500(res, msg, err) {
  console.error(`[financeiro] ${msg}:`, err.message);
  res.status(500).json({ erro: msg, detalhe: err.message });
}

// ===== Portal do cliente =====
router.get('/minhas-faturas', async (req, res) => {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT f.id, to_char(f.competencia, 'YYYY-MM-DD') AS competencia, f.descricao, f.valor::float AS valor,
              to_char(f.data_vencimento, 'YYYY-MM-DD') AS data_vencimento, f.status,
              to_char(f.data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
              f.nfse_status, f.nfse_numero, f.nfse_pdf_url, f.nfse_xml_url,
              ${fat.sqlValorLiquido('f')} AS valor_liquido,
              (f.status = 'aberta' AND f.data_vencimento < CURRENT_DATE) AS vencida
       FROM faturas f
       WHERE f.cliente_id = $1 AND f.status IN ('aberta', 'paga')
       ORDER BY f.competencia DESC, f.id DESC
       LIMIT 60`, [req.usuario.cliente_id]);
    const config = await fat.carregarConfig(req.usuario.empresa_id || 1);
    res.json({
      faturas: r.rows,
      pagamento: { pix_chave: config.pix_chave, instrucoes: config.instrucoes_pagamento }
    });
  } catch (err) { erro500(res, 'Erro ao buscar faturas', err); }
});

// ===== Daqui para baixo: só administradores =====
router.use((req, res, next) => {
  const tipo = req.usuario.tipo;
  if (tipo !== 'admin_empresa' && tipo !== 'admin_sistema') {
    return res.status(403).json({ erro: 'Apenas administradores acessam o financeiro.' });
  }
  next();
});

// GET /status — integrações disponíveis
router.get('/status', (req, res) => {
  res.json({
    asaas_configurado: asaas.configurado(),
    asaas_ambiente: asaas.ambiente(),
    webhook_configurado: !!process.env.ASAAS_WEBHOOK_TOKEN,
    email_configurado: email.emailConfigurado()
  });
});

// ===== Configuração =====
router.get('/config', async (req, res) => {
  try { res.json(await fat.carregarConfig(emp(req))); }
  catch (err) { erro500(res, 'Erro ao buscar configuração', err); }
});

router.put('/config', async (req, res) => {
  const b = req.body || {};
  const aliquota = Number(b.aliquota_iss || 0);
  if (isNaN(aliquota) || aliquota < 0 || aliquota > 5) return res.status(400).json({ erro: 'Alíquota de ISS deve estar entre 0 e 5%.' });
  const eRet = validarRetencoes(b);
  if (eRet) return res.status(400).json({ erro: eRet });
  const dias = Number(b.dias_lembrete ?? 3);
  if (!Number.isInteger(dias) || dias < 0 || dias > 30) return res.status(400).json({ erro: 'Dias para lembrete: 0 a 30 (0 desliga).' });
  try {
    await pool.query(
      `INSERT INTO financeiro_config (empresa_id, instrucoes_pagamento, pix_chave, codigo_servico, nome_servico,
         aliquota_iss, email_copia, dias_lembrete, vencimento_mes_seguinte,
         ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss, data_atualizacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         instrucoes_pagamento = EXCLUDED.instrucoes_pagamento, pix_chave = EXCLUDED.pix_chave,
         codigo_servico = EXCLUDED.codigo_servico, nome_servico = EXCLUDED.nome_servico,
         aliquota_iss = EXCLUDED.aliquota_iss, email_copia = EXCLUDED.email_copia,
         dias_lembrete = EXCLUDED.dias_lembrete, vencimento_mes_seguinte = EXCLUDED.vencimento_mes_seguinte,
         ret_ir = EXCLUDED.ret_ir, ret_csll = EXCLUDED.ret_csll, ret_pis = EXCLUDED.ret_pis,
         ret_cofins = EXCLUDED.ret_cofins, ret_inss = EXCLUDED.ret_inss,
         data_atualizacao = NOW()`,
      [emp(req), vazioNulo(b.instrucoes_pagamento), vazioNulo(b.pix_chave), vazioNulo(b.codigo_servico),
       vazioNulo(b.nome_servico), aliquota, vazioNulo(b.email_copia), dias, b.vencimento_mes_seguinte !== false,
       ...RET.map(r => Number(b[r] || 0))]);
    res.json({ mensagem: 'Configuração salva!' });
  } catch (err) { erro500(res, 'Erro ao salvar configuração', err); }
});

// ===== Contratos =====
function validarContrato(b) {
  if (!b.cliente_id) return 'Selecione o cliente.';
  if (!vazioNulo(b.descricao)) return 'Informe o nome do contrato.';
  if (!vazioNulo(b.descricao_servico)) return 'Informe a descrição do serviço (vai na nota fiscal).';
  const valor = Number(b.valor);
  if (!(valor > 0)) return 'Valor mensal deve ser maior que zero.';
  const dia = Number(b.dia_vencimento);
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) return 'Dia de vencimento: 1 a 28.';
  if (!dataValida(b.data_inicio)) return 'Data de início inválida.';
  if (vazioNulo(b.data_fim) && (!dataValida(b.data_fim) || b.data_fim < b.data_inicio)) return 'Data de fim inválida.';
  if (!['nenhum', 'IPCA', 'IGPM'].includes(b.indice_reajuste || 'nenhum')) return 'Índice de reajuste inválido.';
  if (vazioNulo(b.aliquota_iss) !== null && (Number(b.aliquota_iss) < 0 || Number(b.aliquota_iss) > 5)) return 'Alíquota de ISS: 0 a 5%.';
  if (b.status && !['ativo', 'suspenso', 'encerrado'].includes(b.status)) return 'Status inválido.';
  return validarRetencoes(b);
}

function paramsContrato(b) {
  return [
    b.cliente_id, b.descricao.trim(), b.descricao_servico.trim(), Number(b.valor), Number(b.dia_vencimento),
    b.data_inicio, vazioNulo(b.data_fim), b.indice_reajuste || 'nenhum',
    vazioNulo(b.mes_reajuste) === null ? null : Number(b.mes_reajuste),
    b.emitir_nfse !== false, vazioNulo(b.codigo_servico), vazioNulo(b.nome_servico),
    vazioNulo(b.aliquota_iss) === null ? null : Number(b.aliquota_iss), !!b.reter_iss,
    b.status || 'ativo', vazioNulo(b.observacoes),
    ...RET.map(r => pctOuNulo(b[r]))
  ];
}

router.get('/contratos', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${COLUNAS_CONTRATO}, ${NOME_CLIENTE} AS cliente_nome
       FROM contratos ct JOIN clientes c ON c.id = ct.cliente_id
       WHERE ct.empresa_id = $1
       ORDER BY ct.status = 'ativo' DESC, cliente_nome`, [emp(req)]);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao buscar contratos', err); }
});

router.post('/contratos', async (req, res) => {
  const b = req.body || {};
  const e = validarContrato(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const cli = await pool.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE', [b.cliente_id, emp(req)]);
    if (!cli.rows.length) return res.status(400).json({ erro: 'Cliente inválido.' });
    const r = await pool.query(
      `INSERT INTO contratos (cliente_id, descricao, descricao_servico, valor, dia_vencimento, data_inicio, data_fim,
         indice_reajuste, mes_reajuste, emitir_nfse, codigo_servico, nome_servico, aliquota_iss, reter_iss,
         status, observacoes, ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss, empresa_id, criado_por_usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
      [...paramsContrato(b), emp(req), req.usuario.id]);
    res.status(201).json({ mensagem: 'Contrato criado!', id: r.rows[0].id });
  } catch (err) { erro500(res, 'Erro ao criar contrato', err); }
});

router.put('/contratos/:id', async (req, res) => {
  const b = req.body || {};
  const e = validarContrato(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const r = await pool.query(
      `UPDATE contratos SET cliente_id=$1, descricao=$2, descricao_servico=$3, valor=$4, dia_vencimento=$5,
         data_inicio=$6, data_fim=$7, indice_reajuste=$8, mes_reajuste=$9, emitir_nfse=$10, codigo_servico=$11,
         nome_servico=$12, aliquota_iss=$13, reter_iss=$14, status=$15, observacoes=$16,
         ret_ir=$17, ret_csll=$18, ret_pis=$19, ret_cofins=$20, ret_inss=$21,
         atualizado_por_usuario_id=$24, data_atualizacao=NOW()
       WHERE id = $22 AND empresa_id = $23 RETURNING id`,
      [...paramsContrato(b), req.params.id, emp(req), req.usuario.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    res.json({ mensagem: 'Contrato atualizado! Faturas já geradas não mudam.' });
  } catch (err) { erro500(res, 'Erro ao atualizar contrato', err); }
});

// DELETE: sem faturas → apaga; com faturas → encerra (mantém o histórico)
router.delete('/contratos/:id', async (req, res) => {
  try {
    const usado = await pool.query('SELECT 1 FROM faturas WHERE contrato_id = $1 LIMIT 1', [req.params.id]);
    if (usado.rows.length) {
      const r = await pool.query(
        `UPDATE contratos SET status = 'encerrado', data_fim = COALESCE(data_fim, CURRENT_DATE), data_atualizacao = NOW()
         WHERE id = $1 AND empresa_id = $2 RETURNING id`, [req.params.id, emp(req)]);
      if (!r.rows.length) return res.status(404).json({ erro: 'Contrato não encontrado.' });
      return res.json({ mensagem: 'Contrato encerrado (tem faturas, o histórico foi mantido).' });
    }
    const r = await pool.query('DELETE FROM contratos WHERE id = $1 AND empresa_id = $2 RETURNING id', [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    res.json({ mensagem: 'Contrato excluído.' });
  } catch (err) { erro500(res, 'Erro ao excluir contrato', err); }
});

// ===== Fechamento do mês =====
// Contratos que entram na competência: ativos e vigentes em algum dia do mês
const SQL_ELEGIVEIS = `
  SELECT ${COLUNAS_CONTRATO}, ${NOME_CLIENTE} AS cliente_nome,
         (SELECT f.id FROM faturas f WHERE f.contrato_id = ct.id AND f.competencia = $2::date AND f.status <> 'cancelada' LIMIT 1) AS fatura_id
  FROM contratos ct JOIN clientes c ON c.id = ct.cliente_id
  WHERE ct.empresa_id = $1 AND ct.status = 'ativo'
    AND ct.data_inicio <= ($2::date + INTERVAL '1 month - 1 day')
    AND (ct.data_fim IS NULL OR ct.data_fim >= $2::date)
  ORDER BY cliente_nome`;

router.get('/fechamento', async (req, res) => {
  const comp = req.query.competencia;
  if (!competenciaValida(comp)) return res.status(400).json({ erro: 'Competência no formato AAAA-MM.' });
  try {
    const r = await pool.query(SQL_ELEGIVEIS, [emp(req), `${comp}-01`]);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao montar fechamento', err); }
});

// POST /fechamento { competencia } — gera rascunhos dos contratos que ainda não têm fatura no mês
router.post('/fechamento', async (req, res) => {
  const comp = (req.body || {}).competencia;
  if (!competenciaValida(comp)) return res.status(400).json({ erro: 'Competência no formato AAAA-MM.' });
  const inicio = `${comp}-01`;
  const client = await pool.connect();
  try {
    const config = await fat.carregarConfig(emp(req));
    const elegiveis = (await client.query(SQL_ELEGIVEIS, [emp(req), inicio])).rows.filter(c => !c.fatura_id);
    await client.query('BEGIN');
    let geradas = 0;
    for (const c of elegiveis) {
      // Vencimento: dia do contrato no mês seguinte à competência (ou no próprio mês, conforme a configuração)
      const r = await client.query(
        `INSERT INTO faturas (empresa_id, cliente_id, contrato_id, competencia, descricao, valor, data_vencimento,
           emitir_nfse, codigo_servico, nome_servico, aliquota_iss, reter_iss, criado_por_usuario_id,
           ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss)
         VALUES ($1, $2, $3, $4::date, $5, $6,
           ($4::date + ($7::text || ' month')::interval + ($8::int - 1) * INTERVAL '1 day')::date,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT DO NOTHING RETURNING id`,
        [emp(req), c.cliente_id, c.id, inicio, c.descricao_servico, c.valor,
         config.vencimento_mes_seguinte === false ? '0' : '1', c.dia_vencimento,
         c.emitir_nfse, c.codigo_servico || config.codigo_servico, c.nome_servico || config.nome_servico,
         c.aliquota_iss ?? config.aliquota_iss, c.reter_iss, req.usuario.id,
         ...RET.map(r => c[r] ?? config[r] ?? 0)]);
      geradas += r.rowCount;
    }
    await client.query('COMMIT');
    res.json({ mensagem: geradas ? `${geradas} fatura(s) gerada(s) como rascunho. Revise e aprove.` : 'Nenhuma fatura nova: todos os contratos já têm fatura neste mês.', geradas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    erro500(res, 'Erro ao gerar faturas', err);
  } finally { client.release(); }
});

// ===== Faturas =====
router.get('/faturas', async (req, res) => {
  const { competencia, status, cliente_id } = req.query;
  const where = ['f.empresa_id = $1'];
  const params = [emp(req)];
  if (competencia) {
    if (!competenciaValida(competencia)) return res.status(400).json({ erro: 'Competência no formato AAAA-MM.' });
    params.push(`${competencia}-01`); where.push(`f.competencia = $${params.length}::date`);
  }
  if (status === 'vencida') where.push(`f.status = 'aberta' AND f.data_vencimento < CURRENT_DATE`);
  else if (status === 'pendentes') where.push(`f.status = 'aberta'`);
  else if (status) { params.push(status); where.push(`f.status = $${params.length}`); }
  if (cliente_id) { params.push(cliente_id); where.push(`f.cliente_id = $${params.length}`); }
  try {
    const r = await pool.query(
      `SELECT ${fat.COLUNAS_FATURA}, ${NOME_CLIENTE} AS cliente_nome, ct.descricao AS contrato_descricao
       FROM faturas f JOIN clientes c ON c.id = f.cliente_id LEFT JOIN contratos ct ON ct.id = f.contrato_id
       WHERE ${where.join(' AND ')}
       ORDER BY f.status = 'rascunho' DESC, f.data_vencimento, cliente_nome
       LIMIT 500`, params);
    res.json(r.rows);
  } catch (err) { erro500(res, 'Erro ao buscar faturas', err); }
});

function validarFatura(b, avulsa) {
  if (avulsa && !b.cliente_id) return 'Selecione o cliente.';
  if (avulsa && !competenciaValida(b.competencia)) return 'Competência no formato AAAA-MM.';
  if (!vazioNulo(b.descricao)) return 'Informe a descrição (vai na nota fiscal).';
  if (!(Number(b.valor) > 0)) return 'Valor deve ser maior que zero.';
  if (!dataValida(b.data_vencimento)) return 'Data de vencimento inválida.';
  if (vazioNulo(b.aliquota_iss) !== null && (Number(b.aliquota_iss) < 0 || Number(b.aliquota_iss) > 5)) return 'Alíquota de ISS: 0 a 5%.';
  return validarRetencoes(b);
}

// POST /faturas — fatura avulsa (fora de contrato), nasce como rascunho
router.post('/faturas', async (req, res) => {
  const b = req.body || {};
  const e = validarFatura(b, true);
  if (e) return res.status(400).json({ erro: e });
  try {
    const cli = await pool.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE', [b.cliente_id, emp(req)]);
    if (!cli.rows.length) return res.status(400).json({ erro: 'Cliente inválido.' });
    const config = await fat.carregarConfig(emp(req));
    const r = await pool.query(
      `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, observacoes,
         emitir_nfse, codigo_servico, nome_servico, aliquota_iss, reter_iss, criado_por_usuario_id,
         ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [emp(req), b.cliente_id, `${b.competencia}-01`, b.descricao.trim(), Number(b.valor), b.data_vencimento,
       vazioNulo(b.observacoes), b.emitir_nfse !== false,
       vazioNulo(b.codigo_servico) || config.codigo_servico, vazioNulo(b.nome_servico) || config.nome_servico,
       vazioNulo(b.aliquota_iss) === null ? config.aliquota_iss : Number(b.aliquota_iss), !!b.reter_iss, req.usuario.id,
       ...RET.map(r => (vazioNulo(b[r]) === null ? (config[r] ?? 0) : Number(b[r])))]);
    res.status(201).json({ mensagem: 'Fatura avulsa criada como rascunho.', id: r.rows[0].id });
  } catch (err) { erro500(res, 'Erro ao criar fatura', err); }
});

// PUT /faturas/:id — rascunho: tudo; aberta: só vencimento e observações (a nota já foi emitida)
router.put('/faturas/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const f = await fat.carregarFatura(req.params.id, emp(req));
    if (!f) return res.status(404).json({ erro: 'Fatura não encontrada.' });
    if (f.status === 'rascunho') {
      const e = validarFatura(b, false);
      if (e) return res.status(400).json({ erro: e });
      await pool.query(
        `UPDATE faturas SET descricao=$1, valor=$2, data_vencimento=$3, observacoes=$4, emitir_nfse=$5,
           codigo_servico=$6, nome_servico=$7, aliquota_iss=$8, reter_iss=$9,
           ret_ir=$12, ret_csll=$13, ret_pis=$14, ret_cofins=$15, ret_inss=$16,
           atualizado_por_usuario_id=$10, data_atualizacao=NOW() WHERE id=$11`,
        [b.descricao.trim(), Number(b.valor), b.data_vencimento, vazioNulo(b.observacoes), b.emitir_nfse !== false,
         vazioNulo(b.codigo_servico), vazioNulo(b.nome_servico),
         vazioNulo(b.aliquota_iss) === null ? null : Number(b.aliquota_iss), !!b.reter_iss, req.usuario.id, f.id,
         ...RET.map(r => Number(b[r] || 0))]);
    } else if (f.status === 'aberta') {
      if (!dataValida(b.data_vencimento)) return res.status(400).json({ erro: 'Data de vencimento inválida.' });
      await pool.query(
        `UPDATE faturas SET data_vencimento=$1, observacoes=$2, atualizado_por_usuario_id=$3, data_atualizacao=NOW() WHERE id=$4`,
        [b.data_vencimento, vazioNulo(b.observacoes), req.usuario.id, f.id]);
    } else {
      return res.status(400).json({ erro: 'Fatura paga ou cancelada não pode ser editada.' });
    }
    res.json({ mensagem: 'Fatura atualizada!' });
  } catch (err) { erro500(res, 'Erro ao atualizar fatura', err); }
});

// DELETE /faturas/:id — só rascunho (depois de aprovada, use cancelar)
router.delete('/faturas/:id', async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM faturas WHERE id = $1 AND empresa_id = $2 AND status = 'rascunho' RETURNING id`,
      [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só rascunhos podem ser excluídos. Para faturas aprovadas, use Cancelar.' });
    res.json({ mensagem: 'Rascunho excluído.' });
  } catch (err) { erro500(res, 'Erro ao excluir fatura', err); }
});

// POST /faturas/aprovar { ids } — aprova rascunhos: emite NFS-e e envia por e-mail
router.post('/faturas/aprovar', async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number).filter(Boolean).slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ erro: 'Selecione ao menos uma fatura.' });
  const resultados = [];
  for (const id of ids) {
    try {
      const f = await fat.carregarFatura(id, emp(req));
      if (!f || f.status !== 'rascunho') { resultados.push({ id, erro: 'Não é rascunho.' }); continue; }
      resultados.push(await fat.aprovarFatura(f, req.usuario.id));
    } catch (err) {
      resultados.push({ id, erro: err.message });
    }
  }
  res.json({ resultados });
});

// POST /faturas/:id/nfse — emite (ou tenta de novo após erro)
router.post('/faturas/:id/nfse', async (req, res) => {
  try {
    const f = await fat.carregarFatura(req.params.id, emp(req));
    if (!f) return res.status(404).json({ erro: 'Fatura não encontrada.' });
    if (f.status !== 'aberta' && f.status !== 'paga') return res.status(400).json({ erro: 'Aprove a fatura antes de emitir a nota.' });
    if (!['nao_emitida', 'erro'].includes(f.nfse_status)) return res.status(400).json({ erro: 'A nota desta fatura já foi enviada ao Asaas.' });
    if (!asaas.configurado()) return res.status(400).json({ erro: 'Asaas não configurado: defina ASAAS_API_KEY no servidor para emitir NFS-e.' });
    if (!f.emitir_nfse) await pool.query('UPDATE faturas SET emitir_nfse = TRUE WHERE id = $1', [f.id]);
    const status = await fat.emitirNfse({ ...f, emitir_nfse: true });
    await fat.aposAtualizarNota(f.id, emp(req));
    const atual = await fat.carregarFatura(f.id, emp(req));
    res.json({ nfse_status: status, nfse_erro: atual.nfse_erro });
  } catch (err) { erro500(res, 'Erro ao emitir NFS-e', err); }
});

// POST /faturas/:id/nfse/sincronizar — consulta o status da nota no Asaas
router.post('/faturas/:id/nfse/sincronizar', async (req, res) => {
  try {
    const f = await fat.carregarFatura(req.params.id, emp(req));
    if (!f) return res.status(404).json({ erro: 'Fatura não encontrada.' });
    if (!f.nfse_asaas_id) return res.status(400).json({ erro: 'Esta fatura não tem nota no Asaas.' });
    res.json({ nfse_status: await fat.sincronizarNfse(f) });
  } catch (err) { erro500(res, 'Erro ao consultar NFS-e', err); }
});

// POST /faturas/:id/enviar-email — (re)envia a fatura ao cliente
router.post('/faturas/:id/enviar-email', async (req, res) => {
  try {
    const f = await fat.carregarFatura(req.params.id, emp(req));
    if (!f) return res.status(404).json({ erro: 'Fatura não encontrada.' });
    if (f.status === 'rascunho' || f.status === 'cancelada') return res.status(400).json({ erro: 'Só faturas aprovadas podem ser enviadas.' });
    if (!email.emailConfigurado()) return res.status(400).json({ erro: 'Envio de e-mail não configurado (RESEND_API_KEY).' });
    const ok = await fat.enviarEmailFatura(f);
    if (!ok) return res.status(400).json({ erro: 'Não foi possível enviar: confira o e-mail financeiro do cliente.' });
    res.json({ mensagem: 'Fatura enviada por e-mail!' });
  } catch (err) { erro500(res, 'Erro ao enviar e-mail', err); }
});

// POST /faturas/:id/baixa { data_pagamento, valor_pago, forma_pagamento }
router.post('/faturas/:id/baixa', async (req, res) => {
  const b = req.body || {};
  if (!dataValida(b.data_pagamento)) return res.status(400).json({ erro: 'Data do pagamento inválida.' });
  if (!(Number(b.valor_pago) > 0)) return res.status(400).json({ erro: 'Valor recebido deve ser maior que zero.' });
  try {
    const r = await pool.query(
      `UPDATE faturas SET status = 'paga', data_pagamento = $1, valor_pago = $2, forma_pagamento = $3,
         atualizado_por_usuario_id = $4, data_atualizacao = NOW()
       WHERE id = $5 AND empresa_id = $6 AND status = 'aberta' RETURNING id`,
      [b.data_pagamento, Number(b.valor_pago), vazioNulo(b.forma_pagamento) || 'transferencia', req.usuario.id, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só faturas em aberto recebem baixa.' });
    res.json({ mensagem: 'Pagamento registrado!' });
  } catch (err) { erro500(res, 'Erro ao registrar pagamento', err); }
});

router.post('/faturas/:id/estornar-baixa', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE faturas SET status = 'aberta', data_pagamento = NULL, valor_pago = NULL, forma_pagamento = NULL,
         atualizado_por_usuario_id = $1, data_atualizacao = NOW()
       WHERE id = $2 AND empresa_id = $3 AND status = 'paga' RETURNING id`, [req.usuario.id, req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(400).json({ erro: 'Só faturas pagas podem ter a baixa desfeita.' });
    res.json({ mensagem: 'Baixa desfeita: fatura voltou para em aberto.' });
  } catch (err) { erro500(res, 'Erro ao desfazer baixa', err); }
});

// POST /faturas/:id/cancelar — cancela a fatura e pede o cancelamento da NFS-e no Asaas
router.post('/faturas/:id/cancelar', async (req, res) => {
  try {
    const f = await fat.carregarFatura(req.params.id, emp(req));
    if (!f) return res.status(404).json({ erro: 'Fatura não encontrada.' });
    if (f.status === 'paga') return res.status(400).json({ erro: 'Desfaça a baixa antes de cancelar.' });
    if (f.status === 'cancelada') return res.status(400).json({ erro: 'Fatura já cancelada.' });
    if (f.status === 'rascunho') return res.status(400).json({ erro: 'Rascunho não se cancela: exclua.' });

    let aviso = null;
    if (f.nfse_asaas_id && ['emitida', 'processando'].includes(f.nfse_status)) {
      try {
        const nota = await asaas.cancelarNota(f.nfse_asaas_id);
        await asaas.aplicarNotaNaFatura(f.id, nota);
      } catch (err) {
        return res.status(400).json({ erro: `A nota fiscal não pôde ser cancelada: ${err.message}. A fatura continua aberta.` });
      }
      aviso = 'Cancelamento da NFS-e solicitado à prefeitura.';
    }
    await pool.query(
      `UPDATE faturas SET status = 'cancelada', atualizado_por_usuario_id = $1, data_atualizacao = NOW() WHERE id = $2`,
      [req.usuario.id, f.id]);
    res.json({ mensagem: `Fatura cancelada.${aviso ? ' ' + aviso : ''}` });
  } catch (err) { erro500(res, 'Erro ao cancelar fatura', err); }
});

// ===== Resumo (cards do topo) =====
router.get('/resumo', async (req, res) => {
  const comp = req.query.competencia;
  if (!competenciaValida(comp)) return res.status(400).json({ erro: 'Competência no formato AAAA-MM.' });
  try {
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(valor) FILTER (WHERE competencia = $2::date AND status IN ('aberta','paga')), 0)::float AS faturado,
         COUNT(*) FILTER (WHERE competencia = $2::date AND status IN ('aberta','paga'))::int AS qtd_faturado,
         COALESCE(SUM(valor_pago) FILTER (WHERE competencia = $2::date AND status = 'paga'), 0)::float AS recebido,
         COUNT(*) FILTER (WHERE competencia = $2::date AND status = 'paga')::int AS qtd_recebido,
         COALESCE(SUM(liquido) FILTER (WHERE status = 'aberta' AND data_vencimento >= CURRENT_DATE), 0)::float AS a_receber,
         COUNT(*) FILTER (WHERE status = 'aberta' AND data_vencimento >= CURRENT_DATE)::int AS qtd_a_receber,
         COALESCE(SUM(liquido) FILTER (WHERE status = 'aberta' AND data_vencimento < CURRENT_DATE), 0)::float AS vencido,
         COUNT(*) FILTER (WHERE status = 'aberta' AND data_vencimento < CURRENT_DATE)::int AS qtd_vencido,
         COUNT(*) FILTER (WHERE status = 'rascunho')::int AS qtd_rascunho
       FROM (SELECT f.*, ${fat.sqlValorLiquido('f')} AS liquido FROM faturas f WHERE f.empresa_id = $1) faturas`,
      [emp(req), `${comp}-01`]);
    const mrr = await pool.query(
      `SELECT COALESCE(SUM(valor), 0)::float AS mrr, COUNT(*)::int AS contratos
       FROM contratos WHERE empresa_id = $1 AND status = 'ativo' AND (data_fim IS NULL OR data_fim >= CURRENT_DATE)`, [emp(req)]);
    res.json({ ...r.rows[0], ...mrr.rows[0] });
  } catch (err) { erro500(res, 'Erro ao montar resumo', err); }
});

module.exports = router;
