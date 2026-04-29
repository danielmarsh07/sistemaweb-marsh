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

  inicializarDropzone();
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
  const res = await apiFetch(`${API}/chamados?limit=200`);
  if (!res) return;

  const data = await res.json();
  // API agora retorna { chamados, paginacao }; mantém compat com array antigo
  todosOsChamados = Array.isArray(data) ? data : (data.chamados || []);

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

  container.innerHTML = lista.map(ch => {
    const naoLidos = parseInt(ch.atendimentos_nao_lidos) || 0;
    return `
    <div class="chamado-card${naoLidos > 0 ? ' has-novidade' : ''}" onclick="abrirDetalhe(${ch.id})">
      <div class="chamado-id">#${ch.id}</div>
      <div class="chamado-body">
        <div class="chamado-titulo">
          ${ch.titulo}
          ${naoLidos > 0 ? `<span class="badge-novo" title="${naoLidos} novo(s) comentário(s)">${naoLidos} novo${naoLidos > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="chamado-meta">
          ${ch.tecnologia_nome ? `<span>💻 ${ch.tecnologia_nome}</span>` : ''}
          <span>📅 ${formatData(ch.data_criacao)}</span>
          ${ch.total_atendimentos > 0 ? `<span>💬 ${ch.total_atendimentos} resposta(s)</span>` : ''}
          ${badgeSla(ch.sla)}
          ${ch.avaliacao_nota ? `<span title="Sua avaliação">${'⭐'.repeat(ch.avaliacao_nota)}</span>` : ''}
        </div>
      </div>
      <div class="chamado-badges">
        ${badgeStatus(ch.status)}
        ${badgePrioridade(ch.prioridade)}
      </div>
    </div>
  `;
  }).join('');
}

function badgeSla(sla) {
  if (!sla || sla.sla_status === 'concluido') return '';
  if (sla.sla_status === 'estourado') {
    return `<span class="sla-pill sla-estourado" title="SLA estourado">⏱ SLA estourado</span>`;
  }
  if (sla.sla_status === 'alerta') {
    const h = Math.max(0, Math.floor(sla.restante_minutos / 60));
    const m = Math.max(0, sla.restante_minutos % 60);
    return `<span class="sla-pill sla-alerta" title="Pouco tempo restante">⏱ ${h}h${m}m restantes</span>`;
  }
  return '';
}

// ===== DETALHE DO CHAMADO =====
async function abrirDetalhe(id) {
  const res = await apiFetch(`${API}/chamados/${id}`);
  if (!res) return;
  const ch = await res.json();

  document.getElementById('detalhe-titulo').textContent = `Chamado #${ch.id}`;
  document.getElementById('comentario-chamado-id').value = ch.id;

  const concluido = ch.status === 'fechado' || ch.status === 'resolvido';

  // Info grid
  document.getElementById('detalhe-info').innerHTML = `
    <div><strong>Status</strong>${badgeStatus(ch.status)}</div>
    <div><strong>Prioridade</strong>${badgePrioridade(ch.prioridade)}</div>
    <div><strong>Tecnologia</strong>${ch.tecnologia_nome || 'Geral'}</div>
    <div><strong>Aberto em</strong>${formatDataHora(ch.data_abertura)}</div>
    ${ch.sla && ch.sla.sla_status !== 'concluido' ? `<div><strong>SLA</strong>${badgeSlaDetalhe(ch.sla)}</div>` : ''}
    ${ch.categoria ? `<div><strong>Categoria</strong>${ch.categoria}</div>` : ''}
    ${ch.data_fechamento ? `<div><strong>Fechado em</strong>${formatDataHora(ch.data_fechamento)}</div>` : ''}
    <div style="grid-column:1/-1"><strong>Descrição</strong>${ch.descricao || '—'}</div>
  `;

  // Timeline
  renderTimeline(ch.atendimentos || []);

  // Anexos
  renderAnexos(ch);

  // Bloco de ações pós-fechamento (reabrir + CSAT)
  renderBlocoConcluido(ch, concluido);

  // Form de comentário só em chamados ativos
  const wrapper = document.getElementById('form-comentario-wrapper');
  wrapper.style.display = concluido ? 'none' : 'block';
  document.querySelector('#form-comentario textarea').value = '';

  abrirModal('modal-detalhe');

  // Marcar atendimentos como lidos (não bloqueia a UI)
  apiFetch(`${API}/chamados/${id}/marcar-lido`, { method: 'POST' }).catch(() => {});
}

function badgeSlaDetalhe(sla) {
  if (!sla) return '';
  if (sla.sla_status === 'estourado') return `<span class="badge" style="background:#ef444420;color:#ef4444">SLA estourado</span>`;
  if (sla.sla_status === 'alerta') {
    const h = Math.max(0, Math.floor(sla.restante_minutos / 60));
    return `<span class="badge" style="background:#f59e0b20;color:#f59e0b">${h}h restantes</span>`;
  }
  const h = Math.max(0, Math.floor(sla.restante_minutos / 60));
  return `<span class="badge" style="background:#10b98120;color:#10b981">${h}h restantes</span>`;
}

function renderAnexos(ch) {
  let wrapper = document.getElementById('bloco-anexos');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'bloco-anexos';
    document.querySelector('#modal-detalhe .modal-body').insertBefore(
      wrapper,
      document.getElementById('form-comentario-wrapper')
    );
  }

  const anexos = ch.anexos || [];
  const concluido = ch.status === 'fechado' || ch.status === 'resolvido';

  wrapper.innerHTML = `
    <div class="bloco-anexos">
      <h4>Anexos ${anexos.length ? `(${anexos.length})` : ''}</h4>
      ${anexos.length ? `
        <ul class="anexos-list">
          ${anexos.map(a => `
            <li class="anexo-item">
              <span class="anexo-nome" title="${a.nome_original}">${iconeAnexo(a.mime_type)} ${a.nome_original}</span>
              <span class="anexo-meta">${formatarTamanho(a.tamanho_bytes)} · ${a.enviado_por_nome || ''}</span>
              <button class="btn-anexo" onclick="baixarAnexoPortal(${ch.id}, ${a.id})">Baixar</button>
            </li>
          `).join('')}
        </ul>
      ` : '<p class="sem-anexos">Nenhum anexo neste chamado.</p>'}
      ${concluido ? '' : `
        <label class="btn-upload">
          + Enviar anexo
          <input type="file" id="upload-anexo-portal" hidden onchange="enviarAnexoPortal(${ch.id}, this)">
        </label>
        <small class="upload-hint">Imagens, PDFs, docs, planilhas, ZIP. Máx 10 MB.</small>
      `}
    </div>
  `;
}

function iconeAnexo(mime) {
  if (!mime) return '📎';
  if (mime.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf') return '📄';
  if (mime.includes('zip')) return '🗜';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  return '📎';
}

function formatarTamanho(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

async function enviarAnexoPortal(chamadoId, input) {
  if (!input.files || !input.files[0]) return;
  const arquivo = input.files[0];
  if (arquivo.size > 10 * 1024 * 1024) {
    alert('Arquivo maior que 10 MB.');
    input.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('arquivo', arquivo);

  const res = await fetch(`${API}/chamados/${chamadoId}/anexos`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });

  input.value = '';
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    alert(e.erro || 'Erro ao enviar anexo.');
    return;
  }
  await abrirDetalhe(chamadoId);
}

async function baixarAnexoPortal(chamadoId, anexoId) {
  const res = await apiFetch(`${API}/chamados/${chamadoId}/anexos/${anexoId}/download`);
  if (!res || !res.ok) { alert('Erro ao baixar anexo.'); return; }
  const data = await res.json();
  window.open(data.url, '_blank');
}

function renderBlocoConcluido(ch, concluido) {
  const wrapper = document.getElementById('bloco-concluido') || (() => {
    const div = document.createElement('div');
    div.id = 'bloco-concluido';
    document.querySelector('#modal-detalhe .modal-body').insertBefore(
      div,
      document.getElementById('form-comentario-wrapper')
    );
    return div;
  })();

  if (!concluido) { wrapper.innerHTML = ''; return; }

  const jaAvaliou = !!ch.avaliacao;
  const nota = jaAvaliou ? ch.avaliacao.nota : 0;

  wrapper.innerHTML = `
    <div class="bloco-concluido">
      <div class="bloco-concluido-acao">
        <p>O problema voltou? Você pode reabrir esse chamado.</p>
        <button class="btn-reabrir" onclick="reabrirChamado(${ch.id})">↻ Reabrir chamado</button>
      </div>
      <div class="bloco-csat">
        <h4>${jaAvaliou ? 'Sua avaliação' : 'Como foi o atendimento?'}</h4>
        <div class="stars-row" id="stars-row" data-nota="${nota}">
          ${[1,2,3,4,5].map(n => `<span class="star ${n <= nota ? 'on' : ''}" data-n="${n}" onclick="${jaAvaliou ? '' : `escolherNota(${n})`}">★</span>`).join('')}
        </div>
        ${jaAvaliou && ch.avaliacao.comentario ? `<p class="csat-comentario">"${ch.avaliacao.comentario}"</p>` : ''}
        ${!jaAvaliou ? `
          <textarea id="csat-comentario" placeholder="Conta pra gente o que achou (opcional)..." rows="2"></textarea>
          <button class="btn-enviar-csat" onclick="enviarAvaliacao(${ch.id})">Enviar avaliação</button>
        ` : ''}
      </div>
    </div>
  `;
}

let notaEscolhida = 0;
function escolherNota(n) {
  notaEscolhida = n;
  document.querySelectorAll('#stars-row .star').forEach((el, i) => {
    el.classList.toggle('on', i < n);
  });
}

async function enviarAvaliacao(chamadoId) {
  if (!notaEscolhida) {
    alert('Selecione uma nota de 1 a 5 estrelas.');
    return;
  }
  const comentario = (document.getElementById('csat-comentario')?.value || '').trim();
  const res = await apiFetch(`${API}/chamados/${chamadoId}/avaliar`, {
    method: 'POST',
    body: JSON.stringify({ nota: notaEscolhida, comentario })
  });
  if (!res || !res.ok) { alert('Erro ao enviar avaliação.'); return; }
  notaEscolhida = 0;
  await abrirDetalhe(chamadoId);
}

async function reabrirChamado(chamadoId) {
  const motivo = prompt('Conta o que ainda não foi resolvido (opcional, mas ajuda muito):');
  if (motivo === null) return; // cancelou
  const res = await apiFetch(`${API}/chamados/${chamadoId}/reabrir`, {
    method: 'POST',
    body: JSON.stringify({ motivo })
  });
  if (!res || !res.ok) {
    const e = res ? await res.json() : {};
    alert(e.erro || 'Erro ao reabrir chamado.');
    return;
  }
  await carregarChamados();
  await abrirDetalhe(chamadoId);
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
let arquivosPendentes = []; // arquivos selecionados antes da criação do chamado

function abrirModalNovoChamado() {
  document.getElementById('form-novo-chamado').reset();
  arquivosPendentes = [];
  renderListaPendentes();
  document.getElementById('upload-progresso').style.display = 'none';
  abrirModal('modal-novo-chamado');
}

function inicializarDropzone() {
  const dropzone = document.getElementById('dropzone-novo');
  const fileInput = document.getElementById('file-input-novo');
  if (!dropzone || !fileInput) return;

  fileInput.addEventListener('change', e => {
    adicionarArquivos(Array.from(e.target.files || []));
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    adicionarArquivos(Array.from(e.dataTransfer.files || []));
  });
}

function adicionarArquivos(arquivos) {
  for (const arq of arquivos) {
    if (arq.size > 10 * 1024 * 1024) {
      alert(`"${arq.name}" tem mais de 10 MB e foi ignorado.`);
      continue;
    }
    arquivosPendentes.push(arq);
  }
  renderListaPendentes();
}

function renderListaPendentes() {
  const ul = document.getElementById('lista-pendentes');
  if (!ul) return;
  ul.innerHTML = arquivosPendentes.map((a, i) => `
    <li>
      <span>${iconeAnexo(a.type)}</span>
      <span class="nome" title="${a.name}">${a.name}</span>
      <span class="tamanho">${formatarTamanho(a.size)}</span>
      <button type="button" class="remover" onclick="removerPendente(${i})" title="Remover">×</button>
    </li>
  `).join('');
}

function removerPendente(i) {
  arquivosPendentes.splice(i, 1);
  renderListaPendentes();
}

async function salvarNovoChamado(e) {
  e.preventDefault();
  const form = e.target;

  const dados = {
    titulo: form.titulo.value,
    descricao: form.descricao.value,
    prioridade: form.prioridade.value,
    tecnologia_id: form.tecnologia_id.value || null,
    categoria: form.categoria ? form.categoria.value : null
    // cliente_id é inserido automaticamente pelo backend via usuario.cliente_id
  };

  const btn = document.getElementById('btn-abrir-chamado');
  btn.disabled = true;
  btn.textContent = 'Abrindo chamado...';

  const res = await apiFetch(`${API}/chamados`, {
    method: 'POST',
    body: JSON.stringify(dados)
  });

  if (!res || !res.ok) {
    btn.disabled = false;
    btn.textContent = 'Abrir Chamado';
    const err = res ? await res.json() : {};
    alert(err.erro || 'Erro ao abrir chamado. Tente novamente.');
    return;
  }

  const { chamado } = await res.json();

  // Upload sequencial dos anexos pendentes
  if (arquivosPendentes.length > 0) {
    const progresso = document.getElementById('upload-progresso');
    const fill = document.getElementById('progress-fill');
    const status = document.getElementById('upload-status');
    progresso.style.display = 'block';

    for (let i = 0; i < arquivosPendentes.length; i++) {
      status.textContent = `Enviando anexo ${i + 1} de ${arquivosPendentes.length}: ${arquivosPendentes[i].name}`;
      const fd = new FormData();
      fd.append('arquivo', arquivosPendentes[i]);
      try {
        const r = await fetch(`${API}/chamados/${chamado.id}/anexos`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          alert(`Falha ao enviar "${arquivosPendentes[i].name}": ${e.erro || 'erro desconhecido'}`);
        }
      } catch (err) {
        alert(`Falha ao enviar "${arquivosPendentes[i].name}": ${err.message}`);
      }
      fill.style.width = `${((i + 1) / arquivosPendentes.length) * 100}%`;
    }
  }

  btn.disabled = false;
  btn.textContent = 'Abrir Chamado';
  arquivosPendentes = [];
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
