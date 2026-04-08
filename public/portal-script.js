// ===== AUTH =====
const token = localStorage.getItem('token');
const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');

// Segurança: só cliente acessa o portal
if (!token || !usuario) {
  window.location.href = '/login.html';
} else if (usuario.tipo !== 'cliente') {
  window.location.href = '/dashboard.html';
}

// ===== CONFIG =====
const API = '/api';
let todosOsChamados = [];
let filtroAtivo = '';

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  // Preencher info do usuário no header
  document.getElementById('header-usuario').textContent = usuario.nome;
  document.getElementById('header-empresa').textContent = usuario.empresa_nome || 'Portal do Cliente';
  document.getElementById('welcome-nome').textContent = `Olá, ${usuario.nome.split(' ')[0]}!`;
  document.getElementById('welcome-empresa').textContent = 'Acompanhe seus chamados e abra novas solicitações';

  carregarPortal();
});

// ===== API HELPER =====
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
    window.location.href = '/login.html';
    return null;
  }

  return res;
}

function sair() {
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  window.location.href = '/login.html';
}

// ===== CARREGAR PORTAL =====
async function carregarPortal() {
  await Promise.all([
    carregarChamados(),
    carregarTecnologias()
  ]);
}

async function carregarChamados() {
  const res = await apiFetch(`${API}/chamados`);
  if (!res) return;

  const chamados = await res.json();
  todosOsChamados = Array.isArray(chamados) ? chamados : [];

  atualizarStats();
  renderChamados(todosOsChamados);
}

async function carregarTecnologias() {
  const res = await apiFetch(`${API}/tecnologias`);
  if (!res) return;

  const lista = await res.json();
  const sel = document.getElementById('select-tecnologia-portal');
  if (sel && Array.isArray(lista)) {
    lista.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.nome}${t.categoria ? ' (' + t.categoria + ')' : ''}`;
      sel.appendChild(opt);
    });
  }
}

// ===== STATS =====
function atualizarStats() {
  const abertos = todosOsChamados.filter(c => c.status === 'aberto').length;
  const andamento = todosOsChamados.filter(c => c.status === 'em_andamento' || c.status === 'aguardando_cliente').length;
  const resolvidos = todosOsChamados.filter(c => c.status === 'resolvido' || c.status === 'fechado').length;

  document.getElementById('stat-abertos').textContent = abertos;
  document.getElementById('stat-andamento').textContent = andamento;
  document.getElementById('stat-resolvidos').textContent = resolvidos;
  document.getElementById('stat-total').textContent = todosOsChamados.length;
}

// ===== RENDER CHAMADOS =====
function filtrarChamados(btn, status) {
  document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filtroAtivo = status;

  const filtrados = status
    ? todosOsChamados.filter(c => c.status === status)
    : todosOsChamados;

  renderChamados(filtrados);
}

function renderChamados(lista) {
  const container = document.getElementById('lista-chamados');

  if (!lista.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🎫</div>
        <p>Nenhum chamado encontrado.</p>
      </div>`;
    return;
  }

  container.innerHTML = lista.map(ch => `
    <div class="chamado-card" onclick="abrirDetalhe(${ch.id})">
      <div class="chamado-id">#${ch.id}</div>
      <div class="chamado-body">
        <div class="chamado-titulo">${ch.titulo}</div>
        <div class="chamado-meta">
          ${ch.tecnologia_nome ? `<span>💻 ${ch.tecnologia_nome}</span>` : ''}
          <span>📅 ${formatData(ch.data_criacao)}</span>
          ${ch.total_atendimentos > 0 ? `<span>💬 ${ch.total_atendimentos} resposta(s)</span>` : ''}
        </div>
      </div>
      <div class="chamado-badges">
        ${badgeStatus(ch.status)}
        ${badgePrioridade(ch.prioridade)}
      </div>
    </div>
  `).join('');
}

// ===== DETALHE DO CHAMADO =====
async function abrirDetalhe(id) {
  const res = await apiFetch(`${API}/chamados/${id}`);
  if (!res) return;
  const ch = await res.json();

  document.getElementById('detalhe-titulo').textContent = `Chamado #${ch.id}`;
  document.getElementById('comentario-chamado-id').value = ch.id;

  // Info grid
  document.getElementById('detalhe-info').innerHTML = `
    <div><strong>Status</strong>${badgeStatus(ch.status)}</div>
    <div><strong>Prioridade</strong>${badgePrioridade(ch.prioridade)}</div>
    <div><strong>Tecnologia</strong>${ch.tecnologia_nome || 'Geral'}</div>
    <div><strong>Aberto em</strong>${formatDataHora(ch.data_abertura)}</div>
    ${ch.categoria ? `<div><strong>Categoria</strong>${ch.categoria}</div>` : ''}
    ${ch.data_fechamento ? `<div><strong>Fechado em</strong>${formatDataHora(ch.data_fechamento)}</div>` : ''}
    <div style="grid-column:1/-1"><strong>Descrição</strong>${ch.descricao || '—'}</div>
  `;

  // Timeline
  renderTimeline(ch.atendimentos || []);

  // Ocultar form de comentário se chamado fechado/resolvido
  const wrapper = document.getElementById('form-comentario-wrapper');
  wrapper.style.display = (ch.status === 'fechado' || ch.status === 'resolvido') ? 'none' : 'block';
  document.querySelector('#form-comentario textarea').value = '';

  abrirModal('modal-detalhe');
}

function renderTimeline(atendimentos) {
  const container = document.getElementById('detalhe-timeline');

  if (!atendimentos.length) {
    container.innerHTML = '<p style="color:#94a3b8; font-size:0.85rem; padding:0.5rem 0">Nenhum atendimento registrado ainda.</p>';
    return;
  }

  const cores = {
    comentario: '#64748b',
    contato_cliente: '#0d6efd',
    escalamento: '#f59e0b',
    solucao: '#10b981'
  };

  const labels = {
    comentario: 'Comentário',
    contato_cliente: 'Retorno da equipe',
    escalamento: 'Escalamento',
    solucao: 'Solução'
  };

  container.innerHTML = atendimentos.map(a => `
    <div class="tl-item">
      <div class="tl-dot" style="background:${cores[a.tipo] || '#64748b'}"></div>
      <div class="tl-content">
        <div class="tl-meta">
          <strong style="color:${cores[a.tipo] || '#64748b'}">${labels[a.tipo] || a.tipo}</strong>
          · ${a.usuario_nome || 'Suporte'} · ${formatDataHora(a.data_atendimento)}
        </div>
        <div>${a.descricao}</div>
      </div>
    </div>
  `).join('');
}

async function enviarComentario(e) {
  e.preventDefault();
  const form = e.target;
  const chamado_id = document.getElementById('comentario-chamado-id').value;
  const descricao = form.querySelector('textarea[name="descricao"]').value.trim();

  if (!descricao) return;

  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  const res = await apiFetch(`${API}/atendimentos`, {
    method: 'POST',
    body: JSON.stringify({ chamado_id: parseInt(chamado_id), tipo: 'comentario', descricao })
  });

  btn.disabled = false;
  btn.textContent = 'Enviar comentário';

  if (!res || !res.ok) {
    alert('Erro ao enviar comentário. Tente novamente.');
    return;
  }

  // Recarregar detalhe
  await abrirDetalhe(parseInt(chamado_id));
}

// ===== NOVO CHAMADO =====
function abrirModalNovoChamado() {
  document.getElementById('form-novo-chamado').reset();
  abrirModal('modal-novo-chamado');
}

async function salvarNovoChamado(e) {
  e.preventDefault();
  const form = e.target;

  const dados = {
    titulo: form.titulo.value,
    descricao: form.descricao.value,
    prioridade: form.prioridade.value,
    tecnologia_id: form.tecnologia_id.value || null,
    // cliente_id é inserido automaticamente pelo backend via usuario.cliente_id
  };

  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Abrindo chamado...';

  const res = await apiFetch(`${API}/chamados`, {
    method: 'POST',
    body: JSON.stringify(dados)
  });

  btn.disabled = false;
  btn.textContent = 'Abrir Chamado';

  if (!res || !res.ok) {
    const err = res ? await res.json() : {};
    alert(err.erro || 'Erro ao abrir chamado. Tente novamente.');
    return;
  }

  fecharModal('modal-novo-chamado');
  await carregarChamados();
}

// ===== MODAL HELPERS =====
function abrirModal(id) {
  document.getElementById(id).classList.add('show');
}

function fecharModal(id) {
  document.getElementById(id).classList.remove('show');
}

// Fechar clicando fora
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target === m) m.classList.remove('show');
  });
});

// ===== FORMATTERS =====
function formatData(val) {
  if (!val) return '-';
  return new Date(val).toLocaleDateString('pt-BR');
}

function formatDataHora(val) {
  if (!val) return '-';
  return new Date(val).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function badgeStatus(status) {
  const map = {
    aberto:            { label: 'Aberto',            color: '#0d6efd' },
    em_andamento:      { label: 'Em andamento',      color: '#f59e0b' },
    aguardando_cliente:{ label: 'Aguardando retorno', color: '#8b5cf6' },
    resolvido:         { label: 'Resolvido',          color: '#10b981' },
    fechado:           { label: 'Fechado',            color: '#64748b' }
  };
  const s = map[status] || { label: status, color: '#64748b' };
  return `<span class="badge" style="background:${s.color}20;color:${s.color}">${s.label}</span>`;
}

function badgePrioridade(p) {
  const map = {
    critica: { label: 'Crítica', color: '#ef4444' },
    alta:    { label: 'Alta',    color: '#f97316' },
    media:   { label: 'Média',   color: '#f59e0b' },
    baixa:   { label: 'Baixa',   color: '#10b981' }
  };
  const s = map[p] || { label: p, color: '#64748b' };
  return `<span class="badge" style="background:${s.color}20;color:${s.color}">${s.label}</span>`;
}
