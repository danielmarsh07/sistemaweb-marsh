// ===== Contratos do Conector por vagas (painel) =====
// Regras no backend (services/contratos-conector.js): comprador = gestor, vagas por perfil (abap | funcional | ambos),
// cada vaga ocupada por uma pessoa que vê só os cursos do perfil. O gestor faz o mesmo pelo portal.
let _contratosConector = [];
let _contratoAberto = null;

const brData = d => String(d || '').slice(0, 10).split('-').reverse().join('/');

function badgeContrato(k) {
  const [txt, cor] = k.status === 'cancelado' ? ['Cancelado', '#64748b'] : k.status === 'suspenso' ? ['Suspenso', '#f59e0b']
    : k.vigente ? ['Ativo', '#10b981'] : ['Vencido', '#ef4444'];
  return `<span style="background:${cor}20; color:${cor}; padding:2px 8px; border-radius:20px; font-size:0.78rem; font-weight:600">${txt}</span>`;
}

async function loadContratosConector() {
  const tbody = document.getElementById('contratos-conector-tbody');
  const res = await apiFetch(`${API_URL}/contratos-conector`);
  if (!res) return;
  const dados = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="9" class="text-center">${escapeHtml(dados.erro)}</td></tr>`; return; }
  _contratosConector = dados;
  if (!dados.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center">Nenhum contrato. Use "+ Novo contrato".</td></tr>';
    return;
  }
  tbody.innerHTML = dados.map(k => {
    const vagas = [k.vagas_abap && `${k.vagas_abap} ABAP`, k.vagas_funcional && `${k.vagas_funcional} Funcional`,
      k.vagas_ambos && `${k.vagas_ambos} Ambos`].filter(Boolean).join(' · ');
    return `
    <tr>
      <td data-label="Nº">${k.id}</td>
      <td data-label="Cliente"><strong>${escapeHtml(k.cliente_nome)}</strong></td>
      <td data-label="Gestor">${escapeHtml(k.gestor_nome)}<span class="licenca-prefixo">${escapeHtml(k.gestor_email)}</span></td>
      <td data-label="Vagas">${escapeHtml(vagas || '—')}</td>
      <td data-label="Ocupadas">${k.ocupadas} / ${k.vagas}</td>
      <td data-label="Sistemas">${k.total_sids}</td>
      <td data-label="Validade">${brData(k.data_inicio)} a ${brData(k.data_fim)}</td>
      <td data-label="Status">${badgeContrato(k)}</td>
      <td data-label="Ações" class="td-acoes">
        <button class="btn btn-secondary btn-sm" onclick="abrirContratoConector(${k.id})">Abrir</button>
      </td>
    </tr>`;
  }).join('');
}

const PERFIS_CONECTOR = [['abap', 'ABAP'], ['funcional', 'Funcional'], ['ambos', 'ABAP + Funcional']];
// Preço de lista (tabela Preços Conector SAP) do formulário aberto, para mostrar o desconto de cada perfil
let _listaConector = {};

async function abrirNovoContratoConector(clienteId) {
  resetForm('#form-novo-contrato-conector');
  const f = document.getElementById('form-novo-contrato-conector');
  const umAno = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  f.data_fim.value = umAno;
  f.max_sids.value = 3;
  PERFIS_CONECTOR.forEach(([p]) => {
    f[p].value = 0;
    f[p].oninput = recalcularNovoConector;
    f[`preco_${p}`].oninput = recalcularNovoConector;
  });
  f.gerar_cobranca.checked = true;
  f.dia_vencimento.value = 10;
  await preencherClientesSelect(f.cliente_id, clienteId);
  f.cliente_id.onchange = () => carregarPrecosNovoConector(f);
  await carregarPrecosNovoConector(f);
  showModal('#modal-novo-contrato-conector');
}

// Preço de partida: o do último contrato do cliente; sem contrato anterior, a tabela (lista)
async function carregarPrecosNovoConector(f) {
  const cli = f.cliente_id.value ? `&cliente_id=${encodeURIComponent(f.cliente_id.value)}` : '';
  const res = await apiFetch(`${API_URL}/contratos-conector/preco-sugerido?abap=0&funcional=0&ambos=0${cli}`);
  if (!res || !res.ok) return;
  const d = await res.json();
  _listaConector = {};
  d.linhas.forEach(l => { _listaConector[l.perfil] = l.preco_lista; f[`preco_${l.perfil}`].value = l.preco_mensal; });
  document.getElementById('ncc-preco-origem').textContent = d.origem === 'cliente'
    ? `Preço do último contrato deste cliente (nº ${d.contrato_referencia}). Altere se a negociação for outra; a tabela de lista não muda.`
    : 'Preço da tabela Preços Conector SAP (lista). Altere aqui para dar um preço especial só para este cliente; a tabela não muda.';
  recalcularNovoConector();
}

// Texto do preço comparado à lista: "lista R$ 790,00 · 18% de desconto"
function notaLista(preco, lista) {
  if (!(lista > 0)) return '';
  const pct = Math.round((1 - preco / lista) * 1000) / 10;
  return `lista ${formatMoeda(lista)}${pct > 0 ? ` · ${String(pct).replace('.', ',')}% de desconto` : pct < 0 ? ` · ${String(-pct).replace('.', ',')}% acima` : ''}`;
}

// Conta na hora, por perfil: licenças × preço × 12; no fim, o valor anual explicado
function recalcularNovoConector() {
  const f = document.getElementById('form-novo-contrato-conector');
  let total = 0;
  const partes = [];
  PERFIS_CONECTOR.forEach(([p, rotulo]) => {
    const q = Number(f[p].value) || 0;
    const preco = Number(f[`preco_${p}`].value) || 0;
    const ano = Math.round(q * preco * 12 * 100) / 100;
    total += ano;
    document.getElementById(`ncc-lista-${p}`).textContent = notaLista(preco, _listaConector[p]);
    document.getElementById(`ncc-total-${p}`).innerHTML = q > 0
      ? `${q} × ${formatMoeda(preco)} × 12<br><strong>${formatMoeda(ano)}</strong>` : '—';
    if (q > 0) partes.push(`${rotulo} ${formatMoeda(ano)}`);
  });
  document.getElementById('ncc-preco-hint').innerHTML = partes.length
    ? `${partes.join(' + ')}<br><strong>Valor anual: ${formatMoeda(total)}</strong>`
    : 'Informe quantas licenças de cada perfil.';
}

async function salvarNovoContratoConector() {
  const f = document.getElementById('form-novo-contrato-conector');
  const corpo = {
    cliente_id: f.cliente_id.value, gestor_nome: f.gestor_nome.value, gestor_email: f.gestor_email.value,
    vagas: { abap: f.abap.value, funcional: f.funcional.value, ambos: f.ambos.value },
    precos: { abap: f.preco_abap.value, funcional: f.preco_funcional.value, ambos: f.preco_ambos.value },
    data_inicio: f.data_inicio.value || undefined, data_fim: f.data_fim.value, max_sids: f.max_sids.value,
    observacoes: f.observacoes.value,
    cobranca: { gerar: f.gerar_cobranca.checked, dia_vencimento: f.dia_vencimento.value }
  };
  const res = await apiFetch(`${API_URL}/contratos-conector`, { method: 'POST', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  closeModal(document.getElementById('modal-novo-contrato-conector'));
  loadContratosConector();
  if (document.getElementById('contratos-page').classList.contains('active')) loadContratos();
}

async function abrirContratoConector(id, manterAberto) {
  const res = await apiFetch(`${API_URL}/contratos-conector/${id}`);
  if (!res) return;
  const k = await res.json();
  if (!res.ok) { alert(k.erro); return; }
  _contratoAberto = k;
  document.getElementById('contrato-conector-titulo').textContent = `Contrato nº ${k.id} — ${k.cliente_nome}`;
  document.getElementById('contrato-conector-resumo').innerHTML =
    `${badgeContrato(k)} Gestor: <strong>${escapeHtml(k.gestor_nome)}</strong> (${escapeHtml(k.gestor_email)})` +
    `${k.cpf_cnpj ? ` · CPF/CNPJ ${escapeHtml(k.cpf_cnpj)}` : ''} · origem: ${k.origem === 'loja' ? 'compra pelo site' : 'manual'}`;
  const mesesNome = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  document.getElementById('contrato-conector-cobranca').innerHTML = k.cobranca
    ? `Cobrança: <strong>${formatMoeda(k.cobranca.valor)}/ano</strong> (em ${mesesNome[k.cobranca.mes_cobranca - 1]}, vencimento dia ${k.cobranca.dia_vencimento}) — contrato financeiro CT-${String(k.cobranca.id).padStart(4, '0')}${k.cobranca.status !== 'ativo' ? ` (${escapeHtml(k.cobranca.status)})` : ''}.`
    : `<span style="color:#b7791f">Sem cobrança no Financeiro.</span> <button type="button" class="btn btn-secondary btn-sm" onclick="criarCobrancaConector()">Criar cobrança anual</button>`;
  const f = document.getElementById('form-contrato-conector');
  f.status.value = k.status;
  f.data_inicio.value = k.data_inicio;
  f.data_fim.value = k.data_fim;
  f.max_sids.value = k.max_sids;
  f.observacoes.value = k.observacoes || '';
  document.getElementById('form-contrato-mais-vagas').reset();
  renderPrecosContrato(k);

  document.getElementById('contrato-conector-vagas').innerHTML = k.vagas.length ? k.vagas.map(v => {
    const pct = v.aulas_total ? Math.round(100 * v.aulas_concluidas / v.aulas_total) : 0;
    const pessoa = v.usuario_id
      ? `<strong>${escapeHtml(v.usuario_nome)}</strong>${v.eh_gestor ? ' (gestor)' : ''}${v.estado === 'convidada' ? ' <span style="color:#b7791f">(convite pendente)</span>' : ''}<small class="fin-muted" style="display:block">${escapeHtml(v.usuario_email)}</small>`
      : '<span class="fin-muted">Livre</span>';
    const acoes = v.usuario_id
      ? `${v.eh_gestor ? '' : `<button class="btn btn-secondary btn-sm" onclick="conviteVagaAdmin(${v.id})">Reenviar convite</button>`}
         <button class="btn btn-secondary btn-sm" onclick="liberarVagaAdmin(${v.id})">Liberar</button>`
      : `<button class="btn btn-secondary btn-sm" onclick="ocuparVagaAdmin(${v.id})">Passar para alguém</button>
         <button class="btn btn-secondary btn-sm" onclick="ocuparVagaAdmin(${v.id}, true)">Gestor ocupa</button>
         <button class="btn btn-icon btn-danger" title="Remover licença livre" aria-label="Remover licença livre" onclick="removerVagaAdmin(${v.id}, '${v.perfil}')">${iconSVG('trash')}</button>`;
    return `
      <tr>
        <td data-label="Perfil"><strong>${escapeHtml(v.perfil_nome)}</strong><small class="fin-muted" style="display:block">${escapeHtml(v.cursos.join(' · '))}</small></td>
        <td data-label="Pessoa">${pessoa}</td>
        <td data-label="Progresso">${v.usuario_id ? `${v.aulas_concluidas} de ${v.aulas_total} aulas (${pct}%)` : '—'}
          ${v.certificado ? `<small class="fin-muted" style="display:block">Certificado <a href="/certificado.html?c=${encodeURIComponent(v.certificado.codigo)}" target="_blank" rel="noopener">${escapeHtml(v.certificado.codigo)}</a></small>` : ''}
          ${v.licenca ? `<small class="fin-muted" style="display:block">Licença ${escapeHtml(v.licenca.chave_prefixo)} · ${escapeHtml(v.licenca.status)}${v.licenca.maquina_nome ? ` · ${escapeHtml(v.licenca.maquina_nome)}` : ''}</small>` : ''}</td>
        <td data-label="Ações" class="td-acoes">${acoes}</td>
      </tr>`;
  }).join('') : '<tr><td colspan="4" class="text-center">Nenhuma vaga.</td></tr>';

  const box = document.getElementById('contrato-conector-sids');
  box.innerHTML = '';
  (k.conexoes || []).forEach(c => adicionarSidAdmin(c));
  carregarAdminsCliente(k.cliente_id);
  document.getElementById('contrato-conector-historico').innerHTML = '';
  if (!manterAberto) showModal('#modal-contrato-conector');
}

const quantidadesConector = k => {
  const q = { abap: 0, funcional: 0, ambos: 0 };
  (k.vagas || []).forEach(v => { q[v.perfil] = (q[v.perfil] || 0) + 1; });
  return q;
};
const cobrancaAtiva = k => k.cobranca && k.cobranca.status === 'ativo';

// Preço negociado do contrato (editável) com o preço de lista ao lado e o total no ano
function renderPrecosContrato(k) {
  const q = quantidadesConector(k);
  const { precos, lista, origem } = k.preco;
  document.getElementById('contrato-conector-precos').innerHTML = PERFIS_CONECTOR.map(([p, rotulo]) => `
    <tr>
      <td data-label="Perfil"><strong>${rotulo}</strong></td>
      <td data-label="Licenças">${q[p]}</td>
      <td data-label="Preço negociado"><div class="form-group"><input type="number" name="preco_${p}" min="0" step="0.01" value="${precos[p]}">
        <small class="form-hint">${notaLista(precos[p], lista[p])}</small></div></td>
      <td data-label="Total no ano" class="fin-num">${formatMoeda(q[p] * precos[p] * 12)}</td>
    </tr>`).join('');
  document.getElementById('contrato-conector-precos-nota').textContent = {
    contrato: 'Preço próprio deste contrato: mudar a tabela de lista não altera este valor.',
    cobranca: 'Contrato anterior ao preço por contrato: o preço foi calculado a partir do valor cobrado hoje (mesmo desconto em todos os perfis). Salve para fixá-lo.',
    tabela: 'Sem preço próprio ainda: está usando a tabela de lista. Salve para fixar o preço deste contrato.'
  }[origem] || '';
}

async function salvarPrecosContrato(f) {
  const k = _contratoAberto;
  const q = quantidadesConector(k);
  const precos = Object.fromEntries(PERFIS_CONECTOR.map(([p]) => [p, f[`preco_${p}`].value]));
  const novo = PERFIS_CONECTOR.reduce((s, [p]) => s + q[p] * (Number(precos[p]) || 0) * 12, 0);
  if (cobrancaAtiva(k) && !confirm(`A anuidade passa de ${formatMoeda(k.cobranca.valor)} para ${formatMoeda(novo)} a partir da próxima cobrança.\nFaturas já geradas não mudam. Salvar?`)) return;
  const r = await acaoContrato('/precos', 'PUT', { precos });
  if (r) { alert(r.mensagem); recarregarContrato(); }
}

// Acrescentar licenças: mostra a conta (anuidade nova e fatura proporcional) e pede confirmação
async function acrescentarLicencas(f) {
  const q = { abap: Number(f.abap.value) || 0, funcional: Number(f.funcional.value) || 0, ambos: Number(f.ambos.value) || 0 };
  if (q.abap + q.funcional + q.ambos < 1) { alert('Informe quantas licenças acrescentar.'); return; }
  const p = await acaoContrato(`/licencas/previa?abap=${q.abap}&funcional=${q.funcional}&ambos=${q.ambos}`, 'GET');
  if (!p) return;
  const quais = PERFIS_CONECTOR.filter(([x]) => q[x] > 0).map(([x, rotulo]) => `${q[x]} ${rotulo}`).join(', ');
  let msg = `Acrescentar ${quais}.`;
  if (p.cobranca && p.cobranca.status === 'ativo') {
    msg += `\n\n• Anuidade: ${formatMoeda(p.valor_anual_atual)} → ${formatMoeda(p.valor_anual_novo)} (a partir da próxima cobrança)`;
    msg += p.valor_proporcional > 0
      ? `\n• Fatura proporcional agora (rascunho no Faturamento):\n   ${p.proporcional.map(l => `${l.quantidade} ${l.rotulo} × ${formatMoeda(l.preco_mensal)} × ${l.meses} mês(es) = ${formatMoeda(l.total)}`).join('\n   ')}\n   Total: ${formatMoeda(p.valor_proporcional)}`
      : '\n• Sem fatura proporcional (o contrato não está em vigência agora).';
  } else {
    msg += '\n\nEste contrato não tem cobrança ativa: as licenças entram sem cobrar.';
  }
  if (!confirm(msg + '\n\nConfirmar?')) return;
  const r = await acaoContrato('/vagas', 'POST', q);
  if (r) { alert(r.mensagem); recarregarContrato(); }
}

// Administradores da empresa do cliente (veem e distribuem as licenças no portal)
async function carregarAdminsCliente(clienteId) {
  const ul = document.getElementById('contrato-conector-admins');
  const res = await apiFetch(`${API_URL}/contratos-conector/clientes/${clienteId}/admins`);
  if (!res || !res.ok) { ul.innerHTML = ''; return; }
  const admins = await res.json();
  ul.innerHTML = admins.length ? admins.map(a => `
    <li>${escapeHtml(a.nome)} · ${escapeHtml(a.email)}${a.convite_pendente ? ' <span class="fin-muted">(convite pendente)</span>' : ''}
      ${admins.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" onclick="removerAdminCliente(${clienteId}, ${a.id})">Remover</button>` : ''}</li>`).join('')
    : '<li class="fin-muted">Nenhum administrador.</li>';
}

async function adicionarAdminCliente() {
  const k = _contratoAberto;
  const email = prompt('E-mail do administrador da empresa:');
  if (!email) return;
  const nome = prompt('Nome (para quem ainda não tem acesso ao portal):', '') || '';
  const res = await apiFetch(`${API_URL}/contratos-conector/clientes/${k.cliente_id}/admins`, { method: 'POST', body: JSON.stringify({ email: email.trim(), nome: nome.trim() }) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (res.ok) carregarAdminsCliente(k.cliente_id);
}

async function removerAdminCliente(clienteId, usuarioId) {
  if (!confirm('Remover este administrador? A conta continua; ele só deixa de ver e distribuir as licenças.')) return;
  const res = await apiFetch(`${API_URL}/contratos-conector/clientes/${clienteId}/admins/${usuarioId}`, { method: 'DELETE' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  carregarAdminsCliente(clienteId);
}

const ACOES_LICENCA_ADMIN = {
  'vaga.ocupada': 'Licença atribuída', 'vaga.convite_aceito': 'Convite aceito', 'vaga.liberada': 'Licença revogada',
  'vaga.convite_cancelado': 'Convite cancelado', 'vaga.convite_expirado': 'Convite expirou'
};
async function verHistoricoContratoConector() {
  const box = document.getElementById('contrato-conector-historico');
  box.textContent = 'Carregando…';
  const res = await apiFetch(`${API_URL}/contratos-conector/${_contratoAberto.id}/historico`);
  if (!res || !res.ok) { box.textContent = 'Não foi possível carregar.'; return; }
  const itens = await res.json();
  box.innerHTML = itens.length ? `<ul class="fin-lista-itens">${itens.map(h => {
    const acao = h.acao === 'vaga.ocupada' && h.dados && h.dados.estado === 'convidada' ? 'Convite enviado' : (ACOES_LICENCA_ADMIN[h.acao] || h.acao);
    return `<li><strong>${escapeHtml(acao)}</strong> · ${escapeHtml(h.pessoa_nome || (h.dados && h.dados.email) || '')}${h.dados && h.dados.perfil ? ` (${escapeHtml(h.dados.perfil)})` : ''}
      <small class="fin-muted" style="display:block">${new Date(h.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${h.feito_por ? ` · ${escapeHtml(h.feito_por)}` : ' · automático'}</small></li>`;
  }).join('')}</ul>` : '<span class="fin-muted">Nada registrado ainda.</span>';
}

async function criarCobrancaConector() {
  const k = _contratoAberto;
  const q = quantidadesConector(k);
  const valor = PERFIS_CONECTOR.reduce((s, [p]) => s + q[p] * k.preco.precos[p] * 12, 0);
  if (!confirm(`Criar a cobrança anual de ${formatMoeda(valor)} (licenças × preço deste contrato × 12)?\nPara outro valor, ajuste antes o preço deste contrato.`)) return;
  const res = await apiFetch(`${API_URL}/contratos-conector/${k.id}/cobranca`, { method: 'POST', body: JSON.stringify({}) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (res.ok) { abrirContratoConector(k.id, true); loadContratosConector(); }
}

function adicionarSidAdmin(c = {}) {
  const box = document.getElementById('contrato-conector-sids');
  if (_contratoAberto && box.children.length >= _contratoAberto.max_sids) {
    alert(`Este contrato permite até ${_contratoAberto.max_sids} sistemas SAP.`);
    return;
  }
  const div = document.createElement('div');
  div.className = 'form-row sid-admin';
  div.innerHTML = `
    <div class="form-group"><label>SID</label><input name="sid" maxlength="3" placeholder="DEV" value="${escapeHtml(c.sid || '')}"></div>
    <div class="form-group"><label>Descrição</label><input name="descricao" maxlength="100" value="${escapeHtml(c.descricao || '')}"></div>
    <div class="form-group"><label>URL</label><input name="url" maxlength="255" placeholder="https://servidor:8000" value="${escapeHtml(c.url || '')}"></div>
    <div class="form-group"><label>Mandante</label><input name="mandante" maxlength="3" value="${escapeHtml(c.mandante || '')}"></div>
    <div class="form-group"><label>Idioma</label><input name="idioma" maxlength="2" value="${escapeHtml(c.idioma || 'PT')}"></div>
    <div class="form-group"><button type="button" class="btn btn-icon btn-danger" title="Remover sistema" aria-label="Remover sistema" onclick="this.closest('.sid-admin').remove()">${iconSVG('trash')}</button></div>`;
  box.appendChild(div);
}

async function acaoContrato(caminho, metodo = 'POST', corpo) {
  const res = await apiFetch(`${API_URL}/contratos-conector/${_contratoAberto.id}${caminho}`, {
    method: metodo, body: corpo ? JSON.stringify(corpo) : undefined });
  if (!res) return null;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return null; }
  return r;
}

async function recarregarContrato() {
  await abrirContratoConector(_contratoAberto.id, true);
  loadContratosConector();
  if (document.getElementById('contratos-page').classList.contains('active')) loadContratos();
}

async function salvarSidsAdmin() {
  const conexoes = [...document.querySelectorAll('#contrato-conector-sids .sid-admin')].map(l => {
    const v = n => l.querySelector(`[name="${n}"]`).value.trim();
    return { sid: v('sid'), descricao: v('descricao'), url: v('url'), mandante: v('mandante'), idioma: v('idioma') };
  }).filter(c => c.sid || c.url);
  if (await acaoContrato('/conexoes', 'PUT', { conexoes })) { alert('Sistemas SAP salvos.'); recarregarContrato(); }
}

async function ocuparVagaAdmin(vagaId, gestor) {
  let corpo;
  if (gestor) {
    if (!confirm('O gestor do contrato ocupa esta vaga?')) return;
    corpo = { eu: true };
  } else {
    const email = prompt('E-mail da pessoa que vai ocupar a vaga:');
    if (!email) return;
    const nome = prompt('Nome da pessoa (se ela ainda não tiver acesso ao portal):') || '';
    corpo = { email: email.trim(), nome: nome.trim() };
  }
  const r = await acaoContrato(`/vagas/${vagaId}/ocupar`, 'POST', corpo);
  if (r) { alert(r.mensagem); recarregarContrato(); }
}

async function liberarVagaAdmin(vagaId) {
  if (!confirm('Liberar esta vaga? A pessoa perde o acesso aos cursos dela.')) return;
  if (await acaoContrato(`/vagas/${vagaId}/liberar`)) recarregarContrato();
}

async function removerVagaAdmin(vagaId, perfil) {
  const k = _contratoAberto;
  const efeito = cobrancaAtiva(k) && k.preco
    ? `\nA próxima anuidade passa de ${formatMoeda(k.cobranca.valor)} para ${formatMoeda(Math.max(0, k.cobranca.valor - k.preco.precos[perfil] * 12))} (sem estorno do que já foi pago).`
    : '';
  if (!confirm(`Remover esta licença livre do contrato?${efeito}`)) return;
  if (await acaoContrato(`/vagas/${vagaId}`, 'DELETE')) recarregarContrato();
}

async function conviteVagaAdmin(vagaId) {
  const r = await acaoContrato(`/vagas/${vagaId}/convite`);
  if (r) alert(r.mensagem);
}

async function reenviarConviteGestor() {
  const r = await acaoContrato('/gestor/convite');
  if (r) alert(r.mensagem);
}

document.addEventListener('DOMContentLoaded', () => {
  const sub = (id, fn) => document.getElementById(id).addEventListener('submit', e => { e.preventDefault(); fn(e.target); });
  sub('form-novo-contrato-conector', salvarNovoContratoConector);
  sub('form-contrato-conector', async f => {
    const r = await acaoContrato('', 'PUT', {
      status: f.status.value, data_inicio: f.data_inicio.value, data_fim: f.data_fim.value,
      max_sids: f.max_sids.value, observacoes: f.observacoes.value });
    if (r) { alert(r.mensagem); recarregarContrato(); }
  });
  sub('form-contrato-mais-vagas', acrescentarLicencas);
  sub('form-contrato-precos', salvarPrecosContrato);
  sub('form-beneficios', salvarBeneficiosConector);
  // Contratos e benefícios do Conector são dos administradores: técnico não vê os itens
  if (!usuario || !['admin_empresa', 'admin_sistema'].includes(usuario.tipo)) {
    for (const p of ['contratos-conector', 'beneficios-conector']) {
      const l = document.querySelector(`.nav-link[data-page="${p}"]`);
      if (l) l.hidden = true;
    }
  }
});

// ===== Benefícios do Conector: cursos x perfis (Cadastros) =====
let _beneficios = null;
async function loadBeneficiosConector() {
  const corpo = document.getElementById('beneficios-corpo');
  const res = await apiFetch(`${API_URL}/treinamentos/beneficios`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { corpo.innerHTML = `<tr><td class="text-center">${escapeHtml(d.erro)}</td></tr>`; return; }
  _beneficios = d;
  const marcado = new Set(d.marcados.map(m => `${m.perfil}|${m.curso_id}`));
  document.getElementById('beneficios-cabecalho').innerHTML =
    `<tr><th>Curso</th>${d.perfis.map(p => `<th style="text-align:center">${escapeHtml(p.nome)}</th>`).join('')}</tr>`;
  corpo.innerHTML = d.cursos.length ? d.cursos.map(c => `
    <tr>
      <td data-label="Curso"><strong>${escapeHtml(c.titulo)}</strong>${c.status !== 'publicado' ? ' <span class="fin-muted">(rascunho: ainda não aparece)</span>' : ''}</td>
      ${d.perfis.map(p => `<td data-label="${escapeHtml(p.nome)}" style="text-align:center">
        <input type="checkbox" aria-label="${escapeHtml(c.titulo)} no perfil ${escapeHtml(p.nome)}" data-perfil="${p.id}" data-curso="${c.id}"
          ${marcado.has(`${p.id}|${c.id}`) ? 'checked' : ''}></td>`).join('')}
    </tr>`).join('') : `<tr><td colspan="${d.perfis.length + 1}" class="text-center">Nenhum curso cadastrado.</td></tr>`;
}

async function salvarBeneficiosConector() {
  const itens = [...document.querySelectorAll('#beneficios-corpo input[type="checkbox"]:checked')]
    .map(i => ({ perfil: i.dataset.perfil, curso_id: Number(i.dataset.curso) }));
  const res = await apiFetch(`${API_URL}/treinamentos/beneficios`, { method: 'PUT', body: JSON.stringify({ itens }) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (res.ok) loadBeneficiosConector();
}
