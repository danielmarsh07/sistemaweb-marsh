// ===== Contrato de cursos para a empresa (+ Novo contrato → Cursos) =====
// Regras no backend (routes/contratos-cursos.js): os cursos escolhidos valem para todos do cliente até a validade;
// cobrança cortesia (sem fatura), pagamento único (fatura avulsa em rascunho), mensal ou anual (contrato financeiro).
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
  await preencherCursosContrato();
  ajustarFormCursos();
  document.getElementById('contrato-cursos-titulo').textContent = 'Novo contrato: cursos para a empresa';
  document.getElementById('cc-btn-salvar').textContent = 'Liberar cursos';
  document.getElementById('cc-btn-encerrar').style.display = 'none';
  showModal('#modal-contrato-cursos');
}

async function abrirContratoCursos(id) {
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
  // Cobrança não muda depois de criada (o financeiro já foi gerado); validade, cursos e observações mudam
  ['data_inicio', 'cobranca', 'valor', 'dia_vencimento'].forEach(n => { f[n].disabled = true; });
  await preencherCursosContrato(k.cursos.map(c => c.id));
  ajustarFormCursos();
  const ativo = k.status === 'ativo';
  document.getElementById('contrato-cursos-titulo').textContent = `Cursos para a empresa nº ${k.id} — ${k.cliente_nome}${ativo ? '' : ' (encerrado)'}`;
  document.getElementById('cc-btn-salvar').textContent = 'Salvar';
  document.getElementById('cc-btn-salvar').style.display = ativo ? '' : 'none';
  document.getElementById('cc-btn-encerrar').style.display = ativo ? '' : 'none';
  showModal('#modal-contrato-cursos');
}

async function salvarContratoCursos() {
  const f = document.getElementById('form-contrato-cursos');
  const curso_ids = [...f.querySelectorAll('input[name="curso"]:checked')].map(i => Number(i.value));
  if (!curso_ids.length) { alert('Escolha ao menos um curso.'); return; }
  const k = _contratoCursosAberto;
  const corpo = k
    ? { curso_ids, data_fim: f.data_fim.value || null, observacoes: f.observacoes.value }
    : { cliente_id: f.cliente_id.value, curso_ids, data_inicio: f.data_inicio.value, data_fim: f.data_fim.value || null,
        cobranca: f.cobranca.value, valor: f.valor.value, dia_vencimento: f.dia_vencimento.value, observacoes: f.observacoes.value };
  const res = await apiFetch(`${API_URL}/contratos-cursos${k ? `/${k.id}` : ''}`, { method: k ? 'PUT' : 'POST', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  closeModal(document.getElementById('modal-contrato-cursos'));
  if (document.getElementById('contratos-page').classList.contains('active')) loadContratos();
}

async function encerrarContratoCursos() {
  const k = _contratoCursosAberto;
  if (!k || !confirm('Encerrar este contrato? Os cursos saem da empresa agora e a cobrança recorrente para. O progresso das pessoas fica guardado.')) return;
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
