// ===== FINANCEIRO: faturamento mensal, contratos e configuração =====
// Usa os helpers do script.js: apiFetch, API_URL, escapeHtml, formatMoeda, diaBr, showModal, closeModal, iconSVG, skeletonRows

Object.assign(_ICONS, {
  dinheiro: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  nota: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
  desfazer: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'
});

let _faturasCache = [];
let _finStatus = null;
let faturaEmEdicao = null;
let faturaBaixa = null;
let _contratosCache = [];
let contratoEmEdicao = null;

const RETENCOES = ['ret_ir', 'ret_csll', 'ret_pis', 'ret_cofins', 'ret_inss'];
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesAnoBr = iso => { const [a, m] = String(iso).slice(0, 7).split('-'); return `${MESES_CURTOS[Number(m) - 1]}/${a}`; };
const hojeIso = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

function competenciaAtual() {
  const el = document.getElementById('fin-competencia');
  if (!el.value) el.value = hojeIso().slice(0, 7);
  return el.value;
}

function pill(txt, cor) {
  return `<span class="fin-pill" style="--pill:${cor}">${escapeHtml(txt)}</span>`;
}

function situacaoFatura(f) {
  if (f.status === 'rascunho') return pill('Rascunho', '#64748b');
  if (f.status === 'cancelada') return pill('Cancelada', '#94a3b8');
  if (f.status === 'paga') return pill(`Paga em ${diaBr(f.data_pagamento)}`, '#2e7d4f');
  if (f.vencida) return pill('Vencida', '#b42318');
  return pill('Em aberto', '#1d6fd8');
}

function nfseFatura(f) {
  if (!f.emitir_nfse && f.nfse_status === 'nao_emitida') return '<span class="fin-muted">Sem nota</span>';
  switch (f.nfse_status) {
    case 'emitida': {
      const links = [f.nfse_pdf_url && `<a href="${escapeHtml(f.nfse_pdf_url)}" target="_blank" rel="noopener">PDF</a>`,
                     f.nfse_xml_url && `<a href="${escapeHtml(f.nfse_xml_url)}" target="_blank" rel="noopener">XML</a>`].filter(Boolean).join(' · ');
      return `${pill(`Nº ${f.nfse_numero || '—'}`, '#2e7d4f')}${links ? `<div class="fin-links">${links}</div>` : ''}`;
    }
    case 'processando': return pill('Processando', '#b7791f');
    case 'cancelando': return pill('Cancelando', '#b7791f');
    case 'cancelada': return pill('Cancelada', '#94a3b8');
    case 'erro': return `${pill('Erro', '#b42318')}<div class="fin-erro" title="${escapeHtml(f.nfse_erro)}">${escapeHtml((f.nfse_erro || '').slice(0, 90))}</div>`;
    default: return f.status === 'rascunho' ? '<span class="fin-muted">Ao aprovar</span>' : '<span class="fin-muted">Não emitida</span>';
  }
}

function botao(icone, titulo, acao, extra = '') {
  return `<button class="btn btn-icon ${extra}" title="${titulo}" aria-label="${titulo}" onclick="${acao}">${iconSVG(icone)}</button>`;
}

function acoesFatura(f) {
  const b = [];
  b.push(botao('eye', 'Visualizar', `visualizarRegistro(editarFatura, ${f.id}, '#modal-fatura')`));
  if (f.status === 'rascunho') {
    b.push(botao('edit', 'Editar', `editarFatura(${f.id})`, 'btn-edit'));
    b.push(botao('trash', 'Excluir rascunho', `excluirFatura(${f.id})`, 'btn-danger'));
  } else if (f.status === 'aberta') {
    b.push(botao('dinheiro', 'Registrar pagamento', `abrirBaixa(${f.id})`, 'btn-edit'));
    if (['nao_emitida', 'erro'].includes(f.nfse_status)) b.push(botao('nota', 'Emitir NFS-e', `emitirNfseFatura(${f.id})`));
    if (['processando', 'cancelando'].includes(f.nfse_status)) b.push(botao('refresh', 'Consultar NFS-e no Asaas', `sincronizarNfseFatura(${f.id})`));
    b.push(botao('mail', 'Enviar por e-mail', `reenviarEmailFatura(${f.id})`));
    b.push(botao('edit', 'Alterar vencimento', `editarFatura(${f.id})`));
    b.push(botao('ban', 'Cancelar fatura', `cancelarFatura(${f.id})`, 'btn-danger'));
  } else if (f.status === 'paga') {
    b.push(botao('mail', 'Reenviar por e-mail', `reenviarEmailFatura(${f.id})`));
    b.push(botao('desfazer', 'Desfazer pagamento', `estornarBaixa(${f.id})`));
  }
  return b.join('');
}

async function carregarStatusFinanceiro() {
  const res = await apiFetch(`${API_URL}/financeiro/status`);
  if (!res || !res.ok) return null;
  _finStatus = await res.json();
  const avisos = [];
  if (!_finStatus.asaas_configurado) avisos.push('Emissão de NFS-e desligada: falta configurar a chave do Asaas (ASAAS_API_KEY). As faturas funcionam normalmente; as notas ficam para emitir depois.');
  else if (_finStatus.asaas_ambiente === 'sandbox') avisos.push('Asaas em modo de TESTE (sandbox): as notas emitidas não têm valor fiscal.');
  if (!_finStatus.email_configurado) avisos.push('Envio de e-mail desligado neste ambiente: as faturas não serão enviadas aos clientes.');
  document.getElementById('fin-avisos').innerHTML = avisos.map(a => `<div class="fin-aviso">${escapeHtml(a)}</div>`).join('');
  return _finStatus;
}

async function loadFaturamento() {
  const comp = competenciaAtual();
  const tbody = document.getElementById('faturas-tbody');
  tbody.innerHTML = skeletonRows(7);
  if (!_finStatus) carregarStatusFinanceiro();

  const [rf, rr] = await Promise.all([
    apiFetch(`${API_URL}/financeiro/faturas?competencia=${comp}`),
    apiFetch(`${API_URL}/financeiro/resumo?competencia=${comp}`)
  ]);
  if (!rf || !rr) return;
  if (!rf.ok) { const e = await rf.json(); tbody.innerHTML = `<tr><td colspan="7" class="text-center">${escapeHtml(e.erro)}</td></tr>`; return; }
  _faturasCache = await rf.json();

  if (rr.ok) {
    const r = await rr.json();
    document.getElementById('fin-faturado').textContent = formatMoeda(r.faturado);
    document.getElementById('fin-faturado-qtd').textContent = `${r.qtd_faturado} fatura(s) aprovada(s)`;
    document.getElementById('fin-recebido').textContent = formatMoeda(r.recebido);
    document.getElementById('fin-recebido-qtd').textContent = `${r.qtd_recebido} fatura(s)`;
    document.getElementById('fin-areceber').textContent = formatMoeda(r.a_receber);
    document.getElementById('fin-areceber-qtd').textContent = `${r.qtd_a_receber} no prazo (todos os meses)`;
    document.getElementById('fin-vencido').textContent = formatMoeda(r.vencido);
    document.getElementById('fin-vencido-qtd').textContent = `${r.qtd_vencido} fatura(s) (todos os meses)`;
    document.getElementById('fin-mrr').textContent =
      `Receita recorrente: ${formatMoeda(r.mrr)}/mês em ${r.contratos} contrato(s) ativo(s).` +
      (r.qtd_rascunho ? ` ${r.qtd_rascunho} rascunho(s) aguardando aprovação.` : '');
  }
  renderFaturas();
}

function renderFaturas() {
  const tbody = document.getElementById('faturas-tbody');
  const filtro = document.getElementById('fin-filtro-status').value;
  const busca = document.getElementById('fin-busca').value.trim().toLowerCase();
  const lista = _faturasCache.filter(f => {
    if (filtro === 'vencida' && !f.vencida) return false;
    if (filtro && filtro !== 'vencida' && f.status !== filtro) return false;
    if (busca && !(`${f.cliente_nome} ${f.contrato_descricao || ''}`.toLowerCase().includes(busca))) return false;
    return true;
  });
  document.getElementById('fin-sel-todas').checked = false;
  atualizarSelecaoFaturas();

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">${_faturasCache.length
      ? 'Nenhuma fatura com esse filtro.'
      : `Nenhuma fatura em ${mesAnoBr(competenciaAtual() + '-01')}. Use "Gerar faturas do mês" para criar a partir dos contratos.`}</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(f => `
    <tr class="${f.status === 'cancelada' ? 'fin-linha-cancelada' : ''}">
      <td class="col-check" data-label="">${f.status === 'rascunho'
        ? `<input type="checkbox" class="fin-sel" value="${f.id}" aria-label="Selecionar fatura de ${escapeHtml(f.cliente_nome)}" onchange="atualizarSelecaoFaturas()">` : ''}</td>
      <td data-label="Cliente">
        <strong>${escapeHtml(f.cliente_nome)}</strong>
        <span class="fin-sub">${escapeHtml(f.contrato_descricao || 'Avulsa')}</span>
      </td>
      <td data-label="Valor" class="fin-num">${formatMoeda(f.valor)}${f.valor_liquido < f.valor
        ? `<span class="fin-sub" title="Valor da nota menos as retenções do tomador">a receber ${formatMoeda(f.valor_liquido)}</span>` : ''}</td>
      <td data-label="Vencimento">${diaBr(f.data_vencimento)}</td>
      <td data-label="Situação">${situacaoFatura(f)}</td>
      <td data-label="NFS-e">${nfseFatura(f)}</td>
      <td data-label="Ações" class="td-acoes">${acoesFatura(f)}</td>
    </tr>`).join('');
}

function idsSelecionados() {
  return [...document.querySelectorAll('.fin-sel:checked')].map(c => Number(c.value));
}

function atualizarSelecaoFaturas() {
  const n = idsSelecionados().length;
  document.getElementById('fin-barra-aprovar').hidden = n === 0;
  document.getElementById('fin-sel-qtd').textContent = `${n} rascunho(s) selecionado(s)`;
}

function selecionarTodasFaturas(marcar) {
  document.querySelectorAll('.fin-sel').forEach(c => { c.checked = marcar; });
  atualizarSelecaoFaturas();
}

async function gerarFaturasMes() {
  const comp = competenciaAtual();
  const prev = await apiFetch(`${API_URL}/financeiro/fechamento?competencia=${comp}`);
  if (!prev) return;
  const contratos = await prev.json();
  if (!prev.ok) { alert(contratos.erro); return; }
  const novos = contratos.filter(c => !c.fatura_id);
  if (!contratos.length) { alert(`Nenhum contrato ativo vigente em ${mesAnoBr(comp + '-01')}. Cadastre em Financeiro > Contratos.`); return; }
  if (!novos.length) { alert('Todos os contratos já têm fatura neste mês.'); return; }
  const total = novos.reduce((s, c) => s + c.valor, 0);
  const lista = novos.slice(0, 12).map(c => `• ${c.cliente_nome} — ${formatMoeda(c.valor)}`).join('\n');
  if (!confirm(`Gerar ${novos.length} fatura(s) de ${mesAnoBr(comp + '-01')} (total ${formatMoeda(total)})?\n\n${lista}${novos.length > 12 ? '\n...' : ''}\n\nElas entram como RASCUNHO: nada é enviado ao cliente até você aprovar.`)) return;

  const res = await apiFetch(`${API_URL}/financeiro/fechamento`, { method: 'POST', body: JSON.stringify({ competencia: comp }) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  loadFaturamento();
}

async function aprovarSelecionadas() {
  const ids = idsSelecionados();
  if (!ids.length) return;
  const sel = _faturasCache.filter(f => ids.includes(f.id));
  const total = sel.reduce((s, f) => s + (f.valor_liquido ?? f.valor), 0);
  const comNota = sel.filter(f => f.emitir_nfse).length;
  if (!confirm(`Aprovar ${ids.length} fatura(s), total a receber ${formatMoeda(total)}?\n\n` +
    `• ${comNota} NFS-e serão emitidas no Asaas${_finStatus && _finStatus.asaas_ambiente === 'sandbox' ? ' (TESTE)' : ''}\n` +
    `• Cada cliente recebe a fatura por e-mail (com a nota assim que ela for autorizada)\n\nEssa ação não pode ser desfeita (só cancelando a fatura).`)) return;

  const btn = document.querySelector('#fin-barra-aprovar .btn');
  btn.disabled = true; btn.textContent = 'Processando...';
  try {
    const res = await apiFetch(`${API_URL}/financeiro/faturas/aprovar`, { method: 'POST', body: JSON.stringify({ ids }) });
    if (!res) return;
    const r = await res.json();
    if (!res.ok) { alert(r.erro); return; }
    const erros = r.resultados.filter(x => x.erro || x.nfse_status === 'erro');
    const emitidas = r.resultados.filter(x => x.nfse_status === 'emitida').length;
    const processando = r.resultados.filter(x => x.nfse_status === 'processando').length;
    const emails = r.resultados.filter(x => x.email_enviado).length;
    alert(`${r.resultados.length - r.resultados.filter(x => x.erro).length} fatura(s) aprovada(s).\n` +
      `NFS-e: ${emitidas} emitida(s), ${processando} em processamento na prefeitura.\n` +
      `E-mails enviados: ${emails}.` +
      (erros.length ? `\n\n${erros.length} com problema na nota — veja a coluna NFS-e e use "Emitir NFS-e" para tentar de novo.` : ''));
  } finally {
    btn.disabled = false; btn.textContent = 'Aprovar, emitir NFS-e e enviar';
    loadFaturamento();
  }
}

async function preencherClientesSelect(sel, selecionado) {
  const res = await apiFetch(`${API_URL}/clientes`);
  if (!res) return;
  const clientes = (await res.json()).filter(c => c.ativo !== false);
  sel.innerHTML = '<option value="">Selecione...</option>' + clientes.map(c =>
    `<option value="${c.id}">${escapeHtml(c.nome_fantasia || c.razao_social || c.nome)}</option>`).join('');
  if (selecionado) sel.value = selecionado;
}

function preencherCamposNfse(form, f) {
  form.emitir_nfse.checked = f.emitir_nfse !== false;
  form.codigo_servico.value = f.codigo_servico || '';
  form.nome_servico.value = f.nome_servico || '';
  form.aliquota_iss.value = f.aliquota_iss ?? '';
  form.reter_iss.checked = !!f.reter_iss;
  RETENCOES.forEach(r => { if (form[r]) form[r].value = f[r] ? f[r] : ''; });
}

function modoFormFatura(modo) {
  // modo: 'avulsa' | 'rascunho' | 'aberta'
  const form = document.getElementById('form-fatura');
  document.getElementById('fatura-avulsa-row').style.display = modo === 'avulsa' ? '' : 'none';
  document.getElementById('fatura-aviso-aberta').hidden = modo !== 'aberta';
  document.getElementById('fatura-nfse-campos').style.display = modo === 'aberta' ? 'none' : '';
  form.cliente_id.required = modo === 'avulsa';
  form.competencia.required = modo === 'avulsa';
  form.descricao.readOnly = modo === 'aberta';
  form.valor.readOnly = modo === 'aberta';
}

async function abrirFaturaAvulsa() {
  faturaEmEdicao = null;
  const form = document.getElementById('form-fatura');
  form.reset();
  modoFormFatura('avulsa');
  form.competencia.value = competenciaAtual();
  form.data_vencimento.value = hojeIso();
  const cfg = await apiFetch(`${API_URL}/financeiro/config`);
  if (cfg && cfg.ok) preencherCamposNfse(form, await cfg.json());
  await preencherClientesSelect(form.cliente_id);
  document.getElementById('modal-fatura-titulo').textContent = 'Fatura avulsa';
  showModal('#modal-fatura');
}

function editarFatura(id) {
  const f = _faturasCache.find(x => x.id === id);
  if (!f) return;
  faturaEmEdicao = f;
  const form = document.getElementById('form-fatura');
  form.reset();
  modoFormFatura(f.status === 'rascunho' ? 'rascunho' : 'aberta');
  form.descricao.value = f.descricao;
  form.valor.value = f.valor;
  form.data_vencimento.value = f.data_vencimento;
  form.observacoes.value = f.observacoes || '';
  preencherCamposNfse(form, f);
  document.getElementById('modal-fatura-titulo').textContent = `Fatura — ${f.cliente_nome} (${mesAnoBr(f.competencia)})`;
  showModal('#modal-fatura');
}

async function salvarFatura() {
  const form = document.getElementById('form-fatura');
  const dados = {
    descricao: form.descricao.value,
    valor: form.valor.value,
    data_vencimento: form.data_vencimento.value,
    observacoes: form.observacoes.value,
    emitir_nfse: form.emitir_nfse.checked,
    codigo_servico: form.codigo_servico.value,
    nome_servico: form.nome_servico.value,
    aliquota_iss: form.aliquota_iss.value,
    reter_iss: form.reter_iss.checked
  };
  RETENCOES.forEach(r => { dados[r] = form[r].value; });
  if (!faturaEmEdicao) { dados.cliente_id = form.cliente_id.value; dados.competencia = form.competencia.value; }
  const url = faturaEmEdicao ? `${API_URL}/financeiro/faturas/${faturaEmEdicao.id}` : `${API_URL}/financeiro/faturas`;
  const res = await apiFetch(url, { method: faturaEmEdicao ? 'PUT' : 'POST', body: JSON.stringify(dados) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-fatura'));
  if (!faturaEmEdicao && dados.competencia !== competenciaAtual()) document.getElementById('fin-competencia').value = dados.competencia;
  loadFaturamento();
}

async function acaoFatura(id, caminho, confirmacao, corpo) {
  if (confirmacao && !confirm(confirmacao)) return;
  const res = await apiFetch(`${API_URL}/financeiro/faturas/${id}${caminho}`, {
    method: caminho ? 'POST' : 'DELETE', body: corpo ? JSON.stringify(corpo) : undefined
  });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return null; }
  loadFaturamento();
  return r;
}

const nomeFatura = id => { const f = _faturasCache.find(x => x.id === id); return f ? `${f.cliente_nome} (${formatMoeda(f.valor)})` : 'esta fatura'; };

function excluirFatura(id) { acaoFatura(id, '', `Excluir o rascunho de ${nomeFatura(id)}?`); }

async function emitirNfseFatura(id) {
  const r = await acaoFatura(id, '/nfse', `Emitir a NFS-e de ${nomeFatura(id)} no Asaas?`);
  if (r && r.nfse_status === 'erro') alert(`A nota não foi emitida:\n${r.nfse_erro}`);
}

async function sincronizarNfseFatura(id) {
  const r = await acaoFatura(id, '/nfse/sincronizar');
  if (r) alert(r.nfse_status === 'emitida' ? 'NFS-e autorizada!' : `Situação da nota: ${r.nfse_status}.`);
}

async function reenviarEmailFatura(id) {
  const r = await acaoFatura(id, '/enviar-email', `Enviar a fatura de ${nomeFatura(id)} por e-mail ao cliente?`);
  if (r) alert(r.mensagem);
}

async function cancelarFatura(id) {
  const f = _faturasCache.find(x => x.id === id);
  const temNota = f && ['emitida', 'processando'].includes(f.nfse_status);
  const r = await acaoFatura(id, '/cancelar',
    `Cancelar a fatura de ${nomeFatura(id)}?${temNota ? '\n\nA NFS-e também será CANCELADA na prefeitura (pode haver prazo legal para cancelamento).' : ''}`);
  if (r) alert(r.mensagem);
}

function estornarBaixa(id) {
  acaoFatura(id, '/estornar-baixa', `Desfazer o pagamento de ${nomeFatura(id)}? A fatura volta para "em aberto".`);
}

function abrirBaixa(id) {
  const f = _faturasCache.find(x => x.id === id);
  if (!f) return;
  faturaBaixa = f;
  const form = document.getElementById('form-baixa');
  form.reset();
  form.data_pagamento.value = hojeIso();
  form.valor_pago.value = f.valor_liquido ?? f.valor;
  document.getElementById('modal-baixa-titulo').textContent = `Pagamento — ${f.cliente_nome}`;
  showModal('#modal-baixa');
}

async function salvarBaixa() {
  const form = document.getElementById('form-baixa');
  const r = await acaoFatura(faturaBaixa.id, '/baixa', null, {
    data_pagamento: form.data_pagamento.value,
    valor_pago: form.valor_pago.value,
    forma_pagamento: form.forma_pagamento.value
  });
  if (r) closeModal(document.getElementById('modal-baixa'));
}

// ===== Configuração =====
async function abrirConfigFinanceiro() {
  const [rc, st] = await Promise.all([apiFetch(`${API_URL}/financeiro/config`), carregarStatusFinanceiro()]);
  if (!rc) return;
  const c = await rc.json();
  if (!rc.ok) { alert(c.erro); return; }
  const form = document.getElementById('form-fin-config');
  form.pix_chave.value = c.pix_chave || '';
  form.instrucoes_pagamento.value = c.instrucoes_pagamento || '';
  form.codigo_servico.value = c.codigo_servico || '';
  form.nome_servico.value = c.nome_servico || '';
  form.aliquota_iss.value = c.aliquota_iss ?? '';
  form.vencimento_mes_seguinte.value = c.vencimento_mes_seguinte === false ? 'false' : 'true';
  form.dias_lembrete.value = c.dias_lembrete ?? 3;
  form.email_copia.value = c.email_copia || '';
  RETENCOES.forEach(r => { form[r].value = c[r] ? c[r] : ''; });
  const item = (ok, txt) => `<div class="${ok ? 'ok' : 'off'}">${ok ? '●' : '○'} ${escapeHtml(txt)}</div>`;
  document.getElementById('fin-config-status').innerHTML = st ? [
    item(st.asaas_configurado, st.asaas_configurado ? `Asaas conectado (${st.asaas_ambiente === 'producao' ? 'produção' : 'teste / sandbox'})` : 'Asaas não conectado — defina ASAAS_API_KEY no servidor'),
    item(st.webhook_configurado, st.webhook_configurado ? 'Webhook do Asaas ativo' : 'Webhook do Asaas sem token (as notas são consultadas a cada hora)'),
    item(st.email_configurado, st.email_configurado ? 'Envio de e-mail ativo' : 'Envio de e-mail desligado (RESEND_API_KEY)')
  ].join('') : '';
  showModal('#modal-fin-config');
}

async function salvarConfigFinanceiro() {
  const form = document.getElementById('form-fin-config');
  const res = await apiFetch(`${API_URL}/financeiro/config`, {
    method: 'PUT',
    body: JSON.stringify({
      pix_chave: form.pix_chave.value,
      instrucoes_pagamento: form.instrucoes_pagamento.value,
      codigo_servico: form.codigo_servico.value,
      nome_servico: form.nome_servico.value,
      aliquota_iss: form.aliquota_iss.value || 0,
      vencimento_mes_seguinte: form.vencimento_mes_seguinte.value === 'true',
      dias_lembrete: Number(form.dias_lembrete.value || 0),
      email_copia: form.email_copia.value,
      ...Object.fromEntries(RETENCOES.map(r => [r, form[r].value || 0]))
    })
  });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-fin-config'));
}

// ===== Contratos =====
const STATUS_CONTRATO = { ativo: ['Ativo', '#2e7d4f'], suspenso: ['Suspenso', '#b7791f'], encerrado: ['Encerrado', '#94a3b8'] };

async function loadContratos() {
  const tbody = document.getElementById('contratos-tbody');
  tbody.innerHTML = skeletonRows(7);
  const res = await apiFetch(`${API_URL}/financeiro/contratos`);
  if (!res) return;
  if (!res.ok) { const e = await res.json(); tbody.innerHTML = `<tr><td colspan="7" class="text-center">${escapeHtml(e.erro)}</td></tr>`; return; }
  _contratosCache = await res.json();
  if (!_contratosCache.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">Nenhum contrato ainda. Use "+ Novo contrato".</td></tr>';
    return;
  }
  tbody.innerHTML = _contratosCache.map(c => {
    const [txt, cor] = STATUS_CONTRATO[c.status] || [c.status, '#64748b'];
    return `
    <tr>
      <td data-label="Cliente"><strong>${escapeHtml(c.cliente_nome)}</strong></td>
      <td data-label="Contrato">${escapeHtml(c.descricao)}${c.emitir_nfse ? '' : ' <span class="fin-muted">(sem NFS-e)</span>'}</td>
      <td data-label="Mensalidade" class="fin-num">${formatMoeda(c.valor)}</td>
      <td data-label="Vencimento">Dia ${c.dia_vencimento}</td>
      <td data-label="Vigência">${diaBr(c.data_inicio)} → ${c.data_fim ? diaBr(c.data_fim) : 'sem prazo'}</td>
      <td data-label="Status">${pill(txt, cor)}</td>
      <td data-label="Ações" class="td-acoes">
        ${botao('eye', 'Visualizar', `visualizarRegistro(editarContrato, ${c.id}, '#modal-contrato')`)}
        ${botao('edit', 'Editar', `editarContrato(${c.id})`, 'btn-edit')}
        ${c.status !== 'encerrado' ? botao('trash', 'Encerrar / excluir', `encerrarContrato(${c.id})`, 'btn-danger') : ''}
      </td>
    </tr>`;
  }).join('');
}

async function abrirNovoContrato() {
  contratoEmEdicao = null;
  const form = document.getElementById('form-contrato');
  form.reset();
  form.data_inicio.value = hojeIso().slice(0, 8) + '01';
  form.dia_vencimento.value = 10;
  form.emitir_nfse.checked = true;
  document.getElementById('contrato-status-row').style.display = 'none';
  await preencherClientesSelect(form.cliente_id);
  document.getElementById('modal-contrato-titulo').textContent = 'Novo contrato';
  showModal('#modal-contrato');
}

async function editarContrato(id) {
  const c = _contratosCache.find(x => x.id === id);
  if (!c) return;
  contratoEmEdicao = id;
  const form = document.getElementById('form-contrato');
  form.reset();
  await preencherClientesSelect(form.cliente_id, c.cliente_id);
  ['descricao', 'descricao_servico', 'valor', 'dia_vencimento', 'data_inicio', 'data_fim', 'indice_reajuste',
   'codigo_servico', 'nome_servico', 'status', 'observacoes'].forEach(k => { form[k].value = c[k] ?? ''; });
  form.mes_reajuste.value = c.mes_reajuste || '';
  form.aliquota_iss.value = c.aliquota_iss ?? '';
  form.emitir_nfse.checked = c.emitir_nfse;
  form.reter_iss.checked = c.reter_iss;
  RETENCOES.forEach(r => { form[r].value = c[r] ?? ''; });
  document.getElementById('contrato-status-row').style.display = '';
  document.getElementById('modal-contrato-titulo').textContent = `Contrato — ${c.cliente_nome}`;
  showModal('#modal-contrato');
}

async function salvarContrato() {
  const form = document.getElementById('form-contrato');
  const dados = {
    cliente_id: form.cliente_id.value,
    descricao: form.descricao.value,
    descricao_servico: form.descricao_servico.value,
    valor: form.valor.value,
    dia_vencimento: form.dia_vencimento.value,
    data_inicio: form.data_inicio.value,
    data_fim: form.data_fim.value,
    indice_reajuste: form.indice_reajuste.value,
    mes_reajuste: form.mes_reajuste.value,
    emitir_nfse: form.emitir_nfse.checked,
    codigo_servico: form.codigo_servico.value,
    nome_servico: form.nome_servico.value,
    aliquota_iss: form.aliquota_iss.value,
    reter_iss: form.reter_iss.checked,
    status: contratoEmEdicao ? form.status.value : 'ativo',
    observacoes: form.observacoes.value
  };
  RETENCOES.forEach(r => { dados[r] = form[r].value; });
  const url = contratoEmEdicao ? `${API_URL}/financeiro/contratos/${contratoEmEdicao}` : `${API_URL}/financeiro/contratos`;
  const res = await apiFetch(url, { method: contratoEmEdicao ? 'PUT' : 'POST', body: JSON.stringify(dados) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-contrato'));
  loadContratos();
}

async function encerrarContrato(id) {
  const c = _contratosCache.find(x => x.id === id);
  if (!confirm(`Encerrar o contrato "${c ? c.descricao : ''}"${c ? ` de ${c.cliente_nome}` : ''}?\n\nSe ainda não gerou faturas, ele é excluído; se já gerou, fica encerrado e o histórico é mantido.`)) return;
  const res = await apiFetch(`${API_URL}/financeiro/contratos/${id}`, { method: 'DELETE' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  loadContratos();
}

document.addEventListener('DOMContentLoaded', () => {
  const sub = (id, fn) => document.getElementById(id).addEventListener('submit', e => { e.preventDefault(); fn(); });
  sub('form-contrato', salvarContrato);
  sub('form-fatura', salvarFatura);
  sub('form-baixa', salvarBaixa);
  sub('form-fin-config', salvarConfigFinanceiro);
});
