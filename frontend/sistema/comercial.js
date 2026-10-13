// ===== COMERCIAL: funil de vendas (kanban), oportunidades e propostas =====
// Usa helpers do script.js (apiFetch, API_URL, escapeHtml, formatMoeda, diaBr, showModal, closeModal, iconSVG)
// e do financeiro.js (pill, botao, hojeIso, preencherClientesSelect).

Object.assign(_ICONS, {
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  copiar: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>'
});

let _funilMeta = null;
let _oportunidades = [];
let _opAtual = null;        // oportunidade aberta no modal (com histórico e propostas)
let _propostaAtual = null;  // proposta em edição
let _itensProposta = [];

const COR_ETAPA = { lead: '#64748b', qualificacao: '#1d6fd8', proposta: '#7c3aed', negociacao: '#b7791f', ganha: '#2e7d4f', perdida: '#b42318' };
const STATUS_PROPOSTA = {
  rascunho: ['Rascunho', '#64748b'], enviada: ['Enviada', '#1d6fd8'], aceita: ['Aceita', '#2e7d4f'],
  recusada: ['Recusada', '#b42318'], substituida: ['Substituída', '#94a3b8']
};
const nomeEtapa = id => ((_funilMeta && _funilMeta.etapas.find(e => e.id === id)) || { nome: id }).nome;
const nomeOrigem = id => ((_funilMeta && _funilMeta.origens.find(o => o.id === id)) || { nome: id }).nome;

async function carregarMetaFunil() {
  if (_funilMeta) return _funilMeta;
  const res = await apiFetch(`${API_URL}/comercial/meta`);
  if (res && res.ok) _funilMeta = await res.json();
  return _funilMeta;
}

async function resultadoJson(res) {
  if (!res) return null;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return null; }
  return r;
}

// ===== Kanban =====
async function loadFunil() {
  const board = document.getElementById('funil-board');
  if (!_oportunidades.length) board.innerHTML = '<p class="fin-muted">Carregando...</p>';
  await carregarMetaFunil();
  const dias = document.getElementById('funil-fechadas').value;
  const [ro, rr] = await Promise.all([
    apiFetch(`${API_URL}/comercial/oportunidades?fechadas_dias=${dias}`),
    apiFetch(`${API_URL}/comercial/resumo`)
  ]);
  if (!ro || !rr) return;
  if (!ro.ok) { const e = await ro.json(); board.innerHTML = `<p class="fin-muted">${escapeHtml(e.erro)}</p>`; return; }
  _oportunidades = await ro.json();
  if (rr.ok) {
    const r = await rr.json();
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    set('funil-pipeline', `${formatMoeda(r.pipeline_mensal)}/mês`);
    set('funil-pipeline-qtd', `${r.abertas} oportunidade(s) abertas`);
    set('funil-ponderado', `${formatMoeda(r.ponderado_mensal)}/mês`);
    set('funil-unico', `+ ${formatMoeda(r.pipeline_unico)} em valores únicos`);
    set('funil-ganho', `${formatMoeda(r.ganho_mensal_90)}/mês`);
    set('funil-ganho-qtd', `${r.ganhas_90} ganha(s) · ${r.perdidas_90} perdida(s)`);
    set('funil-leads', String(r.leads_site_7));
  }
  renderFunil();
}

function valoresOportunidade(o) {
  return [o.valor_mensal > 0 && `${formatMoeda(o.valor_mensal)}/mês`, o.valor_unico > 0 && `${formatMoeda(o.valor_unico)} único`]
    .filter(Boolean).join(' + ') || '<span class="fin-muted">sem valor</span>';
}

function renderFunil() {
  const board = document.getElementById('funil-board');
  const busca = document.getElementById('funil-busca').value.trim().toLowerCase();
  const lista = _oportunidades.filter(o => !busca ||
    `${o.nome_exibicao || ''} ${o.contato_nome || ''} ${o.titulo}`.toLowerCase().includes(busca));
  board.innerHTML = _funilMeta.etapas.map(e => {
    const cards = lista.filter(o => o.etapa === e.id);
    const total = cards.reduce((s, o) => s + o.valor_mensal, 0);
    return `
    <section class="funil-coluna" data-etapa="${e.id}" style="--etapa:${COR_ETAPA[e.id]}"
             ondragover="event.preventDefault(); this.classList.add('alvo')" ondragleave="this.classList.remove('alvo')"
             ondrop="soltarCartao(event, '${e.id}')">
      <header class="funil-coluna-topo">
        <strong>${escapeHtml(e.nome)}</strong><span class="funil-qtd">${cards.length}</span>
        <span class="funil-total">${total ? `${formatMoeda(total)}/mês` : ''}</span>
      </header>
      <div class="funil-cartoes">
        ${cards.map(o => `
          <article class="funil-cartao" draggable="true" tabindex="0" role="button"
                   aria-label="Abrir ${escapeHtml(o.titulo)}"
                   ondragstart="event.dataTransfer.setData('text/plain', '${o.id}')"
                   onclick="abrirOportunidade(${o.id})" onkeydown="if(event.key==='Enter')abrirOportunidade(${o.id})">
            <strong class="funil-cartao-nome">${escapeHtml(o.nome_exibicao || o.contato_nome || '—')}</strong>
            <span class="funil-cartao-titulo">${escapeHtml(o.titulo)}</span>
            <span class="funil-cartao-valor">${valoresOportunidade(o)}</span>
            <span class="funil-cartao-rodape">
              ${o.origem === 'site' ? pill('Site', '#0891b2') : ''}
              ${o.ultima_proposta_status ? pill(`Proposta ${STATUS_PROPOSTA[o.ultima_proposta_status][0].toLowerCase()}`, STATUS_PROPOSTA[o.ultima_proposta_status][1]) : ''}
              ${o.contrato_id ? pill('Contrato gerado', '#2e7d4f') : ''}
              ${o.previsao_fechamento && !['ganha', 'perdida'].includes(o.etapa) ? `<span class="fin-muted">prev. ${diaBr(o.previsao_fechamento)}</span>` : ''}
              ${o.etapa === 'perdida' && o.motivo_perda ? `<span class="fin-muted">${escapeHtml(o.motivo_perda)}</span>` : ''}
            </span>
          </article>`).join('') || '<p class="funil-vazio">—</p>'}
      </div>
    </section>`;
  }).join('');
}

async function soltarCartao(ev, etapa) {
  ev.preventDefault();
  document.querySelectorAll('.funil-coluna.alvo').forEach(c => c.classList.remove('alvo'));
  const id = Number(ev.dataTransfer.getData('text/plain'));
  const o = _oportunidades.find(x => x.id === id);
  if (!o || o.etapa === etapa) return;
  if (await moverEtapa(id, etapa)) loadFunil();
}

async function moverEtapa(id, etapa) {
  let motivo;
  if (etapa === 'perdida') {
    motivo = prompt('Por que a oportunidade foi perdida? (ex.: preço, prazo, escolheu concorrente, sem orçamento)');
    if (!motivo) return false;
  }
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/oportunidades/${id}/etapa`, {
    method: 'POST', body: JSON.stringify({ etapa, motivo_perda: motivo })
  }));
  if (r && etapa === 'ganha') {
    const o = _oportunidades.find(x => x.id === id) || _opAtual;
    if (o && !o.contrato_id && o.valor_mensal > 0 &&
        confirm('Oportunidade ganha! Quer gerar agora o contrato recorrente (e cadastrar o cliente, se for prospect)?')) {
      await abrirOportunidade(id);
      abrirGerarContrato();
    }
  }
  return !!r;
}

// ===== Oportunidade (modal) =====
function preencherSelectsOportunidade(form) {
  form.origem.innerHTML = _funilMeta.origens.map(o => `<option value="${o.id}">${escapeHtml(o.nome)}</option>`).join('');
  document.getElementById('op-etapa-select').innerHTML =
    _funilMeta.etapas.map(e => `<option value="${e.id}">${escapeHtml(e.nome)}</option>`).join('');
}

function alternarProspect() {
  const form = document.getElementById('form-oportunidade');
  document.getElementById('op-prospect-row').style.display = form.cliente_id.value ? 'none' : '';
}

async function abrirNovaOportunidade() {
  await carregarMetaFunil();
  _opAtual = null;
  const form = document.getElementById('form-oportunidade');
  form.reset();
  preencherSelectsOportunidade(form);
  form.origem.value = 'indicacao';
  await preencherClientesSelect(form.cliente_id);
  form.cliente_id.options[0].textContent = '— Prospect (ainda não é cliente) —';
  alternarProspect();
  document.getElementById('op-painel').hidden = true;
  document.getElementById('op-extras').hidden = true;
  document.getElementById('op-mensagem-row').hidden = true;
  document.getElementById('modal-oportunidade-titulo').textContent = 'Nova oportunidade';
  showModal('#modal-oportunidade');
}

async function abrirOportunidade(id) {
  await carregarMetaFunil();
  const res = await apiFetch(`${API_URL}/comercial/oportunidades/${id}`);
  const o = await resultadoJson(res);
  if (!o) return;
  _opAtual = o;
  const form = document.getElementById('form-oportunidade');
  const jaAberto = document.getElementById('modal-oportunidade').classList.contains('show');
  if (!jaAberto) {
    form.reset();
    preencherSelectsOportunidade(form);
    await preencherClientesSelect(form.cliente_id, o.cliente_id);
    form.cliente_id.options[0].textContent = '— Prospect (ainda não é cliente) —';
    ['titulo', 'empresa_nome', 'contato_nome', 'contato_email', 'contato_telefone', 'origem', 'interesse',
     'previsao_fechamento', 'observacoes'].forEach(k => { form[k].value = o[k] ?? ''; });
    form.valor_mensal.value = o.valor_mensal || '';
    form.valor_unico.value = o.valor_unico || '';
    form.probabilidade.value = o.probabilidade ?? '';
    alternarProspect();
  }
  document.getElementById('op-mensagem-row').hidden = !o.mensagem_origem;
  document.getElementById('op-mensagem').textContent = o.mensagem_origem || '';
  document.getElementById('op-etapa-select').value = o.etapa;
  document.getElementById('op-painel').hidden = false;
  document.getElementById('op-extras').hidden = false;
  document.getElementById('modal-oportunidade-titulo').textContent = o.nome_exibicao || o.titulo;

  const acoes = [];
  if (o.contrato_id) acoes.push(`<span class="fin-muted">Contrato #${o.contrato_id} gerado</span>`);
  else acoes.push(`<button type="button" class="btn btn-secondary" onclick="abrirGerarContrato()">Gerar contrato</button>`);
  if (!['ganha', 'perdida'].includes(o.etapa)) {
    acoes.push(`<button type="button" class="btn btn-secondary" onclick="abrirSimuladorConector(${o.id})">Simular Conector SAP</button>`);
  }
  if (!o.contrato_id) acoes.push(`<button type="button" class="btn btn-danger btn-icon" title="Excluir oportunidade" aria-label="Excluir oportunidade" onclick="excluirOportunidade()">${iconSVG('trash')}</button>`);
  document.getElementById('op-painel-acoes').innerHTML =
    `${pill(nomeEtapa(o.etapa), COR_ETAPA[o.etapa])} ${acoes.join('')}`;

  renderPropostasOportunidade(o);
  document.getElementById('op-historico').innerHTML = o.historico.map(h => `
    <div class="op-hist-item op-hist-${h.tipo}">
      <span class="op-hist-data">${new Date(h.data_criacao).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${h.usuario_nome ? ` · ${escapeHtml(h.usuario_nome)}` : ''}</span>
      <div class="op-hist-texto">${escapeHtml(h.texto)}</div>
    </div>`).join('') || '<p class="fin-muted">Sem registros.</p>';
  if (!jaAberto) showModal('#modal-oportunidade');
}

function renderPropostasOportunidade(o) {
  document.getElementById('op-propostas').innerHTML = o.propostas.map(p => {
    const [txt, cor] = STATUS_PROPOSTA[p.status] || [p.status, '#64748b'];
    const b = [botao('eye', 'Visualizar / imprimir', `window.open('/proposta.html?id=${p.id}', '_blank')`)];
    if (p.status === 'rascunho') {
      b.push(botao('edit', 'Editar', `editarProposta(${p.id})`, 'btn-edit'));
      b.push(botao('mail', 'Enviar ao cliente', `enviarProposta(${p.id})`));
      b.push(botao('trash', 'Excluir rascunho', `excluirProposta(${p.id})`, 'btn-danger'));
    } else if (p.status === 'enviada') {
      b.push(botao('copiar', 'Copiar link do cliente', `copiarLinkProposta('${p.token}')`));
      b.push(botao('mail', 'Reenviar por e-mail', `enviarProposta(${p.id}, true)`));
      b.push(botao('check', 'Marcar como aceita', `respostaManual(${p.id}, 'aceita')`, 'btn-edit'));
      b.push(botao('ban', 'Marcar como recusada', `respostaManual(${p.id}, 'recusada')`));
    }
    if (p.status !== 'rascunho') b.push(botao('refresh', 'Nova versão', `novaVersaoProposta(${p.id})`));
    const totais = [p.total_mensal > 0 && `${formatMoeda(p.total_mensal)}/mês`, p.total_unico > 0 && `${formatMoeda(p.total_unico)} único`].filter(Boolean).join(' + ');
    const detalhe = [
      `válida até ${diaBr(p.validade)}${p.expirada && ['rascunho', 'enviada'].includes(p.status) ? ' (vencida)' : ''}`,
      p.data_visualizacao && p.status === 'enviada' ? 'cliente já abriu' : null,
      p.resposta_nome ? `respondida por ${p.resposta_nome}` : null
    ].filter(Boolean).join(' · ');
    return `
    <div class="op-proposta">
      <div class="op-proposta-info">
        <strong>${escapeHtml(p.numero)}${p.versao > 1 ? ` v${p.versao}` : ''}</strong> ${pill(txt, cor)}
        <span class="fin-sub">${escapeHtml(p.titulo)} · ${totais || 'sem itens'}</span>
        <span class="fin-sub">${escapeHtml(detalhe)}</span>
        ${p.resposta_comentario ? `<span class="fin-sub">“${escapeHtml(p.resposta_comentario)}”</span>` : ''}
      </div>
      <div class="op-proposta-acoes">${b.join('')}</div>
    </div>`;
  }).join('') || '<p class="fin-muted">Nenhuma proposta ainda.</p>';
}

async function recarregarOportunidade() {
  if (_opAtual) await abrirOportunidade(_opAtual.id);
  loadFunil();
}

async function salvarOportunidade() {
  const form = document.getElementById('form-oportunidade');
  const dados = Object.fromEntries(['titulo', 'cliente_id', 'empresa_nome', 'contato_nome', 'contato_email', 'contato_telefone',
    'origem', 'interesse', 'valor_mensal', 'valor_unico', 'probabilidade', 'previsao_fechamento', 'observacoes']
    .map(k => [k, form[k].value]));
  if (dados.cliente_id) { dados.empresa_nome = ''; }
  const novo = !_opAtual;
  const r = await resultadoJson(await apiFetch(
    novo ? `${API_URL}/comercial/oportunidades` : `${API_URL}/comercial/oportunidades/${_opAtual.id}`,
    { method: novo ? 'POST' : 'PUT', body: JSON.stringify(dados) }));
  if (!r) return;
  if (novo) {
    closeModal(document.getElementById('modal-oportunidade'));
    await abrirOportunidade(r.id); // reabre já com propostas e histórico
    loadFunil();
  } else {
    await recarregarOportunidade();
  }
}

async function moverEtapaModal() {
  const etapa = document.getElementById('op-etapa-select').value;
  if (!_opAtual || etapa === _opAtual.etapa) return;
  if (await moverEtapa(_opAtual.id, etapa)) recarregarOportunidade();
}

async function excluirOportunidade() {
  if (!_opAtual || !confirm(`Excluir a oportunidade "${_opAtual.titulo}" com suas propostas e histórico?`)) return;
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/oportunidades/${_opAtual.id}`, { method: 'DELETE' }));
  if (!r) return;
  _opAtual = null;
  closeModal(document.getElementById('modal-oportunidade'));
  loadFunil();
}

async function adicionarNota() {
  const form = document.getElementById('form-op-nota');
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/oportunidades/${_opAtual.id}/notas`, {
    method: 'POST', body: JSON.stringify({ texto: form.texto.value })
  }));
  if (!r) return;
  form.reset();
  recarregarOportunidade();
}

// ===== Propostas =====
async function novaProposta() {
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/oportunidades/${_opAtual.id}/propostas`, {
    method: 'POST', body: JSON.stringify({})
  }));
  if (!r) return;
  await recarregarOportunidade();
  editarProposta(r.id);
}

async function novaVersaoProposta(id) {
  if (!confirm('Criar uma nova versão (rascunho) a partir desta proposta? Quando a nova for enviada, esta deixa de valer.')) return;
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/oportunidades/${_opAtual.id}/propostas`, {
    method: 'POST', body: JSON.stringify({ copiar_de: id })
  }));
  if (!r) return;
  await recarregarOportunidade();
  editarProposta(r.id);
}

async function editarProposta(id) {
  const p = await resultadoJson(await apiFetch(`${API_URL}/comercial/propostas/${id}`));
  if (!p) return;
  _propostaAtual = p;
  const form = document.getElementById('form-proposta');
  form.reset();
  ['titulo', 'validade', 'introducao', 'escopo', 'condicoes'].forEach(k => { form[k].value = p[k] || ''; });
  _itensProposta = (p.itens || []).map(it => ({ ...it }));
  if (!_itensProposta.length) _itensProposta.push({ descricao: '', tipo: 'mensal', quantidade: 1, valor_unitario: 0 });
  renderItensProposta();
  document.getElementById('modal-proposta-titulo').textContent = `Proposta ${p.numero}${p.versao > 1 ? ` v${p.versao}` : ''}`;
  showModal('#modal-proposta');
}

function renderItensProposta() {
  document.getElementById('prop-itens').innerHTML = _itensProposta.map((it, i) => `
    <div class="prop-item">
      <input type="text" aria-label="Descrição do item ${i + 1}" placeholder="Descrição" value="${escapeHtml(it.descricao)}"
             oninput="_itensProposta[${i}].descricao = this.value">
      <select aria-label="Tipo do item ${i + 1}" onchange="_itensProposta[${i}].tipo = this.value; atualizarTotaisProposta()">
        <option value="mensal" ${it.tipo === 'mensal' ? 'selected' : ''}>Mensal</option>
        <option value="unico" ${it.tipo === 'unico' ? 'selected' : ''}>Único</option>
      </select>
      <input type="number" aria-label="Quantidade do item ${i + 1}" min="0.01" step="0.01" value="${it.quantidade}"
             oninput="_itensProposta[${i}].quantidade = Number(this.value); atualizarTotaisProposta()">
      <input type="number" aria-label="Valor unitário do item ${i + 1}" min="0" step="0.01" value="${it.valor_unitario}"
             oninput="_itensProposta[${i}].valor_unitario = Number(this.value); atualizarTotaisProposta()">
      <button type="button" class="btn btn-icon btn-danger" title="Remover item" aria-label="Remover item ${i + 1}"
              onclick="_itensProposta.splice(${i}, 1); renderItensProposta()">${iconSVG('trash')}</button>
    </div>`).join('');
  atualizarTotaisProposta();
}

function adicionarItemProposta() {
  _itensProposta.push({ descricao: '', tipo: 'mensal', quantidade: 1, valor_unitario: 0 });
  renderItensProposta();
  const linhas = document.querySelectorAll('#prop-itens .prop-item input[type="text"]');
  linhas[linhas.length - 1].focus();
}

function atualizarTotaisProposta() {
  const soma = tipo => _itensProposta.filter(i => i.tipo === tipo)
    .reduce((s, i) => s + (Number(i.quantidade) || 0) * (Number(i.valor_unitario) || 0), 0);
  document.getElementById('prop-totais').innerHTML =
    `<span>Mensal: <strong>${formatMoeda(soma('mensal'))}</strong></span><span>Único: <strong>${formatMoeda(soma('unico'))}</strong></span>`;
}

async function salvarProposta() {
  const form = document.getElementById('form-proposta');
  const dados = Object.fromEntries(['titulo', 'validade', 'introducao', 'escopo', 'condicoes'].map(k => [k, form[k].value]));
  dados.itens = _itensProposta;
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/propostas/${_propostaAtual.id}`, {
    method: 'PUT', body: JSON.stringify(dados)
  }));
  if (!r) return;
  closeModal(document.getElementById('modal-proposta'));
  recarregarOportunidade();
}

async function copiarLinkProposta(token) {
  const link = `${location.origin}/proposta.html?t=${token}`;
  try { await navigator.clipboard.writeText(link); alert(`Link copiado:\n${link}`); }
  catch { prompt('Copie o link da proposta:', link); }
}

async function enviarProposta(id, soEmail = false) {
  const p = _opAtual.propostas.find(x => x.id === id);
  const destino = _opAtual.contato_email;
  let enviarEmail = false;
  if (soEmail) {
    if (!destino) { alert('A oportunidade não tem e-mail de contato.'); return; }
    if (!confirm(`Reenviar a proposta ${p.numero} para ${destino}?`)) return;
    enviarEmail = true;
  } else {
    if (!confirm(`Enviar a proposta ${p.numero}?\n\nDepois de enviada ela não pode mais ser editada (dá para criar uma nova versão).`)) return;
    enviarEmail = !!destino && confirm(`Mandar por e-mail para ${destino}?\n\nOK = enviar e-mail com o link\nCancelar = só gerar o link (você manda por WhatsApp, por exemplo)`);
  }
  const res = await apiFetch(`${API_URL}/comercial/propostas/${id}/enviar`, { method: 'POST', body: JSON.stringify({ enviar_email: enviarEmail }) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) {
    alert(r.erro);
    if (r.link) { recarregarOportunidade(); prompt('Link da proposta:', r.link); }
    return;
  }
  await recarregarOportunidade();
  if (r.enviado) alert(r.mensagem);
  else copiarLinkProposta(r.link.split('t=')[1]);
}

async function respostaManual(id, status) {
  const comentario = prompt(status === 'aceita'
    ? 'Proposta aceita fora do link (telefone, e-mail...). Observação (opcional):'
    : 'Proposta recusada. Motivo ou comentário (opcional):', '');
  if (comentario === null) return;
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/propostas/${id}/status`, {
    method: 'POST', body: JSON.stringify({ status, comentario })
  }));
  if (!r) return;
  await recarregarOportunidade();
  if (status === 'aceita' && !_opAtual.contrato_id && confirm(`${r.mensagem}\n\nGerar agora o contrato recorrente?`)) abrirGerarContrato();
}

async function excluirProposta(id) {
  if (!confirm('Excluir este rascunho de proposta?')) return;
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/propostas/${id}`, { method: 'DELETE' }));
  if (r) recarregarOportunidade();
}

// ===== Gerar contrato =====
function abrirGerarContrato() {
  const o = _opAtual;
  if (!o) return;
  const aceita = o.propostas.find(p => p.status === 'aceita');
  const form = document.getElementById('form-gerar-contrato');
  form.reset();
  form.descricao.value = o.titulo;
  form.descricao_servico.value = aceita ? aceita.titulo : o.titulo;
  form.valor.value = (aceita && aceita.total_mensal) || o.valor_mensal || '';
  form.dia_vencimento.value = 10;
  const d = new Date(); d.setMonth(d.getMonth() + 1, 1);
  form.data_inicio.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  document.getElementById('gc-aviso').textContent = o.cliente_id
    ? `O contrato será criado para ${o.nome_exibicao}.`
    : `"${o.empresa_nome || o.contato_nome}" ainda é prospect: será cadastrado como cliente com os dados de contato. Depois complete CNPJ e endereço em Clientes (a nota fiscal precisa).`;
  showModal('#modal-gerar-contrato');
}

async function salvarGerarContrato() {
  const form = document.getElementById('form-gerar-contrato');
  const dados = Object.fromEntries(['descricao', 'descricao_servico', 'valor', 'dia_vencimento', 'data_inicio'].map(k => [k, form[k].value]));
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/oportunidades/${_opAtual.id}/gerar-contrato`, {
    method: 'POST', body: JSON.stringify(dados)
  }));
  if (!r) return;
  closeModal(document.getElementById('modal-gerar-contrato'));
  alert(r.mensagem);
  recarregarOportunidade();
}

// ===== Modelo da proposta =====
const CAMPOS_CONFIG_PROPOSTA = ['prop_razao_social', 'prop_cnpj', 'prop_contato', 'prop_apresentacao', 'prop_condicoes_padrao', 'prop_validade_dias'];

async function abrirConfigPropostas() {
  const c = await resultadoJson(await apiFetch(`${API_URL}/comercial/config`));
  if (!c) return;
  const form = document.getElementById('form-config-propostas');
  CAMPOS_CONFIG_PROPOSTA.forEach(k => { form[k].value = c[k] ?? ''; });
  showModal('#modal-config-propostas');
}

async function salvarConfigPropostas() {
  const form = document.getElementById('form-config-propostas');
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/config`, {
    method: 'PUT', body: JSON.stringify(Object.fromEntries(CAMPOS_CONFIG_PROPOSTA.map(k => [k, form[k].value])))
  }));
  if (r) closeModal(document.getElementById('modal-config-propostas'));
}

// ===== Simulador de preço — Conector SAP =====
// A regra de preço fica no backend (services/precificacao-conector.js): a tela manda as entradas para
// POST /comercial/simulador-conector/calcular (com debounce) e só desenha o resultado.
let _simTimer = null;
let _simSeq = 0;
let _simResultado = null;
let _simPrecos = null;
let _simOportunidadePendente = null; // aberto a partir de uma oportunidade

async function loadSimuladorConector() {
  const form = document.getElementById('form-simulador');
  const [rc, ro, rp] = await Promise.all([
    _simPrecos ? null : apiFetch(`${API_URL}/comercial/simulador-conector/config`),
    apiFetch(`${API_URL}/comercial/oportunidades?fechadas_dias=0`),
    form.validade_dias.value ? null : apiFetch(`${API_URL}/comercial/config`)
  ]);
  if (rc) {
    const c = await resultadoJson(rc);
    if (!c) return;
    _simPrecos = c.precos;
    // ROI vazio = padrão da tabela de preços
    ['roi_horas_funcional', 'roi_custo_funcional', 'roi_horas_abap', 'roi_custo_abap'].forEach(k => {
      if (form[k].value === '') form[k].value = _simPrecos[k];
    });
  }
  if (rp && rp.ok) form.validade_dias.value = (await rp.json()).prop_validade_dias || 15;
  if (ro && ro.ok) {
    const lista = await ro.json();
    const sel = form.oportunidade_id;
    const atual = _simOportunidadePendente || sel.value;
    sel.innerHTML = '<option value="">— Escolha a oportunidade —</option>' + lista.map(o =>
      `<option value="${o.id}">${escapeHtml(o.nome_exibicao || o.contato_nome || '—')} · ${escapeHtml(o.titulo)}</option>`).join('');
    if (atual) sel.value = String(atual);
    _simOportunidadePendente = null;
  }
  alternarFabricaSimulador();
  simularConector();
}

// Atalho do modal da oportunidade: abre o simulador já com ela escolhida
function abrirSimuladorConector(oportunidadeId) {
  _simOportunidadePendente = oportunidadeId;
  closeModal(document.getElementById('modal-oportunidade'));
  showPage('simulador-conector');
}

function alternarFabricaSimulador() {
  const form = document.getElementById('form-simulador');
  const modo = form.fabrica.value;
  document.getElementById('sim-avulso').hidden = modo !== 'avulso';
  document.getElementById('sim-pacote').hidden = modo !== 'pacote';
  if (_simPrecos) {
    document.getElementById('sim-pacote-hint').textContent =
      `${String(_simPrecos.pacote_horas).replace('.', ',')} h por ${formatMoeda(_simPrecos.pacote_valor)}/mês cada pacote.`;
  }
}

function entradasSimulador() {
  const form = document.getElementById('form-simulador');
  const v = k => form[k].value;
  const modo = v('fabrica');
  return {
    funcionais: v('funcionais'), abaps: v('abaps'), ciclo: v('ciclo'), modalidade: v('modalidade'),
    sistemas: v('sistemas'), porte: v('porte'),
    chamados_p: modo === 'avulso' ? v('chamados_p') : 0,
    chamados_m: modo === 'avulso' ? v('chamados_m') : 0,
    chamados_g: modo === 'avulso' ? v('chamados_g') : 0,
    pacotes: modo === 'pacote' ? v('pacotes') : 0,
    desconto_pct: v('desconto_pct'), desconto_meses: v('desconto_meses'),
    desconto_implantacao: form.desconto_implantacao.checked,
    validade_dias: v('validade_dias'),
    roi_horas_funcional: v('roi_horas_funcional'), roi_custo_funcional: v('roi_custo_funcional'),
    roi_horas_abap: v('roi_horas_abap'), roi_custo_abap: v('roi_custo_abap')
  };
}

function agendarSimulacao() {
  clearTimeout(_simTimer);
  _simTimer = setTimeout(simularConector, 300);
}

async function simularConector() {
  const seq = ++_simSeq;
  const res = await apiFetch(`${API_URL}/comercial/simulador-conector/calcular`, {
    method: 'POST', body: JSON.stringify(entradasSimulador())
  });
  if (!res || seq !== _simSeq) return; // resposta atrasada de uma digitação anterior
  const r = await res.json();
  const erro = document.getElementById('sim-erro');
  if (!res.ok) {
    _simResultado = null;
    erro.textContent = r.erro || 'Não foi possível calcular.';
    erro.hidden = false;
    document.querySelector('.sim-resultado').classList.add('sim-desatualizado');
    return;
  }
  erro.hidden = true;
  document.querySelector('.sim-resultado').classList.remove('sim-desatualizado');
  _simResultado = r;
  renderSimulacao(r);
}

function renderSimulacao(r) {
  const t = r.totais;
  const e = r.entradas;
  const temDesc = e.desconto_pct > 0;
  const tile = (rotulo, valor, detalhe) => `
    <div class="rel-tile"><span class="rel-tile-rotulo">${rotulo}</span>
      <span class="rel-tile-valor">${valor}</span><span class="rel-tile-detalhe">${detalhe}</span></div>`;
  document.getElementById('sim-tiles').innerHTML = [
    tile('Total mensal', `${formatMoeda(temDesc ? t.mensal_desconto : t.mensal_cheio)}`,
      temDesc ? `com ${String(e.desconto_pct).replace('.', ',')}% por ${e.desconto_meses} ${e.desconto_meses === 1 ? 'mês' : 'meses'} · cheio ${formatMoeda(t.mensal_cheio)}` : 'preço cheio'),
    tile('Total único', formatMoeda(t.unico), e.porte === 'nenhum' ? 'sem implantação' : `implantação${e.desconto_implantacao ? ' com desconto' : ''}`),
    tile('Total do 1º ano', formatMoeda(t.primeiro_ano), temDesc ? `${t.meses_desconto_1o_ano} ${t.meses_desconto_1o_ano === 1 ? 'mês' : 'meses'} com desconto + implantação` : '12 meses + implantação'),
    tile('Licenças por mês', formatMoeda(t.licencas_desconto), `plano ${r.modalidade_escolhida === 'empresa' ? 'Empresa' : 'Individual'} · ${r.comparacao.usuarios} usuário(s)`)
  ].join('');

  const c = r.comparacao;
  const linha = (id, nome) => `
    <tr class="${c.escolhida === id ? 'sim-escolhida' : ''}">
      <th scope="row">${nome}${c.mais_barata === id ? ' ' + pill('mais barato', '#2e7d4f') : ''}${c.escolhida === id ? ' ' + pill('na proposta', '#1d6fd8') : ''}</th>
      <td>${formatMoeda(c[id])}/mês</td>
    </tr>`;
  document.getElementById('sim-comparacao').innerHTML = `
    <div class="fin-matriz"><table>
      <thead><tr><th>Modalidade</th><th>Licenças (preço cheio)</th></tr></thead>
      <tbody>${linha('individual', 'Individual (por usuário)')}${linha('empresa', 'Empresa (pacote)')}</tbody>
    </table></div>
    <p class="fin-muted">${c.diferenca > 0
      ? `Diferença de ${formatMoeda(c.diferenca)}/mês a favor do ${c.mais_barata === 'empresa' ? 'Empresa' : 'Individual'}.`
      : 'Mesmo preço: fica o Empresa (inclui painel do gestor).'}</p>`;

  document.getElementById('sim-itens').innerHTML = `
    <table>
      <thead><tr><th>Item</th><th>Qtd × valor</th><th>Total</th></tr></thead>
      <tbody>${r.itens.map(it => `
        <tr>
          <th scope="row">${escapeHtml(it.descricao)}<span class="fin-sub">${it.tipo === 'mensal' ? 'Mensal' : 'Valor único'}</span></th>
          <td>${String(it.quantidade).replace('.', ',')} × ${formatMoeda(it.valor_unitario)}</td>
          <td><strong>${formatMoeda(it.total)}</strong>${it.tipo === 'mensal' ? '/mês' : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const roi = r.roi;
  document.getElementById('sim-roi').innerHTML = roi ? `
    <div class="fin-matriz"><table><tbody>
      <tr><th scope="row">Economia estimada</th><td>${formatMoeda(roi.economia_mensal)}/mês</td></tr>
      <tr><th scope="row">Custo das licenças (cheio)</th><td>${formatMoeda(roi.custo_licencas_mensal)}/mês</td></tr>
      <tr><th scope="row">Ganho líquido</th><td>${formatMoeda(roi.ganho_liquido_mensal)}/mês${roi.multiplo ? ` · ${String(roi.multiplo).replace('.', ',')}×` : ''}</td></tr>
      <tr><th scope="row">Payback da implantação</th><td>${roi.payback_meses === null ? 'não se paga com essas premissas' : roi.payback_meses === 0 ? 'imediato' : `${roi.payback_meses} ${roi.payback_meses === 1 ? 'mês' : 'meses'}`}</td></tr>
    </tbody></table></div>
    <p class="fin-muted">${escapeHtml(roi.resumo)}</p>` : '<p class="fin-muted">Informe horas economizadas e custo/hora para estimar o retorno.</p>';
}

async function gerarPropostaConector() {
  const form = document.getElementById('form-simulador');
  const opId = form.oportunidade_id.value;
  if (!opId) { alert('Escolha a oportunidade em que a proposta será criada.'); form.oportunidade_id.focus(); return; }
  if (!_simResultado) { alert('Corrija os dados da simulação antes de gerar a proposta.'); return; }
  // Abre a aba já no clique (senão o navegador bloqueia o pop-up depois do await)
  const aba = window.open('', '_blank');
  const btn = document.getElementById('sim-btn-gerar');
  btn.disabled = true;
  try {
    const res = await apiFetch(`${API_URL}/comercial/oportunidades/${opId}/propostas`, {
      method: 'POST',
      body: JSON.stringify({ simulador_conector: entradasSimulador(), incluir_roi: form.incluir_roi.checked })
    });
    const r = await resultadoJson(res);
    if (!r) { if (aba) aba.close(); return; }
    const url = `/proposta.html?id=${r.id}`;
    if (aba) aba.location.href = url; else window.open(url, '_blank');
    if (confirm('Proposta criada como rascunho na oportunidade.\n\nAbrir a oportunidade para revisar, enviar o link ao cliente ou criar nova versão?')) {
      abrirOportunidade(Number(opId));
    }
  } finally {
    btn.disabled = false;
  }
}

// Tabela de preços (editável): os campos vêm do backend (rótulos + valores)
async function abrirPrecosConector() {
  const c = await resultadoJson(await apiFetch(`${API_URL}/comercial/simulador-conector/config`));
  if (!c) return;
  const grupos = [
    ['Licença por usuário (R$/mês)', ['leitura_mensal', 'leitura_anual', 'dev_mensal', 'dev_anual']],
    ['Plano Empresa (R$/mês)', ['empresa_ate5', 'empresa_ate10', 'empresa_excedente', 'empresa_acrescimo_mensal_pct']],
    ['Implantação (valor único)', ['impl_pequeno', 'impl_medio', 'impl_grande', 'impl_sistema_adicional']],
    ['Fábrica ABAP', ['chamado_p', 'chamado_m', 'chamado_g', 'pacote_horas', 'pacote_valor']],
    ['Padrões do ROI', ['roi_horas_funcional', 'roi_custo_funcional', 'roi_horas_abap', 'roi_custo_abap']]
  ];
  document.getElementById('precos-conector-campos').innerHTML = grupos.map(([titulo, chaves]) => `
    <div class="form-section-title">${titulo}</div>
    <div class="precos-grade">${chaves.map(k => `
      <div class="form-group">
        <label for="preco-${k}">${escapeHtml(c.rotulos[k])}</label>
        <input type="number" id="preco-${k}" name="${k}" min="0" step="0.01" value="${c.precos[k]}" placeholder="${c.padrao[k]}">
        <small class="form-hint">Padrão: ${c.padrao[k]}</small>
      </div>`).join('')}
    </div>`).join('');
  showModal('#modal-precos-conector');
}

async function salvarPrecosConector() {
  const form = document.getElementById('form-precos-conector');
  const precos = Object.fromEntries([...form.querySelectorAll('input[name]')].map(i => [i.name, i.value]));
  const r = await resultadoJson(await apiFetch(`${API_URL}/comercial/simulador-conector/config`, {
    method: 'PUT', body: JSON.stringify({ precos })
  }));
  if (!r) return;
  _simPrecos = r.precos;
  closeModal(document.getElementById('modal-precos-conector'));
  alternarFabricaSimulador();
  simularConector();
}

document.addEventListener('DOMContentLoaded', () => {
  const sub = (id, fn) => document.getElementById(id).addEventListener('submit', e => { e.preventDefault(); fn(); });
  sub('form-precos-conector', salvarPrecosConector);
  sub('form-oportunidade', salvarOportunidade);
  sub('form-op-nota', adicionarNota);
  sub('form-proposta', salvarProposta);
  sub('form-gerar-contrato', salvarGerarContrato);
  sub('form-config-propostas', salvarConfigPropostas);
});
