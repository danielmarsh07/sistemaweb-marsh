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

async function abrirNovoContratoConector() {
  resetForm('#form-novo-contrato-conector');
  const f = document.getElementById('form-novo-contrato-conector');
  const umAno = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  f.data_fim.value = umAno;
  f.max_sids.value = 3;
  ['abap', 'funcional', 'ambos'].forEach(p => { f[p].value = 0; });
  await preencherClientesSelect(f.cliente_id);
  showModal('#modal-novo-contrato-conector');
}

async function salvarNovoContratoConector() {
  const f = document.getElementById('form-novo-contrato-conector');
  const corpo = {
    cliente_id: f.cliente_id.value, gestor_nome: f.gestor_nome.value, gestor_email: f.gestor_email.value,
    vagas: { abap: f.abap.value, funcional: f.funcional.value, ambos: f.ambos.value },
    data_inicio: f.data_inicio.value || undefined, data_fim: f.data_fim.value, max_sids: f.max_sids.value,
    observacoes: f.observacoes.value
  };
  const res = await apiFetch(`${API_URL}/contratos-conector`, { method: 'POST', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  closeModal(document.getElementById('modal-novo-contrato-conector'));
  loadContratosConector();
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
  const f = document.getElementById('form-contrato-conector');
  f.status.value = k.status;
  f.data_inicio.value = k.data_inicio;
  f.data_fim.value = k.data_fim;
  f.max_sids.value = k.max_sids;
  f.observacoes.value = k.observacoes || '';
  document.getElementById('form-contrato-mais-vagas').reset();

  document.getElementById('contrato-conector-vagas').innerHTML = k.vagas.length ? k.vagas.map(v => {
    const pct = v.aulas_total ? Math.round(100 * v.aulas_concluidas / v.aulas_total) : 0;
    const pessoa = v.usuario_id
      ? `<strong>${escapeHtml(v.usuario_nome)}</strong>${v.eh_gestor ? ' (gestor)' : ''}<small class="fin-muted" style="display:block">${escapeHtml(v.usuario_email)}</small>`
      : '<span class="fin-muted">Livre</span>';
    const acoes = v.usuario_id
      ? `${v.eh_gestor ? '' : `<button class="btn btn-secondary btn-sm" onclick="conviteVagaAdmin(${v.id})">Reenviar convite</button>`}
         <button class="btn btn-secondary btn-sm" onclick="liberarVagaAdmin(${v.id})">Liberar</button>`
      : `<button class="btn btn-secondary btn-sm" onclick="ocuparVagaAdmin(${v.id})">Passar para alguém</button>
         <button class="btn btn-secondary btn-sm" onclick="ocuparVagaAdmin(${v.id}, true)">Gestor ocupa</button>
         <button class="btn btn-icon btn-danger" title="Remover vaga livre" aria-label="Remover vaga livre" onclick="removerVagaAdmin(${v.id})">${iconSVG('trash')}</button>`;
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
  if (!manterAberto) showModal('#modal-contrato-conector');
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

async function removerVagaAdmin(vagaId) {
  if (!confirm('Remover esta vaga do contrato?')) return;
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
  sub('form-contrato-mais-vagas', async f => {
    const r = await acaoContrato('/vagas', 'POST', { abap: f.abap.value, funcional: f.funcional.value, ambos: f.ambos.value });
    if (r) { alert(r.mensagem); recarregarContrato(); }
  });
  // Contratos do Conector são dos administradores: técnico não vê o item
  if (!usuario || !['admin_empresa', 'admin_sistema'].includes(usuario.tipo)) {
    const l = document.querySelector('.nav-link[data-page="contratos-conector"]');
    if (l) l.hidden = true;
  }
});
