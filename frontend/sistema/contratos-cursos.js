// ===== Contrato de cursos POR PESSOAS (+ Novo contrato → Cursos) =====
// Regras no backend (services/contratos-cursos.js): o contrato tem os cursos e N vagas; só quem ocupa uma vaga vê os cursos.
// Cobrança cortesia (sem fatura), pagamento único (fatura avulsa em rascunho), mensal ou anual (contrato financeiro).
let _contratoCursosAberto = null;

const somaMesesIso = (meses) => {
  const d = new Date();
  d.setMonth(d.getMonth() + meses);
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
};

// Lista de cursos com caixa de seleção; rascunho aparece avisado (só abre no portal depois de publicado)
async function preencherCursosContrato(marcados = []) {
  const box = document.getElementById('cc-cursos');
  box.textContent = 'Carregando…';
  const res = await apiFetch(`${API_URL}/treinamentos/cursos`);
  if (!res || !res.ok) { box.textContent = 'Não foi possível carregar os cursos.'; return; }
  const cursos = await res.json();
  box.innerHTML = cursos.length ? cursos.map(c => `
    <label class="check-linha"><input type="checkbox" name="curso" value="${c.id}" ${marcados.includes(c.id) ? 'checked' : ''}>
      ${escapeHtml(c.titulo)}${c.status !== 'publicado' ? ' <span class="fin-muted">(rascunho: aparece no portal quando for publicado)</span>' : ''}</label>`).join('')
    : '<p class="fin-muted">Nenhum curso cadastrado ainda. Crie em Produtos SAP → Treinamentos.</p>';
}

function ajustarFormCursos() {
  const f = document.getElementById('form-contrato-cursos');
  const cob = f.cobranca.value;
  document.getElementById('cc-valor-grupo').style.display = cob === 'cortesia' ? 'none' : '';
  document.getElementById('cc-dia-grupo').style.display = cob === 'mensal' || cob === 'anual' ? '' : 'none';
  document.getElementById('cc-valor-rotulo').textContent = { unica: 'Valor total (R$)', mensal: 'Valor mensal (R$)', anual: 'Valor anual (R$)' }[cob] || 'Valor (R$)';
  document.getElementById('cc-cobranca-nota').textContent = {
    cortesia: 'Sem fatura: os cursos ficam liberados de graça até a validade.',
    unica: 'Sai uma fatura avulsa em rascunho no Faturamento; aprove para emitir a nota e enviar ao cliente.',
    mensal: 'Vira um contrato financeiro mensal: uma fatura por mês enquanto o contrato estiver ativo.',
    anual: 'Vira um contrato financeiro anual: uma fatura por ano, no mês do início.'
  }[cob];
}

// Quem já é gestor da empresa escolhida (no contrato novo: decide se precisa informar um)
async function mostrarGestoresCursos() {
  const f = document.getElementById('form-contrato-cursos');
  const nota = document.getElementById('cc-gestores-nota');
  nota.textContent = '';
  if (_contratoCursosAberto || !f.cliente_id.value) return;
  const res = await apiFetch(`${API_URL}/contratos-conector/clientes/${f.cliente_id.value}/admins`);
  if (!res || !res.ok) return;
  const admins = await res.json();
  nota.textContent = admins.length
    ? `Gestor da empresa no portal: ${admins.map(a => a.nome).join(', ')} (já pode distribuir as vagas).`
    : 'Esta empresa ainda não tem gestor no portal: informe um abaixo ou preencha as vagas você mesmo.';
}

// "Nome; e-mail" ou só "e-mail", uma pessoa por linha
function lerPessoasTexto(texto) {
  return String(texto || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const partes = l.split(/[;,\t]/).map(s => s.trim()).filter(Boolean);
    const email = partes.find(p => p.includes('@')) || '';
    const nome = partes.find(p => !p.includes('@')) || '';
    return { nome, email };
  });
}

async function abrirNovoContratoCursos(clienteId) {
  _contratoCursosAberto = null;
  const f = document.getElementById('form-contrato-cursos');
  f.reset();
  await preencherClientesSelect(f.cliente_id, clienteId);
  f.cliente_id.disabled = false;
  ['data_inicio', 'cobranca', 'valor', 'dia_vencimento'].forEach(n => { f[n].disabled = false; });
  f.data_inicio.value = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  f.data_fim.value = somaMesesIso(12);
  f.cobranca.value = 'cortesia';
  f.dia_vencimento.value = 10;
  f.vagas.value = 1;
  document.getElementById('cc-vagas-nota').textContent = 'Quantas pessoas podem fazer os cursos ao mesmo tempo.';
  document.getElementById('cc-novo-pessoas').style.display = '';
  document.getElementById('cc-vagas-box').style.display = 'none';
  await preencherCursosContrato();
  ajustarFormCursos();
  mostrarGestoresCursos();
  document.getElementById('contrato-cursos-titulo').textContent = 'Novo contrato de cursos';
  document.getElementById('cc-btn-salvar').textContent = 'Criar contrato';
  document.getElementById('cc-btn-salvar').style.display = '';
  document.getElementById('cc-btn-encerrar').style.display = 'none';
  showModal('#modal-contrato-cursos');
}

async function abrirContratoCursos(id, manterAberto) {
  const res = await apiFetch(`${API_URL}/contratos-cursos/${id}`);
  if (!res) return;
  const k = await res.json();
  if (!res.ok) { alert(k.erro); return; }
  _contratoCursosAberto = k;
  const f = document.getElementById('form-contrato-cursos');
  f.reset();
  await preencherClientesSelect(f.cliente_id, k.cliente_id);
  f.cliente_id.disabled = true;
  f.data_inicio.value = k.data_inicio;
  f.data_fim.value = k.data_fim || '';
  f.cobranca.value = k.cobranca;
  f.valor.value = k.valor || '';
  f.observacoes.value = k.observacoes || '';
  f.vagas.value = k.total_vagas;
  // Cobrança não muda depois de criada (o financeiro já foi gerado); validade, cursos, vagas e observações mudam
  ['data_inicio', 'cobranca', 'valor', 'dia_vencimento'].forEach(n => { f[n].disabled = true; });
  await preencherCursosContrato(k.cursos.map(c => c.id));
  ajustarFormCursos();
  const ativo = k.status === 'ativo';
  document.getElementById('cc-gestores-nota').textContent = k.gestores && k.gestores.length
    ? `Gestor da empresa no portal: ${k.gestores.map(a => a.nome).join(', ')} (também distribui as vagas).`
    : 'Esta empresa não tem gestor no portal: só você preenche as vagas (adicione um na ficha do cliente).';
  document.getElementById('cc-vagas-nota').textContent = `${k.ocupadas} de ${k.total_vagas} ocupada(s). Aumentar acrescenta vagas livres; diminuir só tira vagas livres.`;
  document.getElementById('cc-novo-pessoas').style.display = 'none';
  document.getElementById('cc-vagas-box').style.display = '';
  document.getElementById('cc-vagas-tbody').innerHTML = k.vagas.length ? k.vagas.map(v => {
    const pct = v.aulas_total ? Math.round(100 * v.aulas_concluidas / v.aulas_total) : 0;
    const pessoa = v.usuario_id
      ? `<strong>${escapeHtml(v.usuario_nome)}</strong>${v.estado === 'convidada' ? ' <span style="color:#b7791f">(convite pendente)</span>' : ''}<small class="fin-muted" style="display:block">${escapeHtml(v.usuario_email)}</small>`
      : '<span class="fin-muted">Livre</span>';
    const acoes = !ativo ? '' : v.usuario_id
      ? `${v.estado === 'convidada' ? `<button type="button" class="btn btn-secondary btn-sm" onclick="conviteVagaCursos(${v.id})">Reenviar convite</button>` : ''}
         <button type="button" class="btn btn-secondary btn-sm" onclick="liberarVagaCursos(${v.id})">Liberar</button>`
      : `<button type="button" class="btn btn-secondary btn-sm" onclick="ocuparVagaCursos(${v.id})">Passar para alguém</button>`;
    return `<tr><td data-label="Pessoa">${pessoa}</td>
      <td data-label="Progresso">${v.usuario_id ? `${v.aulas_concluidas} de ${v.aulas_total} aulas (${pct}%)` : '—'}</td>
      <td data-label="Ações" class="td-acoes">${acoes}</td></tr>`;
  }).join('') : '<tr><td colspan="3" class="text-center">Nenhuma vaga.</td></tr>';
  document.getElementById('contrato-cursos-titulo').textContent = `Contrato de cursos nº ${k.id} — ${k.cliente_nome}${ativo ? '' : ' (encerrado)'}`;
  document.getElementById('cc-btn-salvar').textContent = 'Salvar';
  document.getElementById('cc-btn-salvar').style.display = ativo ? '' : 'none';
  document.getElementById('cc-btn-encerrar').style.display = ativo ? '' : 'none';
  if (!manterAberto) showModal('#modal-contrato-cursos');
}

async function acaoContratoCursos(caminho, corpo) {
  const res = await apiFetch(`${API_URL}/contratos-cursos/${_contratoCursosAberto.id}${caminho}`, { method: 'POST', body: corpo ? JSON.stringify(corpo) : undefined });
  if (!res) return null;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return null; }
  return r;
}

async function ocuparVagaCursos(vagaId) {
  const email = prompt('E-mail da pessoa que vai fazer os cursos:');
  if (!email) return;
  const nome = prompt('Nome da pessoa (se ela ainda não tiver acesso ao portal):') || '';
  const r = await acaoContratoCursos('/convidar', { vaga_id: vagaId, email: email.trim(), nome: nome.trim() });
  if (r) { alert(r.mensagem); abrirContratoCursos(_contratoCursosAberto.id, true); }
}

async function liberarVagaCursos(vagaId) {
  if (!confirm('Liberar esta vaga? A pessoa perde os cursos deste contrato (o progresso fica guardado).')) return;
  if (await acaoContratoCursos(`/vagas/${vagaId}/liberar`)) abrirContratoCursos(_contratoCursosAberto.id, true);
}

async function conviteVagaCursos(vagaId) {
  const r = await acaoContratoCursos(`/vagas/${vagaId}/convite`);
  if (r) alert(r.mensagem);
}

async function salvarContratoCursos() {
  const f = document.getElementById('form-contrato-cursos');
  const curso_ids = [...f.querySelectorAll('input[name="curso"]:checked')].map(i => Number(i.value));
  if (!curso_ids.length) { alert('Escolha ao menos um curso.'); return; }
  const k = _contratoCursosAberto;
  let corpo;
  if (k) {
    corpo = { curso_ids, vagas: f.vagas.value, data_fim: f.data_fim.value || null, observacoes: f.observacoes.value };
  } else {
    const pessoas = lerPessoasTexto(f.pessoas.value);
    const semEmail = pessoas.filter(p => !p.email);
    if (semEmail.length) { alert(`Falta o e-mail em: ${semEmail.map(p => p.nome).join(', ')}`); return; }
    if (pessoas.length > Number(f.vagas.value)) f.vagas.value = pessoas.length;
    corpo = { cliente_id: f.cliente_id.value, curso_ids, vagas: f.vagas.value, pessoas,
      gestor: f.gestor_email.value.trim() ? { nome: f.gestor_nome.value.trim(), email: f.gestor_email.value.trim() } : null,
      data_inicio: f.data_inicio.value, data_fim: f.data_fim.value || null,
      cobranca: f.cobranca.value, valor: f.valor.value, dia_vencimento: f.dia_vencimento.value, observacoes: f.observacoes.value };
  }
  const res = await apiFetch(`${API_URL}/contratos-cursos${k ? `/${k.id}` : ''}`, { method: k ? 'PUT' : 'POST', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  if (k) abrirContratoCursos(k.id, true);
  else closeModal(document.getElementById('modal-contrato-cursos'));
  if (document.getElementById('contratos-page').classList.contains('active')) loadContratos();
}

async function encerrarContratoCursos() {
  const k = _contratoCursosAberto;
  if (!k || !confirm('Encerrar este contrato? As pessoas das vagas perdem estes cursos agora e a cobrança recorrente para. O progresso fica guardado.')) return;
  const res = await apiFetch(`${API_URL}/contratos-cursos/${k.id}/encerrar`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  closeModal(document.getElementById('modal-contrato-cursos'));
  if (document.getElementById('contratos-page').classList.contains('active')) loadContratos();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('form-contrato-cursos').addEventListener('submit', e => { e.preventDefault(); salvarContratoCursos(); });
});
