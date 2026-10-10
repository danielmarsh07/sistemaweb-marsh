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

  // Botão Aparência → abre modal com theme picker
  const btnAp = document.getElementById('btn-aparencia');
  if (btnAp) btnAp.addEventListener('click', abrirAparencia);
});

// ===== APARÊNCIA / TEMA =====
function abrirAparencia() {
  renderThemePickerPortal();
  document.getElementById('modal-aparencia').classList.add('show');
}
function fecharAparencia() {
  document.getElementById('modal-aparencia').classList.remove('show');
}

function renderThemePickerPortal() {
  const root = document.getElementById('theme-picker-portal');
  if (!root || !window.Theme) return;
  const ativo = window.Theme.get();
  const temas = window.Theme.list();
  root.innerHTML = temas.map(t => `
    <div class="theme-card ${t.id === ativo ? 'is-active' : ''}" data-theme-id="${t.id}" role="button" tabindex="0">
      <span class="theme-card-check" aria-hidden="true">✓</span>
      <div class="theme-preview" style="background:${t.swatches[0]}">
        <div class="theme-preview-sidebar" style="background:${t.sidebar}; border-right:1px solid ${t.borda}"></div>
        <div class="theme-preview-main">
          <span class="theme-preview-bar long"  style="background:${t.swatches[3]}; opacity:0.85"></span>
          <span class="theme-preview-bar short" style="background:${t.swatches[2]}"></span>
          <span class="theme-preview-card"      style="background:${t.swatches[1]}; border-color:${t.borda}"></span>
        </div>
      </div>
      <div class="theme-card-info">
        <span class="theme-card-nome">${t.nome}</span>
        <span class="theme-card-desc">${t.descricao}</span>
      </div>
      <div class="theme-card-swatches" aria-hidden="true">
        ${t.swatches.map(c => `<span class="theme-swatch" style="background:${c}"></span>`).join('')}
      </div>
    </div>
  `).join('');

  root.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => aplicarTemaPortal(card.dataset.themeId));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aplicarTemaPortal(card.dataset.themeId); }
    });
  });
}

async function aplicarTemaPortal(id) {
  if (!window.Theme) return;
  await window.Theme.set(id);
  document.querySelectorAll('#theme-picker-portal .theme-card').forEach(c => {
    c.classList.toggle('is-active', c.dataset.themeId === id);
  });
}

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
    carregarTecnologias(),
    carregarTreinamentos(),
    carregarLicencasPortal(),
    carregarFinanceiroPortal()
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
          ${escapeHtml(ch.titulo)}
          ${naoLidos > 0 ? `<span class="badge-novo" title="${naoLidos} novo(s) comentário(s)">${naoLidos} novo${naoLidos > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="chamado-meta">
          ${ch.tecnologia_nome ? `<span>💻 ${escapeHtml(ch.tecnologia_nome)}</span>` : ''}
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
    <div><strong>Tecnologia</strong>${escapeHtml(ch.tecnologia_nome || 'Geral')}</div>
    <div><strong>Aberto em</strong>${formatDataHora(ch.data_abertura)}</div>
    ${ch.sla && ch.sla.sla_status !== 'concluido' ? `<div><strong>SLA</strong>${badgeSlaDetalhe(ch.sla)}</div>` : ''}
    ${ch.categoria ? `<div><strong>Categoria</strong>${escapeHtml(ch.categoria)}</div>` : ''}
    ${ch.data_fechamento ? `<div><strong>Fechado em</strong>${formatDataHora(ch.data_fechamento)}</div>` : ''}
    <div style="grid-column:1/-1"><strong>Descrição</strong>${escapeHtml(ch.descricao || '—')}</div>
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
  const imagens = anexos.filter(a => a.preview_url);
  const arquivos = anexos.filter(a => !a.preview_url);
  const concluido = ch.status === 'fechado' || ch.status === 'resolvido';

  wrapper.innerHTML = `
    <div class="bloco-anexos">
      <h4>Anexos ${anexos.length ? `(${anexos.length})` : ''}</h4>

      ${imagens.length ? `
        <div class="thumbs-grid">
          ${imagens.map(a => `
            <div class="thumb-card" data-url="${escapeHtml(a.preview_url)}" data-legenda="${escapeHtml(a.nome_original)}" onclick="abrirLightboxFromCard(this)">
              <div class="thumb-img" style="background-image:url('${escapeHtml(a.preview_url)}')"></div>
              <div class="thumb-info">
                <span class="thumb-nome" title="${escapeHtml(a.nome_original)}">${escapeHtml(a.nome_original)}</span>
                <span class="thumb-meta">${formatarTamanho(a.tamanho_bytes)} · ${escapeHtml(a.enviado_por_nome || '')}</span>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${arquivos.length ? `
        <ul class="anexos-list">
          ${arquivos.map(a => `
            <li class="anexo-item">
              <span class="anexo-nome" title="${escapeHtml(a.nome_original)}">${iconeAnexo(a.mime_type)} ${escapeHtml(a.nome_original)}</span>
              <span class="anexo-meta">${formatarTamanho(a.tamanho_bytes)} · ${escapeHtml(a.enviado_por_nome || '')}</span>
              <button class="btn-anexo" onclick="baixarAnexoPortal(${ch.id}, ${a.id})">Baixar</button>
            </li>
          `).join('')}
        </ul>
      ` : ''}

      ${anexos.length === 0 ? '<p class="sem-anexos">Nenhum anexo neste chamado.</p>' : ''}

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

// Wrapper que pega url+legenda dos data-attributes do card; evita XSS via onclick com strings.
function abrirLightboxFromCard(el) {
  abrirLightbox(el.dataset.url, el.dataset.legenda);
}

function abrirLightbox(url, legenda) {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.onclick = () => lb.classList.remove('show');
    document.body.appendChild(lb);
  }
  // Constrói o conteúdo via DOM API; setAttribute escapa automaticamente.
  lb.innerHTML = '';
  const btnFechar = document.createElement('button');
  btnFechar.className = 'lightbox-fechar';
  btnFechar.innerHTML = '&times;';
  btnFechar.onclick = (e) => { e.stopPropagation(); lb.classList.remove('show'); };
  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = url;
  img.alt = legenda || '';
  img.onclick = (e) => e.stopPropagation();
  const cap = document.createElement('div');
  cap.className = 'lightbox-legenda';
  cap.textContent = legenda || '';
  lb.appendChild(btnFechar);
  lb.appendChild(img);
  lb.appendChild(cap);
  lb.classList.add('show');
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
        ${jaAvaliou && ch.avaliacao.comentario ? `<p class="csat-comentario">"${escapeHtml(ch.avaliacao.comentario)}"</p>` : ''}
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
          <strong style="color:${cores[a.tipo] || '#64748b'}">${labels[a.tipo] || escapeHtml(a.tipo)}</strong>
          · ${escapeHtml(a.usuario_nome || 'Suporte')} · ${formatDataHora(a.data_atendimento)}
        </div>
        <div>${escapeHtml(a.descricao)}</div>
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
      <span class="nome" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
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

// ===== TREINAMENTOS =====
let cursosPortal = [];
let cursoAberto = null;   // { ...curso, aulas: [...] }
let aulaAtual = 0;

const ICONE_CURSO = {
  abap: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  func: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  fiori: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  cpi: '<path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"/>',
  geral: '<path d="M21.4 10.9a1 1 0 0 0 0-1.8L12.8 5.2a2 2 0 0 0-1.7 0L2.6 9.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.7 0z"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>'
};
const svgCurso = capa => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONE_CURSO[capa] || ICONE_CURSO.geral}</svg>`;

async function carregarTreinamentos() {
  const res = await apiFetch(`${API}/treinamentos/meus`);
  if (!res || !res.ok) return;
  cursosPortal = await res.json();
  const secao = document.getElementById('secao-treinamentos');
  secao.hidden = !cursosPortal.length;
  document.getElementById('lista-cursos').innerHTML = cursosPortal.map(c => {
    const pct = c.total_aulas ? Math.round(100 * c.concluidas / c.total_aulas) : 0;
    const capa = ICONE_CURSO[c.capa] ? c.capa : 'geral';
    return `
      <div class="curso-card" role="button" tabindex="0" onclick="abrirCurso(${c.id})"
           onkeydown="if(event.key==='Enter'){abrirCurso(${c.id})}">
        <div class="curso-capa capa-${capa}">${svgCurso(capa)}</div>
        <div class="curso-corpo">
          <h4>${escapeHtml(c.titulo)}</h4>
          <p>${escapeHtml(c.descricao || '')}</p>
          <div class="curso-meta"><span>${c.total_aulas} aulas${c.carga_horaria ? ' · ' + escapeHtml(c.carga_horaria) : ''}</span><span>${pct}%</span></div>
          <div class="barra-curso"><i style="width:${pct}%"></i></div>
          <div class="curso-acoes">
            <span class="btn-curso">${pct === 0 ? 'Começar' : pct === 100 ? 'Rever' : 'Continuar'}</span>
            ${pct === 100 ? `<button class="btn-curso secundario" type="button" onclick="event.stopPropagation(); emitirCertificado(${c.id})">Certificado</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

async function abrirCurso(id) {
  const res = await apiFetch(`${API}/treinamentos/meus/${id}`);
  if (!res) return;
  const dados = await res.json();
  if (!res.ok) { alert(dados.erro); return; }
  cursoAberto = dados;
  document.getElementById('curso-titulo').textContent = dados.titulo;
  const primeiraPendente = dados.aulas.findIndex(a => !a.concluida);
  selecionarAula(primeiraPendente >= 0 ? primeiraPendente : 0);
  abrirModal('modal-curso');
}

function renderListaAulas() {
  const aulas = cursoAberto.aulas;
  const feitas = aulas.filter(a => a.concluida).length;
  const pct = aulas.length ? Math.round(100 * feitas / aulas.length) : 0;
  document.getElementById('curso-progresso-txt').textContent = `${feitas} de ${aulas.length} aulas concluídas (${pct}%)`;
  document.getElementById('curso-progresso-barra').style.width = `${pct}%`;
  document.getElementById('curso-aulas').innerHTML = aulas.map((a, i) => `
    <li class="${a.concluida ? 'feita' : ''}">
      <button type="button" class="${i === aulaAtual ? 'ativa' : ''}" onclick="selecionarAula(${i})">
        <span class="marca">${a.concluida ? '✓' : i + 1}</span>
        <span>${escapeHtml(a.titulo)}<small>${escapeHtml(a.modulo || '')}${a.duracao_min ? ' · ' + a.duracao_min + ' min' : ''}</small></span>
      </button>
    </li>`).join('');
}

function selecionarAula(i) {
  aulaAtual = i;
  const a = cursoAberto.aulas[i];
  const wrap = document.getElementById('video-wrap');
  if (a && a.video_url) {
    // URL vem normalizada pelo servidor (só players permitidos); escapada mesmo assim
    wrap.innerHTML = `<iframe src="${escapeHtml(a.video_url)}" title="${escapeHtml(a.titulo)}"
      allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else {
    wrap.textContent = 'Vídeo desta aula em breve.';
  }
  document.getElementById('aula-titulo').textContent = a ? a.titulo : '';
  document.getElementById('aula-descricao').textContent = a ? (a.descricao || '') : '';
  const mat = document.getElementById('aula-material');
  mat.hidden = !(a && a.material_url);
  if (a && a.material_url) mat.href = a.material_url;
  const btn = document.getElementById('btn-concluir');
  btn.textContent = a && a.concluida ? '✓ Concluída (desfazer)' : 'Marcar como concluída';
  btn.classList.toggle('feito', !!(a && a.concluida));
  renderListaAulas();
}

async function alternarConclusao() {
  const a = cursoAberto.aulas[aulaAtual];
  if (!a) return;
  const res = await apiFetch(`${API}/treinamentos/aulas/${a.id}/concluir`, {
    method: 'POST', body: JSON.stringify({ concluida: !a.concluida }) });
  if (!res || !res.ok) return;
  a.concluida = !a.concluida;
  // Concluiu: avança para a próxima pendente
  const proxima = cursoAberto.aulas.findIndex((x, i) => i > aulaAtual && !x.concluida);
  selecionarAula(a.concluida && proxima >= 0 ? proxima : aulaAtual);
}

function fecharCurso() {
  document.getElementById('video-wrap').innerHTML = ''; // para o vídeo
  fecharModal('modal-curso');
  carregarTreinamentos();
}

// Fechar clicando fora também precisa parar o vídeo e atualizar o progresso nos cartões
document.getElementById('modal-curso')?.addEventListener('click', e => {
  if (e.target.id === 'modal-curso') fecharCurso();
});

function emitirCertificado(id) {
  const c = cursosPortal.find(x => x.id === id);
  if (!c) return;
  const data = new Date(c.ultima_conclusao || Date.now()).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const w = window.open('', '_blank');
  if (!w) { alert('Permita pop-ups para abrir o certificado.'); return; }
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Certificado</title>
    <style>
      @page { size: A4 landscape; margin: 0; }
      body { margin: 0; font-family: Inter, 'Segoe UI', Arial, sans-serif; color: #13233a; }
      .folha { box-sizing: border-box; width: 297mm; height: 210mm; padding: 22mm 26mm; position: relative;
        background: linear-gradient(135deg, #f2f6fb 0%, #ffffff 55%, #e3effc 100%); border: 10px solid #1d6fd8; }
      .marca { display: flex; align-items: center; gap: 12px; }
      .m { width: 52px; height: 52px; object-fit: contain; }
      .marca strong { display: block; letter-spacing: .2em; font-size: 20px; }
      .marca span { display: block; letter-spacing: .42em; font-size: 10px; color: #5f7088; }
      h1 { font-size: 40px; margin: 22mm 0 6mm; letter-spacing: -.01em; }
      .nome { font-size: 34px; font-weight: 700; color: #1d6fd8; margin: 4mm 0; }
      p { font-size: 17px; line-height: 1.6; max-width: 200mm; }
      .rodape { position: absolute; bottom: 20mm; left: 26mm; right: 26mm; display: flex; justify-content: space-between; font-size: 13px; color: #5f7088; }
      @media print { .nao-imprimir { display: none; } }
    </style></head><body>
    <div class="folha">
      <div class="marca"><img class="m" src="${location.origin}/img/logo-simbolo.png" alt=""><div><strong>MARSH</strong><span>CONSULTORIA</span></div></div>
      <h1>Certificado de conclusão</h1>
      <p>Certificamos que</p>
      <div class="nome">${escapeHtml(usuario.nome)}</div>
      <p>concluiu o curso <strong>${escapeHtml(c.titulo)}</strong>${c.carga_horaria ? `, com carga horária de ${escapeHtml(c.carga_horaria)}` : ''},
         oferecido pela Marsh Consultoria${usuario.empresa_nome ? ` à ${escapeHtml(usuario.empresa_nome)}` : ''}.</p>
      <div class="rodape"><span>Emitido em ${escapeHtml(data)}</span><span>Marsh Consultoria — SAP | IA</span></div>
    </div>
    <p class="nao-imprimir" style="text-align:center"><button onclick="print()">Imprimir / salvar em PDF</button></p>
    </body></html>`);
  w.document.close();
}

// ===== LICENÇA DO CONECTOR SAP (só leitura para o cliente) =====
async function carregarLicencasPortal() {
  const res = await apiFetch(`${API}/licencas/minhas`);
  if (!res || !res.ok) return;
  const lista = await res.json();
  document.getElementById('secao-licenca').hidden = !lista.length;
  const planos = { leitura: 'Leitura', desenvolvimento: 'Desenvolvimento', empresa: 'Empresa' };
  const hoje = new Date().toISOString().slice(0, 10);
  document.getElementById('lista-licencas').innerHTML = lista.map(l => {
    const fim = String(l.data_fim).slice(0, 10);
    const vencida = fim < hoje;
    const st = l.status === 'suspensa' ? ['Suspensa', '#f59e0b'] : vencida ? ['Vencida', '#ef4444'] : ['Ativa', '#10b981'];
    return `
      <div class="licenca-card">
        <h4>Plano ${escapeHtml(planos[l.plano] || l.plano)}
          <span style="background:${st[1]}20; color:${st[1]}; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:600">${st[0]}</span></h4>
        <div class="linha"><span>Válida até</span><strong>${fim.split('-').reverse().join('/')}</strong></div>
        <div class="linha"><span>Sistemas</span><strong>${escapeHtml(String(l.sids).replace(/,/g, ', '))}</strong></div>
        <div class="linha"><span>Usuários ativos (30 dias)</span><strong>${l.usuarios_ativos}${l.max_usuarios ? ' de ' + l.max_usuarios : ''}</strong></div>
        <div class="linha"><span>Uso do conector (30 dias)</span><strong>${Number(l.chamadas_30d).toLocaleString('pt-BR')} operações</strong></div>
      </div>`;
  }).join('');
}

// ===== FINANCEIRO: faturas e NFS-e do cliente (só leitura) =====
async function carregarFinanceiroPortal() {
  const res = await apiFetch(`${API}/financeiro/minhas-faturas`);
  if (!res || !res.ok) return;
  const { faturas, pagamento } = await res.json();
  document.getElementById('secao-financeiro').hidden = !faturas.length;
  if (!faturas.length) return;

  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const mesAno = d => { const [a, m] = String(d).slice(0, 7).split('-'); return `${meses[Number(m) - 1]}/${a}`; };
  const br = d => String(d).slice(0, 10).split('-').reverse().join('/');
  const moeda = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const temAberta = faturas.some(f => f.status === 'aberta');
  document.getElementById('financeiro-pagamento').innerHTML = temAberta && (pagamento.pix_chave || pagamento.instrucoes) ? `
    <div class="pagamento-box">
      <strong>Como pagar</strong>
      ${pagamento.pix_chave ? `<p>PIX: <strong>${escapeHtml(pagamento.pix_chave)}</strong></p>` : ''}
      ${pagamento.instrucoes ? `<p>${escapeHtml(pagamento.instrucoes)}</p>` : ''}
    </div>` : '';

  document.getElementById('lista-faturas').innerHTML = faturas.map(f => {
    const st = f.status === 'paga' ? [`Paga em ${br(f.data_pagamento)}`, '#10b981']
      : f.vencida ? ['Vencida', '#ef4444'] : ['Em aberto', '#1d6fd8'];
    const docs = [
      f.nfse_pdf_url && `<a href="${escapeHtml(f.nfse_pdf_url)}" target="_blank" rel="noopener">Nota fiscal (PDF)</a>`,
      f.nfse_xml_url && `<a href="${escapeHtml(f.nfse_xml_url)}" target="_blank" rel="noopener">XML</a>`
    ].filter(Boolean).join('');
    return `
      <div class="licenca-card fatura-card${f.vencida ? ' vencida' : ''}">
        <h4>${mesAno(f.competencia)}
          <span style="background:${st[1]}20; color:${st[1]}; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:600">${st[0]}</span></h4>
        <div class="linha"><span>Valor da nota</span><strong>${moeda(f.valor)}</strong></div>
        ${f.valor_liquido < f.valor ? `<div class="linha"><span>Valor a pagar (com retenções)</span><strong>${moeda(f.valor_liquido)}</strong></div>` : ''}
        <div class="linha"><span>Vencimento</span><strong>${br(f.data_vencimento)}</strong></div>
        <div class="linha"><span>NFS-e</span><strong>${f.nfse_status === 'emitida' ? 'Nº ' + escapeHtml(f.nfse_numero || '-') : f.nfse_status === 'processando' ? 'Em emissão' : '—'}</strong></div>
        ${docs ? `<div class="docs">${docs}</div>` : ''}
      </div>`;
  }).join('');
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

// ===== ESCAPE HTML =====
// Usado em todo lugar onde dado vindo do usuário (titulo, descricao, nomes, anexos, comentários etc)
// é interpolado em template string que vai para innerHTML. Protege contra XSS persistente.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
