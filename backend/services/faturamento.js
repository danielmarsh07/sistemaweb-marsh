// Regras do faturamento mensal, usadas pelas rotas, pelo webhook do Asaas e pela rotina periódica.
const pool = require('../db');
const asaas = require('./asaas');
const email = require('./email');

const RETENCOES = ['ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins', 'ret_inss'];

// Valor que o cliente efetivamente paga: valor da nota menos retenções federais e ISS retido
function sqlValorLiquido(a) {
  const soma = RETENCOES.map(r => `COALESCE(${a}.${r}, 0)`).join(' + ');
  return `ROUND(${a}.valor - ${a}.valor * (${soma}) / 100
    - CASE WHEN ${a}.reter_iss THEN ${a}.valor * COALESCE(${a}.aliquota_iss, 0) / 100 ELSE 0 END, 2)::float`;
}

// Datas sempre como texto AAAA-MM-DD (evita o "volta um dia" do fuso ao converter DATE em Date)
const COLUNAS_FATURA = `
  f.id, f.empresa_id, f.cliente_id, f.contrato_id,
  to_char(f.competencia, 'YYYY-MM-DD') AS competencia,
  f.descricao, f.valor::float AS valor,
  to_char(f.data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
  f.status, f.data_aprovacao,
  to_char(f.data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
  f.valor_pago::float AS valor_pago, f.forma_pagamento, f.observacoes,
  f.emitir_nfse, f.codigo_servico, f.nome_servico, f.aliquota_iss::float AS aliquota_iss, f.reter_iss,
  f.nfse_status, f.nfse_numero, f.nfse_codigo_verificacao, f.nfse_pdf_url, f.nfse_xml_url, f.nfse_erro, f.nfse_simulada,
  f.email_enviado_em, f.lembrete_enviado_em, f.data_criacao,
  f.ret_ir::float AS ret_ir, f.ret_csll::float AS ret_csll, f.ret_pis::float AS ret_pis,
  f.ret_cofins::float AS ret_cofins, f.ret_inss::float AS ret_inss,
  ${sqlValorLiquido('f')} AS valor_liquido,
  (f.status = 'aberta' AND f.data_vencimento < CURRENT_DATE) AS vencida,
  f.pix_asaas_id, f.pix_status, f.pix_payload, f.pix_url, f.pix_erro, f.pix_taxa::float AS pix_taxa`;

async function carregarConfig(empresa_id) {
  const r = await pool.query('SELECT * FROM financeiro_config WHERE empresa_id = $1', [empresa_id]);
  return r.rows[0] || {
    empresa_id, instrucoes_pagamento: null, pix_chave: null, codigo_servico: null, nome_servico: null,
    aliquota_iss: 0, email_copia: null, dias_lembrete: 3, vencimento_mes_seguinte: true,
    geracao_automatica: true, dia_geracao: 1, dias_suspensao: 30, nfse_modo: 'producao',
    ret_ir: 0, ret_csll: 0, ret_pis: 0, ret_cofins: 0, ret_inss: 0
  };
}

async function carregarFatura(id, empresa_id) {
  const r = await pool.query(
    `SELECT ${COLUNAS_FATURA}, f.nfse_asaas_id FROM faturas f WHERE f.id = $1 AND f.empresa_id = $2`,
    [id, empresa_id]);
  return r.rows[0] || null;
}

async function carregarCliente(id) {
  const r = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Envia a fatura por e-mail e marca o envio. Devolve true/false.
// manual = botão "Enviar por e-mail": vai ao cliente mesmo no modo teste; os envios automáticos do modo teste vão só para a cópia
async function enviarEmailFatura(fatura, { manual = false } = {}) {
  const [cliente, config] = await Promise.all([carregarCliente(fatura.cliente_id), carregarConfig(fatura.empresa_id)]);
  const ok = await email.enviarFatura({ fatura, cliente, config, somenteCopia: !manual && config.nfse_modo === 'teste' });
  if (ok) await pool.query('UPDATE faturas SET email_enviado_em = NOW() WHERE id = $1', [fatura.id]);
  return ok;
}

// Emite (ou reemite após erro) a NFS-e da fatura. Não lança: grava o erro na fatura.
async function emitirNfse(fatura) {
  if (!fatura.emitir_nfse) return 'nao_emitida';
  // Modo teste (QAS): a nota é dada como emitida sem chamar o Asaas, e o processo segue como se tivesse saído
  if ((await carregarConfig(fatura.empresa_id)).nfse_modo === 'teste') {
    await pool.query(`UPDATE faturas SET nfse_status = 'emitida', nfse_simulada = TRUE, nfse_erro = NULL, data_atualizacao = NOW() WHERE id = $1`, [fatura.id]);
    return 'emitida';
  }
  // Sem Asaas a fatura segue sem nota (fica "não emitida" para emitir depois pelo botão)
  if (!asaas.configurado()) return 'nao_emitida';
  if (!fatura.codigo_servico) {
    await pool.query(`UPDATE faturas SET nfse_status = 'erro', nfse_erro = $1 WHERE id = $2`,
      ['Código de serviço não informado no contrato/fatura nem na configuração do financeiro.', fatura.id]);
    return 'erro';
  }
  try {
    const [cliente, config] = await Promise.all([carregarCliente(fatura.cliente_id), carregarConfig(fatura.empresa_id)]);
    await pool.query(`UPDATE faturas SET nfse_status = 'processando', nfse_erro = NULL WHERE id = $1`, [fatura.id]);
    // "Outras informações" da nota: observações da fatura + dados de pagamento (como nas notas que já emitia)
    const observacoes = [fatura.observacoes, config.instrucoes_pagamento].filter(Boolean).join('\n\n') || null;
    const nota = await asaas.emitirNotaFatura({ ...fatura, observacoes }, cliente);
    return await asaas.aplicarNotaNaFatura(fatura.id, nota);
  } catch (err) {
    await pool.query(`UPDATE faturas SET nfse_status = 'erro', nfse_erro = $1 WHERE id = $2`,
      [err.message.slice(0, 1000), fatura.id]);
    return 'erro';
  }
}

// Depois que a nota muda de status: se ficou emitida e a fatura aberta ainda não foi enviada, envia agora
async function aposAtualizarNota(faturaId, empresa_id) {
  const f = await carregarFatura(faturaId, empresa_id);
  if (f && f.status === 'aberta' && f.nfse_status === 'emitida' && !f.email_enviado_em) {
    // Webhook e rotina horária podem chegar juntos: reserva o envio antes, para o cliente receber um e-mail só
    const reserva = await pool.query('UPDATE faturas SET email_enviado_em = NOW() WHERE id = $1 AND email_enviado_em IS NULL', [f.id]);
    if (reserva.rowCount) {
      const ok = await enviarEmailFatura(f).catch(() => false);
      if (!ok) await pool.query('UPDATE faturas SET email_enviado_em = NULL WHERE id = $1', [f.id]);
    }
  }
  return f;
}

// Consulta a nota no Asaas e atualiza a fatura (fallback quando o webhook não chega)
async function sincronizarNfse(fatura) {
  if (!fatura.nfse_asaas_id) return fatura.nfse_status;
  const nota = await asaas.consultarNota(fatura.nfse_asaas_id);
  const status = await asaas.aplicarNotaNaFatura(fatura.id, nota);
  await aposAtualizarNota(fatura.id, fatura.empresa_id);
  return status;
}

// ===== Cobrança PIX (Asaas) =====
// Gera a cobrança PIX da fatura aberta. Não lança: grava o erro em pix_erro e devolve o pix_status.
async function gerarPix(fatura) {
  if (!asaas.configurado()) return null;
  try {
    const cliente = await carregarCliente(fatura.cliente_id);
    const { cobranca, qr } = await asaas.criarCobrancaPix({
      fatura, cliente, valor: fatura.valor_liquido ?? fatura.valor,
      descricao: `${fatura.descricao} — competência ${String(fatura.competencia).slice(0, 7)}`
    });
    await pool.query(
      `UPDATE faturas SET pix_asaas_id = $1, pix_status = 'pendente', pix_payload = $2, pix_qrcode = $3,
         pix_url = $4, pix_erro = NULL, data_atualizacao = NOW() WHERE id = $5`,
      [cobranca.id, qr.payload || null, qr.encodedImage || null, cobranca.invoiceUrl || null, fatura.id]);
    return 'pendente';
  } catch (err) {
    await pool.query(`UPDATE faturas SET pix_status = 'erro', pix_erro = $1 WHERE id = $2`, [err.message.slice(0, 1000), fatura.id]);
    return 'erro';
  }
}

// Cancela a cobrança PIX pendente (baixa manual, cancelamento da fatura). Best-effort: não lança.
async function cancelarPix(fatura) {
  if (!fatura.pix_asaas_id || fatura.pix_status !== 'pendente') return;
  try { await asaas.cancelarCobranca(fatura.pix_asaas_id); }
  catch (err) { console.error(`[PIX] cancelar cobrança da fatura ${fatura.id}:`, err.message); }
  await pool.query(`UPDATE faturas SET pix_status = 'cancelado', data_atualizacao = NOW() WHERE id = $1`, [fatura.id]);
}

// Baixa manual (transferência etc.) de uma fatura em aberto; o PIX pendente no Asaas não pode mais ser pago.
// Retorna true se baixou.
async function registrarPagamento(faturaId, empresa_id, usuario_id, { data_pagamento, valor_pago, forma_pagamento }) {
  const forma = forma_pagamento === undefined || forma_pagamento === null || String(forma_pagamento).trim() === ''
    ? 'transferencia' : forma_pagamento;
  const r = await pool.query(
    `UPDATE faturas SET status = 'paga', data_pagamento = $1, valor_pago = $2, forma_pagamento = $3,
       atualizado_por_usuario_id = $4, data_atualizacao = NOW()
     WHERE id = $5 AND empresa_id = $6 AND status = 'aberta' RETURNING id`,
    [data_pagamento, Number(valor_pago), forma, usuario_id, faturaId, empresa_id]);
  if (!r.rows.length) return false;
  const f = await carregarFatura(faturaId, empresa_id);
  if (f.pix_status === 'pendente') await cancelarPix(f);
  // Pagou a fatura que tinha suspendido as licenças do Conector: voltam na hora
  await require('./vigencia').reativarPagos().catch(err => console.error('[vigencia] reativar:', err.message));
  return true;
}

// Tarifa do Asaas vira despesa paga (categoria de despesa financeira), para a DRE e o fluxo ficarem certos
async function lancarTarifaAsaas(fatura, taxa, dataPagamento) {
  const cat = await pool.query(
    `SELECT id FROM categorias_transacao WHERE empresa_id = $1 AND tipo = 'saída' AND ativo = TRUE
       AND grupo_dre = 'despesa_financeira' ORDER BY (nome = 'Tarifas bancárias') DESC, id LIMIT 1`, [fatura.empresa_id]);
  if (!cat.rows.length) return;
  await pool.query(
    `INSERT INTO contas_pagar (empresa_id, categoria_id, descricao, documento, valor, competencia, data_vencimento,
       status, data_pagamento, valor_pago, forma_pagamento, observacoes)
     VALUES ($1, $2, $3, $4, $5, date_trunc('month', $6::date), $6::date, 'paga', $6::date, $5, 'debito', $7)`,
    [fatura.empresa_id, cat.rows[0].id, `Tarifa Asaas — PIX fatura #${fatura.id}`, `fatura-${fatura.id}`, taxa,
     dataPagamento, 'Lançada automaticamente quando o PIX foi recebido.']);
}

// Aplica o retrato da cobrança do Asaas na fatura; recebido → baixa automática (uma vez só)
async function aplicarCobrancaNaFatura(faturaId, empresa_id, cobranca) {
  const f = await carregarFatura(faturaId, empresa_id);
  if (!f) return null;
  const status = cobranca.deleted ? 'cancelado' : (asaas.STATUS_PIX[cobranca.status] || f.pix_status);
  if (status === 'pago' && f.status === 'aberta') {
    const data = String(cobranca.paymentDate || cobranca.clientPaymentDate || cobranca.confirmedDate || new Date().toISOString()).slice(0, 10);
    const valor = Number(cobranca.value || f.valor_liquido);
    const taxa = cobranca.netValue != null ? Math.max(0, Math.round((valor - Number(cobranca.netValue)) * 100) / 100) : null;
    const r = await pool.query(
      `UPDATE faturas SET status = 'paga', data_pagamento = $1, valor_pago = $2, forma_pagamento = 'pix',
         pix_status = 'pago', pix_taxa = $3, data_atualizacao = NOW()
       WHERE id = $4 AND status = 'aberta' RETURNING id`, [data, valor, taxa, f.id]);
    if (r.rows.length && taxa > 0) await lancarTarifaAsaas(f, taxa, data);
    if (r.rows.length) await require('./vigencia').reativarPagos().catch(err => console.error('[vigencia] reativar:', err.message));
    return 'pago';
  }
  if (status !== f.pix_status) {
    await pool.query(`UPDATE faturas SET pix_status = $1, data_atualizacao = NOW() WHERE id = $2`, [status, f.id]);
  }
  return status;
}

// Consulta a cobrança no Asaas (fallback quando o webhook não chega)
async function sincronizarPix(fatura) {
  if (!fatura.pix_asaas_id) return fatura.pix_status;
  const cobranca = await asaas.consultarCobranca(fatura.pix_asaas_id);
  return aplicarCobrancaNaFatura(fatura.id, fatura.empresa_id, cobranca);
}

// Aprova um rascunho: vira "aberta", emite a NFS-e, gera o PIX (se ligado) e envia o e-mail
// (com nota emitida na hora → e-mail já leva o PDF; se a prefeitura demorar, o e-mail sai quando a nota autorizar)
async function aprovarFatura(fatura, usuario_id) {
  const aprovada = await pool.query(
    `UPDATE faturas SET status = 'aberta', data_aprovacao = NOW(), atualizado_por_usuario_id = $2, data_atualizacao = NOW()
     WHERE id = $1 AND status = 'rascunho'`, [fatura.id, usuario_id]);
  // Dois cliques em "Aprovar": só o primeiro emite nota e envia e-mail
  if (!aprovada.rowCount) return { id: fatura.id, ja_aprovada: true, nfse_status: fatura.nfse_status, email_enviado: false };
  const config = await carregarConfig(fatura.empresa_id);
  const pix = config.cobranca_pix ? await gerarPix(fatura) : null;
  const nfse = await emitirNfse(fatura);
  let emailEnviado = false;
  if (nfse === 'emitida' || nfse === 'nao_emitida') {
    const atual = await carregarFatura(fatura.id, fatura.empresa_id);
    emailEnviado = await enviarEmailFatura(atual);
  }
  return { id: fatura.id, nfse_status: nfse, pix_status: pix, email_enviado: emailEnviado };
}

// ===== Geração de rascunhos (fechamento manual e rotina automática) =====
// Contrato entra na competência se está ativo e vigente em algum dia do mês. Mensal: todo mês.
// Anual: só no mês de cobrança (mes_cobranca; sem ele, o mês do início do contrato) e se o contrato ainda
// passa do mês de cobrança — o que vence em out/2027 não gera nova anuidade em out/2027 (isso é renovação).
const MES_COBRANCA = 'COALESCE(ct.mes_cobranca, EXTRACT(MONTH FROM ct.data_inicio)::int)';
const SQL_CONTRATOS_DA_COMPETENCIA = `
  FROM contratos ct JOIN clientes c ON c.id = ct.cliente_id
  WHERE ct.empresa_id = $1 AND ct.status = 'ativo'
    AND ct.data_inicio <= ($2::date + INTERVAL '1 month - 1 day')
    AND (ct.data_fim IS NULL OR ct.data_fim >= CASE WHEN ct.periodicidade = 'anual' THEN $2::date + INTERVAL '1 month' ELSE $2::date END)
    AND (ct.periodicidade = 'mensal' OR ${MES_COBRANCA} = EXTRACT(MONTH FROM $2::date))`;

// Descrição da fatura: a do serviço; na anual, com o período coberto (12 meses a partir da competência)
function descricaoFatura(c, inicio) {
  if (c.periodicidade !== 'anual') return c.descricao_servico;
  const [a, m] = inicio.split('-').map(Number);
  const fimM = m === 1 ? 12 : m - 1, fimA = m === 1 ? a : a + 1;
  return `${c.descricao_servico}\nAnuidade: ${String(m).padStart(2, '0')}/${a} a ${String(fimM).padStart(2, '0')}/${fimA}.`;
}

/**
 * Gera os rascunhos da competência (AAAA-MM) para os contratos que ainda não têm fatura nela.
 * automatico = true (rotina): também pula contrato cuja fatura do mês foi cancelada, para não recriar
 * o que o admin cancelou de propósito. Devolve o número de faturas criadas.
 */
async function gerarRascunhos({ empresa_id, competencia, usuario_id = null, automatico = false }) {
  const inicio = `${competencia}-01`;
  const config = await carregarConfig(empresa_id);
  const filtroFatura = automatico ? '' : `AND f.status <> 'cancelada'`;
  const client = await pool.connect();
  try {
    const elegiveis = (await client.query(
      `SELECT ct.*, ${MES_COBRANCA} AS mes_cobranca_efetivo
       ${SQL_CONTRATOS_DA_COMPETENCIA}
         AND NOT EXISTS (SELECT 1 FROM faturas f WHERE f.contrato_id = ct.id AND f.competencia = $2::date ${filtroFatura})`,
      [empresa_id, inicio])).rows;
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
        [empresa_id, c.cliente_id, c.id, inicio, descricaoFatura(c, inicio), c.valor,
         config.vencimento_mes_seguinte === false ? '0' : '1', c.dia_vencimento,
         c.emitir_nfse, c.codigo_servico || config.codigo_servico, c.nome_servico || config.nome_servico,
         c.aliquota_iss ?? config.aliquota_iss, c.reter_iss, usuario_id,
         ...RETENCOES.map(r => c[r] ?? config[r] ?? 0)]);
      geradas += r.rowCount;
    }
    await client.query('COMMIT');
    return geradas;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  SQL_CONTRATOS_DA_COMPETENCIA, MES_COBRANCA, gerarRascunhos,
  RETENCOES, sqlValorLiquido, COLUNAS_FATURA, carregarConfig, carregarFatura, carregarCliente,
  enviarEmailFatura, emitirNfse, sincronizarNfse, aposAtualizarNota, aprovarFatura,
  gerarPix, cancelarPix, aplicarCobrancaNaFatura, sincronizarPix, registrarPagamento
};
