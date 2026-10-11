// ===== FINANCEIRO: faturamento mensal, contratos e configuração =====
// Usa os helpers do script.js: apiFetch, API_URL, escapeHtml, formatMoeda, diaBr, showModal, closeModal, iconSVG, skeletonRows

Object.assign(_ICONS, {
  dinheiro: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  nota: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
  desfazer: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  pix: '<path d="m12 3 4.5 4.5a2 2 0 0 1 0 2.8L12 14.8l-4.5-4.5a2 2 0 0 1 0-2.8z"/><path d="m5.5 13.5 4 4a3.5 3.5 0 0 0 5 0l4-4"/>'
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
  if (f.status === 'paga') return pill(`Paga em ${diaBr(f.data_pagamento)}${f.pix_status === 'pago' ? ' (PIX)' : ''}`, '#2e7d4f');
  const pix = situacaoPix(f);
  if (f.vencida) return pill('Vencida', '#b42318') + pix;
  return pill('Em aberto', '#1d6fd8') + pix;
}

function situacaoPix(f) {
  if (f.pix_status === 'pendente') return '<div class="fin-sub">PIX gerado, aguardando pagamento</div>';
  if (f.pix_status === 'erro') return `<div class="fin-erro" title="${escapeHtml(f.pix_erro)}">PIX: ${escapeHtml((f.pix_erro || '').slice(0, 90))}</div>`;
  if (f.pix_status === 'estornado') return '<div class="fin-erro">PIX estornado no Asaas</div>';
  return '';
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
    case 'erro': return `${pill('Erro', '#b42318')}<div class="fin-erro" title="${escapeHtml(f.nfse_erro)}">${escapeHtml((f.nfse_erro || '').slice(0, 200))}</div>`;
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
    if (f.pix_status === 'pendente') b.push(botao('pix', 'Consultar pagamento PIX no Asaas', `sincronizarPixFatura(${f.id})`));
    else if (_finStatus && _finStatus.asaas_configurado) b.push(botao('pix', 'Gerar cobrança PIX', `gerarPixFatura(${f.id})`));
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
  else {
    if (_finStatus.asaas_fiscal_configurado === false) avisos.push('Asaas conectado, mas a configuração fiscal da conta está pendente: no painel do Asaas, em Notas Fiscais, informe inscrição municipal, regime e o acesso ao portal da prefeitura. Até lá as notas não são emitidas.');
    if (_finStatus.asaas_ambiente === 'sandbox') avisos.push('Asaas em modo de TESTE (sandbox): as notas emitidas não têm valor fiscal.');
  }
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
    const pixErro = r.resultados.filter(x => x.pix_status === 'erro').length;
    const emails = r.resultados.filter(x => x.email_enviado).length;
    alert(`${r.resultados.length - r.resultados.filter(x => x.erro).length} fatura(s) aprovada(s).\n` +
      `NFS-e: ${emitidas} emitida(s), ${processando} em processamento na prefeitura.\n` +
      `E-mails enviados: ${emails}.` +
      (erros.length ? `\n\n${erros.length} com problema na nota — veja a coluna NFS-e e use "Emitir NFS-e" para tentar de novo.` : '') +
      (pixErro ? `

${pixErro} sem cobrança PIX (erro no Asaas): veja a coluna Situação e use "Gerar cobrança PIX".` : ''));
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

async function gerarPixFatura(id) {
  const f = _faturasCache.find(x => x.id === id);
  const r = await acaoFatura(id, '/pix', `Gerar cobrança PIX de ${formatMoeda(f ? (f.valor_liquido ?? f.valor) : 0)} no Asaas${_finStatus && _finStatus.asaas_ambiente === 'sandbox' ? ' (TESTE)' : ''}?`);
  if (r) alert(r.mensagem);
}

async function sincronizarPixFatura(id) {
  const r = await acaoFatura(id, '/pix/sincronizar');
  if (r) alert(r.pix_status === 'pago' ? 'PIX recebido! A fatura foi baixada.' : `Situação do PIX: ${r.pix_status}.`);
}

function estornarBaixa(id) {
  acaoFatura(id, '/estornar-baixa', `Desfazer o pagamento de ${nomeFatura(id)}? A fatura volta para "em aberto".`);
}

// O mesmo modal registra recebimento de fatura e pagamento de conta a pagar
let contaBaixa = null;

function prepararModalBaixa(titulo, labelValor, valor) {
  const form = document.getElementById('form-baixa');
  form.reset();
  form.data_pagamento.value = hojeIso();
  form.valor_pago.value = valor;
  document.getElementById('baixa-valor-label').textContent = labelValor;
  document.getElementById('modal-baixa-titulo').textContent = titulo;
  showModal('#modal-baixa');
}

function abrirBaixa(id) {
  const f = _faturasCache.find(x => x.id === id);
  if (!f) return;
  faturaBaixa = f; contaBaixa = null;
  prepararModalBaixa(`Pagamento — ${f.cliente_nome}`, 'Valor recebido (R$) *', f.valor_liquido ?? f.valor);
}

async function salvarBaixa() {
  const form = document.getElementById('form-baixa');
  const corpo = {
    data_pagamento: form.data_pagamento.value,
    valor_pago: form.valor_pago.value,
    forma_pagamento: form.forma_pagamento.value
  };
  const r = contaBaixa
    ? await acaoContaPagar(contaBaixa.id, '/baixa', null, corpo)
    : await acaoFatura(faturaBaixa.id, '/baixa', null, corpo);
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
  form.cobranca_pix.checked = !!c.cobranca_pix;
  RETENCOES.forEach(r => { form[r].value = c[r] ? c[r] : ''; });
  const item = (ok, txt) => `<div class="${ok ? 'ok' : 'off'}">${ok ? '●' : '○'} ${escapeHtml(txt)}</div>`;
  document.getElementById('fin-config-status').innerHTML = st ? [
    item(st.asaas_configurado, st.asaas_configurado ? `Asaas conectado (${st.asaas_ambiente === 'producao' ? 'produção' : 'teste / sandbox'})` : 'Asaas não conectado — defina ASAAS_API_KEY no servidor'),
    ...(st.asaas_configurado ? [item(st.asaas_fiscal_configurado === true, st.asaas_fiscal_configurado === true
      ? 'Configuração fiscal do Asaas ok' : 'Configuração fiscal do Asaas pendente (painel do Asaas → Notas Fiscais)')] : []),
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
      cobranca_pix: form.cobranca_pix.checked,
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

// ===== Contas a pagar =====
let _contasCache = [];
let contaEmEdicao = null;
let _categoriasDespesa = [];
let _gruposDre = [];
let categoriaDespesaEmEdicao = null;
let _contasFinanceiras = [];
let contaFinanceiraEmEdicao = null;
let _faturaAPagar = null;

function mesFiltro(id) {
  const el = document.getElementById(id);
  if (!el.value) el.value = hojeIso().slice(0, 7);
  return el.value;
}

function situacaoConta(c) {
  if (c.status === 'paga') return pill(`Paga em ${diaBr(c.data_pagamento)}`, '#2e7d4f');
  if (c.status === 'cancelada') return pill('Cancelada', '#94a3b8');
  if (c.vencida) return pill('Vencida', '#b42318');
  return pill('Em aberto', '#1d6fd8');
}

// Depois de criar/editar/baixar uma conta, atualiza a tela que estiver aberta
function aposMudarConta() {
  if (typeof currentPage !== 'undefined' && currentPage === 'visao-mensal' && typeof loadVisaoMensal === 'function') loadVisaoMensal();
  else loadContasPagar();
}

async function carregarContasFinanceiras() {
  const res = await apiFetch(`${API_URL}/financeiro/contas-financeiras`);
  if (res && res.ok) _contasFinanceiras = await res.json();
  return _contasFinanceiras;
}

const cartaoPorId = id => _contasFinanceiras.find(c => c.id === Number(id) && c.tipo === 'cartao') || null;

function opcoesContasFinanceiras(selecionado) {
  const ativas = _contasFinanceiras.filter(c => c.ativo || c.id === Number(selecionado));
  const grupo = (tipo, rotulo) => {
    const itens = ativas.filter(c => c.tipo === tipo);
    return itens.length ? `<optgroup label="${rotulo}">${itens.map(c =>
      `<option value="${c.id}">${escapeHtml(c.nome)}${c.tipo === 'cartao' ? ` (vence dia ${c.dia_vencimento})` : ''}</option>`).join('')}</optgroup>` : '';
  };
  return '<option value="">— Conta / sem cartão —</option>' + grupo('conta', 'Contas') + grupo('cartao', 'Cartões de crédito');
}

async function loadContasPagar() {
  const mes = mesFiltro('cp-mes');
  const tbody = document.getElementById('contas-pagar-tbody');
  tbody.innerHTML = skeletonRows(6);
  const [rl, rr] = await Promise.all([
    apiFetch(`${API_URL}/financeiro/contas-pagar?mes=${mes}`),
    apiFetch(`${API_URL}/financeiro/contas-pagar/resumo?mes=${mes}`),
    carregarContasFinanceiras()
  ]);
  if (!rl || !rr) return;
  if (!rl.ok) { const e = await rl.json(); tbody.innerHTML = `<tr><td colspan="6" class="text-center">${escapeHtml(e.erro)}</td></tr>`; return; }
  _contasCache = await rl.json();
  if (rr.ok) {
    const r = await rr.json();
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    set('cp-total-mes', formatMoeda(r.total_mes)); set('cp-total-mes-qtd', `${r.qtd_mes} conta(s)`);
    set('cp-pago-mes', formatMoeda(r.pago_mes)); set('cp-pago-mes-qtd', `${r.qtd_pago} conta(s)`);
    set('cp-proximos', formatMoeda(r.proximos_7)); set('cp-proximos-qtd', `${r.qtd_proximos_7} conta(s) a partir de hoje`);
    set('cp-vencido', formatMoeda(r.vencido)); set('cp-vencido-qtd', `${r.qtd_vencido} conta(s) (todos os meses)`);
  }
  const selMeio = document.getElementById('cp-filtro-meio');
  const atual = selMeio.value;
  selMeio.innerHTML = '<option value="">Todas as contas e cartões</option><option value="0">Conta / sem cartão</option>' +
    _contasFinanceiras.map(c => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');
  selMeio.value = [...selMeio.options].some(o => o.value === atual) ? atual : '';
  renderContasPagar();
}

function renderContasPagar() {
  const tbody = document.getElementById('contas-pagar-tbody');
  const filtro = document.getElementById('cp-filtro-status').value;
  const meio = document.getElementById('cp-filtro-meio').value;
  const natureza = document.getElementById('cp-filtro-natureza').value;
  const busca = document.getElementById('cp-busca').value.trim().toLowerCase();
  const lista = _contasCache.filter(c => {
    if (filtro === 'vencida' && !c.vencida) return false;
    if (filtro && filtro !== 'vencida' && c.status !== filtro) return false;
    if (meio !== '' && String(c.conta_financeira_id || 0) !== meio) return false;
    if (natureza && c.natureza !== natureza) return false;
    if (busca && !`${c.descricao} ${c.fornecedor_nome || ''} ${c.categoria_nome || ''}`.toLowerCase().includes(busca)) return false;
    return true;
  });
  renderBarraFatura(meio);
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">${_contasCache.length
      ? 'Nenhuma conta com esse filtro.' : 'Nenhuma conta neste mês. Use "+ Nova conta".'}</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(c => {
    const acoes = [botao('eye', 'Visualizar', `visualizarRegistro(editarConta, ${c.id}, '#modal-conta-pagar')`)];
    if (c.status === 'aberta') {
      acoes.push(botao('dinheiro', 'Registrar pagamento', `abrirBaixaConta(${c.id})`, 'btn-edit'));
      acoes.push(botao('edit', 'Editar', `editarConta(${c.id})`));
      acoes.push(botao('trash', 'Excluir', `excluirConta(${c.id})`, 'btn-danger'));
    } else if (c.status === 'paga') {
      acoes.push(botao('edit', 'Editar', `editarConta(${c.id})`));
      acoes.push(botao('desfazer', 'Desfazer pagamento', `estornarConta(${c.id})`));
    }
    const serie = c.recorrente ? 'assinatura' : c.parcela ? `${c.parcela}/${c.total_parcelas}` : null;
    const sub = [c.conta_financeira_nome, c.fornecedor_nome, serie, c.documento].filter(Boolean).join(' · ');
    return `
    <tr>
      <td data-label="Descrição"><strong>${escapeHtml(c.descricao)}</strong>${c.natureza === 'pessoal' ? ` ${pill('Pessoal', '#7c3aed')}` : ''}${sub ? `<span class="fin-sub">${escapeHtml(sub)}</span>` : ''}</td>
      <td data-label="Categoria">${escapeHtml(c.categoria_nome || '—')}</td>
      <td data-label="Valor" class="fin-num">${formatMoeda(c.valor)}${c.status === 'paga' && c.valor_pago !== c.valor
        ? `<span class="fin-sub">pago ${formatMoeda(c.valor_pago)}</span>` : ''}</td>
      <td data-label="Vencimento">${diaBr(c.data_vencimento)}</td>
      <td data-label="Situação">${situacaoConta(c)}</td>
      <td data-label="Ações" class="td-acoes">${acoes.join('')}</td>
    </tr>`;
  }).join('');
}

// Filtrando um cartão: mostra o total da fatura do mês e o botão de pagar tudo de uma vez
function renderBarraFatura(meio) {
  const barra = document.getElementById('cp-barra-fatura');
  const cartao = cartaoPorId(meio);
  const mes = mesFiltro('cp-mes');
  if (!cartao) { barra.hidden = true; return; }
  const itens = _contasCache.filter(c => c.conta_financeira_id === cartao.id && c.data_vencimento.slice(0, 7) === mes);
  const abertos = itens.filter(c => c.status === 'aberta');
  const total = itens.reduce((s, c) => s + c.valor, 0);
  barra.hidden = !itens.length;
  barra.innerHTML = `<span>Fatura ${escapeHtml(cartao.nome)} de ${mesAnoBr(mes + '-01')}: <strong>${formatMoeda(total)}</strong>
      (${itens.length} lançamento(s)${abertos.length ? `, ${abertos.length} em aberto` : ', paga'})</span>
    ${abertos.length ? `<button type="button" class="btn btn-primary" onclick="abrirPagarFatura(${cartao.id}, '${mes}')">Pagar fatura</button>` : ''}`;
}

async function abrirPagarFatura(cartaoId, mes, total, qtd) {
  if (!_contasFinanceiras.length) await carregarContasFinanceiras();
  const cartao = cartaoPorId(cartaoId);
  if (!cartao) return;
  if (total === undefined) {
    const itens = _contasCache.filter(c => c.conta_financeira_id === cartao.id && c.status === 'aberta' && c.data_vencimento.slice(0, 7) === mes);
    total = itens.reduce((s, c) => s + c.valor, 0);
    qtd = itens.length;
  }
  _faturaAPagar = { cartaoId, mes };
  const form = document.getElementById('form-pagar-fatura');
  form.reset();
  form.data_pagamento.value = hojeIso();
  document.getElementById('modal-pagar-fatura-titulo').textContent = `Pagar fatura — ${cartao.nome}`;
  document.getElementById('pagar-fatura-resumo').textContent =
    `Fatura de ${mesAnoBr(mes + '-01')}, vencimento dia ${cartao.dia_vencimento}: ${qtd} lançamento(s) em aberto, total ${formatMoeda(total)}. Todos serão baixados com a data abaixo.`;
  showModal('#modal-pagar-fatura');
}

async function salvarPagarFatura() {
  const form = document.getElementById('form-pagar-fatura');
  const res = await apiFetch(`${API_URL}/financeiro/contas-financeiras/${_faturaAPagar.cartaoId}/pagar-fatura`, {
    method: 'POST', body: JSON.stringify({ mes: _faturaAPagar.mes, data_pagamento: form.data_pagamento.value })
  });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-pagar-fatura'));
  alert(r.mensagem);
  aposMudarConta();
}

async function carregarCategoriasDespesa() {
  const [rc, rg] = await Promise.all([
    apiFetch(`${API_URL}/financeiro/categorias-despesa`),
    _gruposDre.length ? null : apiFetch(`${API_URL}/financeiro/grupos-dre`)
  ]);
  if (rc && rc.ok) _categoriasDespesa = await rc.json();
  if (rg && rg.ok) _gruposDre = await rg.json();
}

async function preencherSelectsConta(form, conta) {
  const [, rf] = await Promise.all([carregarCategoriasDespesa(), apiFetch(`${API_URL}/fornecedores`), carregarContasFinanceiras()]);
  const ativas = _categoriasDespesa.filter(c => c.ativo || (conta && c.id === conta.categoria_id));
  form.categoria_id.innerHTML = '<option value="">Selecione...</option>' + _gruposDre.map(g => {
    const cats = ativas.filter(c => c.grupo_dre === g.id);
    return cats.length ? `<optgroup label="${escapeHtml(g.nome)}">${cats.map(c =>
      `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const fornecedores = rf && rf.ok ? (await rf.json()).filter(f => f.ativo !== false || (conta && f.id === conta.fornecedor_id)) : [];
  form.fornecedor_id.innerHTML = '<option value="">—</option>' + fornecedores.map(f =>
    `<option value="${f.id}">${escapeHtml(f.nome || f.razao_social)}</option>`).join('');
  form.conta_financeira_id.innerHTML = opcoesContasFinanceiras(conta && conta.conta_financeira_id);
  if (conta) {
    form.categoria_id.value = conta.categoria_id || '';
    form.fornecedor_id.value = conta.fornecedor_id || '';
    form.conta_financeira_id.value = conta.conta_financeira_id || '';
  }
}

// Cartão escolhido → pede o mês da fatura (o vencimento é o dia da fatura); senão, a data de vencimento
function ajustarCampoVencimento() {
  const form = document.getElementById('form-conta-pagar');
  const cartao = cartaoPorId(form.conta_financeira_id.value);
  document.getElementById('conta-venc-data').hidden = !!cartao;
  document.getElementById('conta-venc-fatura').hidden = !cartao;
  form.data_vencimento.required = !cartao;
  form.mes_fatura.required = !!cartao;
  if (cartao) {
    if (!form.mes_fatura.value) form.mes_fatura.value = (form.data_vencimento.value || hojeIso()).slice(0, 7);
    document.getElementById('conta-venc-fatura-dica').textContent = `Vence no dia ${cartao.dia_vencimento} da fatura escolhida.`;
  } else if (!form.data_vencimento.value && form.mes_fatura.value) {
    form.data_vencimento.value = `${form.mes_fatura.value}-10`;
  }
}

function ajustarTipoLancamento() {
  const form = document.getElementById('form-conta-pagar');
  const tipo = form.tipo.value;
  document.getElementById('conta-parcelas-campos').hidden = tipo !== 'parcelada';
  document.getElementById('conta-tipo-dica').textContent = {
    unica: '',
    parcelada: 'Dívida já em andamento? Informe a parcela deste mês: o sistema cria só as que faltam.',
    recorrente: 'Lança 12 meses e renova sozinho. Para encerrar, exclua "esta e as próximas".'
  }[tipo];
}

// modelo (opcional): pré-preenche a partir de uma linha da Visão mensal { descricao, categoria_id, natureza, conta_financeira_id, fornecedor_id, valor, mes }
async function abrirNovaConta(modelo) {
  contaEmEdicao = null;
  const form = document.getElementById('form-conta-pagar');
  form.reset();
  const mes = (modelo && modelo.mes) || (document.getElementById('cp-mes').value || hojeIso().slice(0, 7));
  form.data_vencimento.value = modelo && modelo.mes ? `${modelo.mes}-10` : hojeIso();
  form.mes_fatura.value = mes;
  form.competencia.value = mes;
  form.data_pagamento.value = hojeIso();
  document.getElementById('conta-nova-campos').hidden = false;
  document.getElementById('conta-paga-campos').hidden = true;
  document.getElementById('conta-seguintes-linha').hidden = true;
  await preencherSelectsConta(form, modelo && modelo.categoria_id ? modelo : null);
  if (modelo && modelo.descricao) {
    form.descricao.value = modelo.descricao;
    form.valor.value = modelo.valor || '';
    form.natureza.value = modelo.natureza || 'empresa';
  }
  ajustarCampoVencimento();
  ajustarTipoLancamento();
  document.getElementById('modal-conta-pagar-titulo').textContent = modelo && modelo.descricao
    ? `Lançar "${modelo.descricao}" em ${mesAnoBr(mes + '-01')}` : 'Nova conta a pagar';
  showModal('#modal-conta-pagar');
}

// Busca a conta no cache da tela de contas a pagar; se não estiver (veio da Visão mensal), pede à API
async function obterConta(id) {
  let c = _contasCache.find(x => x.id === id);
  if (!c) {
    const res = await apiFetch(`${API_URL}/financeiro/contas-pagar/${id}`);
    if (!res || !res.ok) return null;
    c = await res.json();
    _contasCache.push(c);
  }
  return c;
}

async function editarConta(id) {
  const c = await obterConta(id);
  if (!c) return;
  contaEmEdicao = c;
  const form = document.getElementById('form-conta-pagar');
  form.reset();
  await preencherSelectsConta(form, c);
  form.descricao.value = c.descricao;
  form.valor.value = c.valor;
  form.natureza.value = c.natureza || 'empresa';
  form.data_vencimento.value = c.data_vencimento;
  form.mes_fatura.value = c.data_vencimento.slice(0, 7);
  form.competencia.value = c.competencia.slice(0, 7);
  form.documento.value = c.documento || '';
  form.observacoes.value = c.observacoes || '';
  ajustarCampoVencimento();
  document.getElementById('conta-nova-campos').hidden = true;
  document.getElementById('conta-seguintes-linha').hidden = !c.grupo_id || (!c.recorrente && c.parcela >= c.total_parcelas);
  const serie = c.recorrente ? ' (assinatura)' : c.parcela ? ` (${c.parcela}/${c.total_parcelas})` : '';
  document.getElementById('modal-conta-pagar-titulo').textContent = `Editar conta${serie}`;
  showModal('#modal-conta-pagar');
}

async function salvarConta() {
  const form = document.getElementById('form-conta-pagar');
  const cartao = cartaoPorId(form.conta_financeira_id.value);
  const dados = {
    descricao: form.descricao.value,
    categoria_id: form.categoria_id.value,
    fornecedor_id: form.fornecedor_id.value,
    natureza: form.natureza.value,
    conta_financeira_id: form.conta_financeira_id.value,
    valor: form.valor.value,
    data_vencimento: form.data_vencimento.value,
    mes_fatura: cartao ? form.mes_fatura.value : undefined,
    competencia: form.competencia.value,
    documento: form.documento.value,
    observacoes: form.observacoes.value
  };
  if (contaEmEdicao) {
    dados.aplicar_seguintes = form.aplicar_seguintes.checked;
  } else {
    dados.tipo = form.tipo.value;
    dados.parcela_inicial = form.parcela_inicial.value;
    dados.total_parcelas = form.total_parcelas.value;
    dados.ja_paga = form.ja_paga.value === '1';
    dados.data_pagamento = form.data_pagamento.value;
    dados.forma_pagamento = form.forma_pagamento.value;
  }
  const url = contaEmEdicao ? `${API_URL}/financeiro/contas-pagar/${contaEmEdicao.id}` : `${API_URL}/financeiro/contas-pagar`;
  const res = await apiFetch(url, { method: contaEmEdicao ? 'PUT' : 'POST', body: JSON.stringify(dados) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-conta-pagar'));
  if (!contaEmEdicao && dados.tipo !== 'unica') alert(r.mensagem);
  const mesVenc = cartao ? dados.mes_fatura : dados.data_vencimento.slice(0, 7);
  if (!contaEmEdicao && mesVenc && mesVenc !== mesFiltro('cp-mes')) document.getElementById('cp-mes').value = mesVenc;
  aposMudarConta();
}

async function acaoContaPagar(id, caminho, confirmacao, corpo, query = '') {
  if (confirmacao && !confirm(confirmacao)) return null;
  const res = await apiFetch(`${API_URL}/financeiro/contas-pagar/${id}${caminho}${query}`, {
    method: caminho ? 'POST' : 'DELETE', body: corpo ? JSON.stringify(corpo) : undefined
  });
  if (!res) return null;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return null; }
  aposMudarConta();
  return r;
}

async function abrirBaixaConta(id) {
  const c = await obterConta(id);
  if (!c) return;
  contaBaixa = c; faturaBaixa = null;
  prepararModalBaixa(`Pagamento — ${c.descricao}`, 'Valor pago (R$) *', c.valor);
}

async function excluirConta(id) {
  const c = await obterConta(id);
  if (!c) return;
  let query = '';
  const temProximas = c.grupo_id && (c.recorrente || c.parcela < c.total_parcelas);
  if (temProximas) {
    const serie = c.recorrente ? 'uma assinatura' : `uma série (${c.parcela}/${c.total_parcelas})`;
    const todas = confirm(`"${c.descricao}" faz parte de ${serie}.\n\nOK = excluir esta e as próximas em aberto${c.recorrente ? ' (encerra a assinatura)' : ''}\nCancelar = escolher excluir só esta`);
    if (todas) query = '?seguintes=1';
    else if (!confirm(`Excluir só o lançamento de ${diaBr(c.data_vencimento)} de "${c.descricao}"?`)) return;
  } else if (!confirm(`Excluir "${c.descricao}" (${formatMoeda(c.valor)})?`)) return;
  const r = await acaoContaPagar(id, '', null, null, query);
  if (r && query) alert(r.mensagem);
}

async function estornarConta(id) {
  const c = await obterConta(id);
  acaoContaPagar(id, '/estornar-baixa', `Desfazer o pagamento de "${c ? c.descricao : ''}"? A conta volta para em aberto.`);
}

// ===== Contas e cartões =====
async function abrirContasFinanceiras() {
  await carregarContasFinanceiras();
  limparFormContaFinanceira();
  renderContasFinanceiras();
  showModal('#modal-contas-financeiras');
}

function renderContasFinanceiras() {
  document.getElementById('cf-lista').innerHTML = _contasFinanceiras.map(c => `
    <div class="fin-cat-item ${c.ativo ? '' : 'inativa'}">
      <div>
        <strong>${escapeHtml(c.nome)}</strong>${c.ativo ? '' : ' <span class="fin-muted">(inativa)</span>'}
        <span class="fin-sub">${c.tipo === 'cartao' ? `Cartão · fatura vence dia ${c.dia_vencimento}${c.dia_fechamento ? `, fecha dia ${c.dia_fechamento}` : ''}` : 'Conta bancária'} · ${c.total_uso} lançamento(s)</span>
      </div>
      <div class="fin-cat-acoes">
        ${botao('edit', 'Editar', `editarContaFinanceira(${c.id})`)}
        ${botao(c.ativo ? 'ban' : 'refresh', c.ativo ? 'Desativar' : 'Reativar', `alternarContaFinanceira(${c.id})`)}
      </div>
    </div>`).join('') || '<p class="fin-muted">Nenhuma conta ou cartão ainda. Cadastre, por exemplo, "Conta Bradesco" e cada cartão de crédito.</p>';
}

function limparFormContaFinanceira() {
  contaFinanceiraEmEdicao = null;
  const form = document.getElementById('form-conta-financeira');
  form.reset();
  document.getElementById('cf-campos-cartao').hidden = true;
  document.getElementById('cf-form-titulo').textContent = 'Nova conta ou cartão';
  document.getElementById('cf-cancelar').hidden = true;
}

function editarContaFinanceira(id) {
  const c = _contasFinanceiras.find(x => x.id === id);
  if (!c) return;
  contaFinanceiraEmEdicao = c;
  const form = document.getElementById('form-conta-financeira');
  form.nome.value = c.nome;
  form.tipo.value = c.tipo;
  form.dia_vencimento.value = c.dia_vencimento || '';
  form.dia_fechamento.value = c.dia_fechamento || '';
  document.getElementById('cf-campos-cartao').hidden = c.tipo !== 'cartao';
  document.getElementById('cf-form-titulo').textContent = `Editando "${c.nome}"`;
  document.getElementById('cf-cancelar').hidden = false;
  form.nome.focus();
}

async function gravarContaFinanceira(id, dados) {
  const res = await apiFetch(`${API_URL}/financeiro/contas-financeiras${id ? `/${id}` : ''}`, {
    method: id ? 'PUT' : 'POST', body: JSON.stringify(dados)
  });
  if (!res) return false;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return false; }
  await carregarContasFinanceiras();
  renderContasFinanceiras();
  if (typeof renderPaginaContasFinanceiras === 'function') renderPaginaContasFinanceiras();
  // Se o formulário de lançamento estiver aberto, atualiza a lista de "Pago com"
  const formConta = document.getElementById('form-conta-pagar');
  if (document.getElementById('modal-conta-pagar').classList.contains('show')) {
    const sel = formConta.conta_financeira_id.value;
    formConta.conta_financeira_id.innerHTML = opcoesContasFinanceiras(sel);
    formConta.conta_financeira_id.value = sel;
  }
  return true;
}

async function salvarContaFinanceira() {
  const form = document.getElementById('form-conta-financeira');
  const c = contaFinanceiraEmEdicao;
  const ok = await gravarContaFinanceira(c && c.id, {
    nome: form.nome.value, tipo: form.tipo.value, dia_vencimento: form.dia_vencimento.value,
    dia_fechamento: form.dia_fechamento.value, ativo: c ? c.ativo : true
  });
  if (ok) limparFormContaFinanceira();
}

function alternarContaFinanceira(id) {
  const c = _contasFinanceiras.find(x => x.id === id);
  if (c) gravarContaFinanceira(c.id, { ...c, ativo: !c.ativo });
}

// ===== Categorias de despesa =====
async function abrirCategoriasDespesa() {
  await carregarCategoriasDespesa();
  const form = document.getElementById('form-categoria-despesa');
  form.grupo_dre.innerHTML = _gruposDre.map(g => `<option value="${g.id}">${escapeHtml(g.nome)}</option>`).join('');
  limparFormCategoriaDespesa();
  renderCategoriasDespesa();
  showModal('#modal-categorias-despesa');
}

function renderCategoriasDespesa() {
  const nomeGrupo = id => (_gruposDre.find(g => g.id === id) || {}).nome || id;
  document.getElementById('cat-desp-lista').innerHTML = _categoriasDespesa.map(c => `
    <div class="fin-cat-item ${c.ativo ? '' : 'inativa'}">
      <div>
        <strong>${escapeHtml(c.nome)}</strong>${c.ativo ? '' : ' <span class="fin-muted">(inativa)</span>'}
        <span class="fin-sub">${escapeHtml(nomeGrupo(c.grupo_dre))} · ${c.total_uso} conta(s)</span>
      </div>
      <div class="fin-cat-acoes">
        ${botao('edit', 'Editar', `editarCategoriaDespesa(${c.id})`)}
        ${botao(c.ativo ? 'ban' : 'refresh', c.ativo ? 'Desativar' : 'Reativar', `alternarCategoriaDespesa(${c.id})`)}
      </div>
    </div>`).join('') || '<p class="fin-muted">Nenhuma categoria.</p>';
}

function limparFormCategoriaDespesa() {
  categoriaDespesaEmEdicao = null;
  const form = document.getElementById('form-categoria-despesa');
  form.reset();
  document.getElementById('cat-desp-form-titulo').textContent = 'Nova categoria';
  document.getElementById('cat-desp-cancelar').hidden = true;
}

function editarCategoriaDespesa(id) {
  const c = _categoriasDespesa.find(x => x.id === id);
  if (!c) return;
  categoriaDespesaEmEdicao = c;
  const form = document.getElementById('form-categoria-despesa');
  form.nome.value = c.nome;
  form.grupo_dre.value = c.grupo_dre;
  document.getElementById('cat-desp-form-titulo').textContent = `Editando "${c.nome}"`;
  document.getElementById('cat-desp-cancelar').hidden = false;
  form.nome.focus();
}

async function gravarCategoriaDespesa(id, dados) {
  const res = await apiFetch(`${API_URL}/financeiro/categorias-despesa${id ? `/${id}` : ''}`, {
    method: id ? 'PUT' : 'POST', body: JSON.stringify(dados)
  });
  if (!res) return false;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return false; }
  await carregarCategoriasDespesa();
  renderCategoriasDespesa();
  if (typeof renderPaginaCategoriasDespesa === 'function') renderPaginaCategoriasDespesa();
  return true;
}

async function salvarCategoriaDespesa() {
  const form = document.getElementById('form-categoria-despesa');
  const c = categoriaDespesaEmEdicao;
  const ok = await gravarCategoriaDespesa(c && c.id, { nome: form.nome.value, grupo_dre: form.grupo_dre.value, ativo: c ? c.ativo : true });
  if (ok) limparFormCategoriaDespesa();
}

function alternarCategoriaDespesa(id) {
  const c = _categoriasDespesa.find(x => x.id === id);
  if (c) gravarCategoriaDespesa(c.id, { nome: c.nome, grupo_dre: c.grupo_dre, ativo: !c.ativo });
}

// ===== Fluxo de caixa =====
const corValor = v => (v < 0 ? ' fin-negativo' : '');

async function loadFluxoCaixa() {
  const inicio = document.getElementById('fc-inicio');
  if (!inicio.value) {
    const d = new Date(); d.setMonth(d.getMonth() - 2);
    inicio.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const meses = document.getElementById('fc-meses').value;
  const box = document.getElementById('fc-tabela');
  box.innerHTML = '<p class="fin-muted">Carregando...</p>';
  const res = await apiFetch(`${API_URL}/financeiro/fluxo-caixa?inicio=${inicio.value}&meses=${meses}`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }

  document.getElementById('fc-aviso').innerHTML = d.saldo_inicial_data ? '' :
    '<div class="fin-aviso">Saldo inicial não informado: o saldo considera apenas os pagamentos registrados no sistema. Use "Saldo inicial" para partir do saldo real do banco.</div>';

  const linhas = [
    ['Saldo no início do mês', 'saldo_abertura', 'saldo'],
    ['(+) Recebido', 'entradas_realizadas', 'entrada'],
    ['(+) Faturas a receber', 'entradas_previstas', 'entrada'],
    ['(+) Contratos a faturar (estimado)', 'contratos_estimados', 'entrada'],
    ['(−) Pago', 'saidas_realizadas', 'saida'],
    ['(−) Contas a pagar', 'saidas_previstas', 'saida'],
    ['Saldo no fim do mês', 'saldo_final', 'total']
  ];
  const th = d.meses.map(m => `<th class="${m.mes === d.mes_atual ? 'fin-col-atual' : ''}">${mesAnoBr(m.mes)}</th>`).join('');
  const corpo = linhas.map(([rotulo, k, tipo]) => `
    <tr class="fin-linha-${tipo}">
      <th scope="row">${rotulo}</th>
      ${d.meses.map(m => {
        const v = m[k];
        const txt = v === 0 && tipo !== 'saldo' && tipo !== 'total' ? '<span class="fin-muted">—</span>' : formatMoeda(tipo === 'saida' ? -v : v);
        return `<td class="fin-num${m.mes === d.mes_atual ? ' fin-col-atual' : ''}${corValor(tipo === 'saida' ? -v : v)}">${txt}</td>`;
      }).join('')}
    </tr>`).join('');
  box.innerHTML = `<table><thead><tr><th></th>${th}</tr></thead><tbody>${corpo}</tbody></table>`;

  const tbody = document.getElementById('fc-proximos-tbody');
  tbody.innerHTML = d.proximos.length ? d.proximos.map(p => `
    <tr>
      <td data-label="Vencimento">${diaBr(p.data_vencimento)}${p.vencida ? ` ${pill('Atrasada', '#b42318')}` : ''}</td>
      <td data-label="Tipo">${p.tipo === 'receber' ? pill('A receber', '#2e7d4f') : pill('A pagar', '#b7791f')}</td>
      <td data-label="Descrição">${escapeHtml(p.descricao)}</td>
      <td data-label="Valor" class="fin-num${p.tipo === 'pagar' ? ' fin-negativo' : ''}">${formatMoeda(p.tipo === 'pagar' ? -p.valor : p.valor)}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="text-center">Nada vencendo nos próximos 30 dias.</td></tr>';
}

async function abrirSaldoInicial() {
  const res = await apiFetch(`${API_URL}/financeiro/config`);
  if (!res) return;
  const c = await res.json();
  const form = document.getElementById('form-saldo-inicial');
  form.saldo_inicial.value = c.saldo_inicial ?? 0;
  form.saldo_inicial_data.value = c.saldo_inicial_data ? String(c.saldo_inicial_data).slice(0, 10) : hojeIso().slice(0, 8) + '01';
  showModal('#modal-saldo-inicial');
}

async function salvarSaldoInicial() {
  const form = document.getElementById('form-saldo-inicial');
  const res = await apiFetch(`${API_URL}/financeiro/saldo-inicial`, {
    method: 'PUT',
    body: JSON.stringify({ saldo_inicial: form.saldo_inicial.value, saldo_inicial_data: form.saldo_inicial_data.value })
  });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-saldo-inicial'));
  loadFluxoCaixa();
}

// ===== DRE =====
let _dre = null;

async function loadDre() {
  const sel = document.getElementById('dre-ano');
  if (!sel.options.length) {
    const atual = new Date().getFullYear();
    for (let a = atual + 1; a >= 2024; a--) sel.add(new Option(String(a), String(a), false, a === atual));
  }
  const box = document.getElementById('dre-tabela');
  box.innerHTML = '<p class="fin-muted">Carregando...</p>';
  const res = await apiFetch(`${API_URL}/financeiro/dre?ano=${sel.value}`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }
  _dre = d;
  renderDre();
}

function renderDre() {
  if (!_dre) return;
  const detalhar = document.getElementById('dre-detalhar').checked;
  const celula = v => `<td class="fin-num${corValor(v)}">${v === 0 ? '<span class="fin-muted">—</span>' : formatMoeda(v)}</td>`;
  const linhas = _dre.linhas.filter(l => detalhar || l.tipo !== 'categoria');
  // Grupos de despesa sem nenhum valor no ano ficam escondidos (a menos que abra por categoria)
  const visiveis = linhas.filter(l => detalhar || l.tipo !== 'grupo' || l.chave === 'receita_bruta' || l.total !== 0);
  const receita = _dre.linhas.find(l => l.chave === 'receita_bruta');
  const liquido = _dre.linhas.find(l => l.chave === 'resultado_liquido');
  const margem = (r, l) => (r ? `${((l / r) * 100).toFixed(1).replace('.', ',')}%` : '—');

  const th = MESES_CURTOS.map(m => `<th>${m}</th>`).join('') + '<th>Total</th>';
  const corpo = visiveis.map(l => `
    <tr class="fin-dre-${l.tipo}">
      <th scope="row">${escapeHtml(l.rotulo)}</th>
      ${l.valores.map(celula).join('')}${celula(l.total)}
    </tr>`).join('') + `
    <tr class="fin-dre-margem">
      <th scope="row">Margem líquida</th>
      ${liquido.valores.map((v, i) => `<td class="fin-num">${margem(receita.valores[i], v)}</td>`).join('')}
      <td class="fin-num">${margem(receita.total, liquido.total)}</td>
    </tr>`;
  document.getElementById('dre-tabela').innerHTML =
    `<table><thead><tr><th></th>${th}</tr></thead><tbody>${corpo}</tbody></table>`;
  document.getElementById('dre-fora').textContent = _dre.fora_resultado.total
    ? `Fora da DRE (retiradas, lucros, empréstimos, parcelamentos): ${formatMoeda(_dre.fora_resultado.total)} no ano` +
      ((_dre.fora_resultado.categorias || []).length
        ? ` (${_dre.fora_resultado.categorias.map(c => `${c.nome} ${formatMoeda(c.total)}`).join(' · ')})` : '') +
      '. Esses valores aparecem no fluxo de caixa.'
    : '';
}

document.addEventListener('DOMContentLoaded', () => {
  const sub = (id, fn) => document.getElementById(id).addEventListener('submit', e => { e.preventDefault(); fn(); });
  sub('form-contrato', salvarContrato);
  sub('form-fatura', salvarFatura);
  sub('form-baixa', salvarBaixa);
  sub('form-fin-config', salvarConfigFinanceiro);
  sub('form-conta-pagar', salvarConta);
  sub('form-categoria-despesa', salvarCategoriaDespesa);
  sub('form-saldo-inicial', salvarSaldoInicial);
  sub('form-conta-financeira', salvarContaFinanceira);
  sub('form-pagar-fatura', salvarPagarFatura);
});
