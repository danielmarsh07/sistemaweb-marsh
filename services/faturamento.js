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
  f.nfse_status, f.nfse_numero, f.nfse_codigo_verificacao, f.nfse_pdf_url, f.nfse_xml_url, f.nfse_erro,
  f.email_enviado_em, f.lembrete_enviado_em, f.data_criacao,
  f.ret_ir::float AS ret_ir, f.ret_csll::float AS ret_csll, f.ret_pis::float AS ret_pis,
  f.ret_cofins::float AS ret_cofins, f.ret_inss::float AS ret_inss,
  ${sqlValorLiquido('f')} AS valor_liquido,
  (f.status = 'aberta' AND f.data_vencimento < CURRENT_DATE) AS vencida`;

async function carregarConfig(empresa_id) {
  const r = await pool.query('SELECT * FROM financeiro_config WHERE empresa_id = $1', [empresa_id]);
  return r.rows[0] || {
    empresa_id, instrucoes_pagamento: null, pix_chave: null, codigo_servico: null, nome_servico: null,
    aliquota_iss: 0, email_copia: null, dias_lembrete: 3, vencimento_mes_seguinte: true,
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
async function enviarEmailFatura(fatura) {
  const [cliente, config] = await Promise.all([carregarCliente(fatura.cliente_id), carregarConfig(fatura.empresa_id)]);
  const ok = await email.enviarFatura({ fatura, cliente, config });
  if (ok) await pool.query('UPDATE faturas SET email_enviado_em = NOW() WHERE id = $1', [fatura.id]);
  return ok;
}

// Emite (ou reemite após erro) a NFS-e da fatura. Não lança: grava o erro na fatura.
async function emitirNfse(fatura) {
  if (!fatura.emitir_nfse) return 'nao_emitida';
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
    await enviarEmailFatura(f);
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

// Aprova um rascunho: vira "aberta", emite a NFS-e e envia o e-mail
// (com nota emitida na hora → e-mail já leva o PDF; se a prefeitura demorar, o e-mail sai quando a nota autorizar)
async function aprovarFatura(fatura, usuario_id) {
  await pool.query(
    `UPDATE faturas SET status = 'aberta', data_aprovacao = NOW(), atualizado_por_usuario_id = $2, data_atualizacao = NOW()
     WHERE id = $1 AND status = 'rascunho'`, [fatura.id, usuario_id]);
  const nfse = await emitirNfse(fatura);
  let emailEnviado = false;
  if (nfse === 'emitida' || nfse === 'nao_emitida') {
    const atual = await carregarFatura(fatura.id, fatura.empresa_id);
    emailEnviado = await enviarEmailFatura(atual);
  }
  return { id: fatura.id, nfse_status: nfse, email_enviado: emailEnviado };
}

module.exports = {
  RETENCOES, sqlValorLiquido, COLUNAS_FATURA, carregarConfig, carregarFatura, carregarCliente,
  enviarEmailFatura, emitirNfse, sincronizarNfse, aposAtualizarNota, aprovarFatura
};
