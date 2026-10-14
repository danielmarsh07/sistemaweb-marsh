// ===== MARKETING: calendário de posts do Instagram, editor, importar agenda, métricas e conta =====
// Usa helpers do script.js (apiFetch, API_URL, token, usuario, escapeHtml, showModal, closeModal) e do
// relatorios.js (escalaPasso). Só administradores: o grupo do menu some para os demais e a API responde 403.
// Horários sempre em America/Sao_Paulo (sem horário de verão desde 2019: -03:00).

const MKT_FUSO = 'America/Sao_Paulo';
const MKT_LEGENDA_MAX = 2200;
const MKT_HASHTAGS_MAX = 30;
const MKT_IMAGENS_MAX = 10;
const MKT_STATUS = {
  rascunho:   ['Rascunho', '#64748b'],
  agendado:   ['Agendado', '#1d6fd8'],
  publicando: ['Publicando', '#b7791f'],
  publicado:  ['Publicado', '#2e7d4f'],
  erro:       ['Com erro', '#b42318'],
  cancelado:  ['Cancelado', '#8494aa']
};
const MKT_MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

let _mktMes = null;          // { ano, mes } (mes 1..12) em exibição no calendário
let _mktVisao = null;        // 'mes' | 'lista'
let _mktPosts = [];          // posts do mês + rascunhos sem data
let _mktPost = null;         // post aberto no editor (null = novo, ainda não gravado)
let _mktCriadoNoEditor = false;
let _mktAlterado = false;    // recarrega o calendário ao fechar o editor
let _mktPrevia = 'feed';
let _mktSlide = 0;
let _mktUsername = null;
let _mktImportacao = null;   // { agendaTexto, arquivos: [File] }

// ---------- datas no fuso de São Paulo ----------
function partesSp(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MKT_FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(d)).map(x => [x.type, x.value]));
  return { ano: p.year, mes: p.month, dia: p.day, hora: p.hour, min: p.minute };
}
const diaSp = d => { const p = partesSp(d); return `${p.ano}-${p.mes}-${p.dia}`; };
const horaSp = d => { const p = partesSp(d); return `${p.hora}:${p.min}`; };
const dataHoraSp = d => { if (!d) return '—'; const p = partesSp(d); return `${p.dia}/${p.mes}/${p.ano} ${p.hora}:${p.min}`; };
const isoParaInputSp = d => { if (!d) return ''; const p = partesSp(d); return `${p.ano}-${p.mes}-${p.dia}T${p.hora}:${p.min}`; };
const inputSpParaIso = v => (v ? `${v}:00-03:00` : null);
const diaBrCurto = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const numBr = v => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const contarHashtagsMkt = t => (String(t || '').match(/#[\p{L}\p{N}_]+/gu) || []).length;

function pillMkt(status) {
  const [rotulo, cor] = MKT_STATUS[status] || [status, '#64748b'];
  return `<span class="fin-pill" style="--pill:${cor}">${escapeHtml(rotulo)}</span>`;
}

// Upload multipart: fetch direto (o apiFetch fixa Content-Type JSON)
async function mktEnviarForm(url, form) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (res.status === 401) { logout(); return null; }
  return res;
}
async function mktJson(url, metodo = 'GET', corpo) {
  const res = await apiFetch(url, { method: metodo, ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}) });
  if (!res) return { ok: false, dados: {} };
  const dados = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, dados };
}

// =================== CALENDÁRIO ===================
async function loadCalendarioMarketing() {
  if (!_mktMes) { const h = partesSp(new Date()); _mktMes = { ano: Number(h.ano), mes: Number(h.mes) }; }
  if (!_mktVisao) {
    try { _mktVisao = localStorage.getItem('mkt.visao'); } catch { _mktVisao = null; }
    if (!['mes', 'lista'].includes(_mktVisao)) _mktVisao = window.innerWidth < 600 ? 'lista' : 'mes';
  }
  const { ano, mes } = _mktMes;
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const mm = String(mes).padStart(2, '0');
  document.getElementById('mkt-calendario').innerHTML = '<p class="fin-muted">Carregando...</p>';
  const [rp, rc] = await Promise.all([
    mktJson(`${API_URL}/marketing/posts?de=${ano}-${mm}-01&ate=${ano}-${mm}-${ultimo}&sem_data=1`),
    mktJson(`${API_URL}/marketing/conta`)
  ]);
  if (!rp.ok) { document.getElementById('mkt-calendario').innerHTML = `<p class="fin-muted">${escapeHtml(rp.dados.erro || 'Erro ao carregar os posts.')}</p>`; return; }
  _mktPosts = rp.dados;
  _mktUsername = rc.ok ? rc.dados.username : null;
  const aviso = document.getElementById('mkt-aviso-conta');
  aviso.innerHTML = rc.ok && !rc.dados.conectada
    ? `<p class="fin-aviso">Conta do Instagram não conectada: os posts agendados só saem depois de conectar.
         <a href="#" onclick="showPage('marketing-conta'); return false;">Conectar a conta →</a></p>` : '';
  renderCalendarioMarketing();
}

function mudarMesMarketing(delta) {
  if (!delta) { const h = partesSp(new Date()); _mktMes = { ano: Number(h.ano), mes: Number(h.mes) }; }
  else {
    const d = new Date(Date.UTC(_mktMes.ano, _mktMes.mes - 1 + delta, 1));
    _mktMes = { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 };
  }
  loadCalendarioMarketing();
}

function mudarVisaoMarketing(v) {
  _mktVisao = v;
  try { localStorage.setItem('mkt.visao', v); } catch { /* sem armazenamento */ }
  renderCalendarioMarketing();
}

function renderCalendarioMarketing() {
  if (!_mktMes) return;
  const filtro = document.getElementById('mkt-filtro-status').value;
  const posts = _mktPosts.filter(p => !filtro || p.status === filtro);
  const comData = posts.filter(p => p.dia);
  const semData = posts.filter(p => !p.dia);
  const nomeMes = MKT_MESES[_mktMes.mes - 1];
  document.getElementById('mkt-mes-titulo').textContent = `${nomeMes[0].toUpperCase()}${nomeMes.slice(1)} de ${_mktMes.ano}`;
  document.querySelectorAll('.mkt-visao [data-visao]').forEach(b => {
    const ativo = b.dataset.visao === _mktVisao;
    b.classList.toggle('btn-primary', ativo);
    b.classList.toggle('btn-secondary', !ativo);
    b.setAttribute('aria-pressed', String(ativo));
  });
  document.getElementById('mkt-contador').textContent =
    `${comData.length} post(s) no mês${semData.length ? ` · ${semData.length} rascunho(s) sem data` : ''}`;
  const alvo = document.getElementById('mkt-calendario');
  if (_mktVisao === 'lista') {
    alvo.innerHTML = listaPostsHtml([...comData, ...semData]);
    document.getElementById('mkt-sem-data').innerHTML = '';
  } else {
    alvo.innerHTML = gradeMesHtml(comData);
    document.getElementById('mkt-sem-data').innerHTML = semData.length ? `
      <section class="rel-card mkt-sem-data">
        <h3>Rascunhos sem data</h3>
        <div class="mkt-sem-data-lista">${semData.map(chipPostHtml).join('')}</div>
      </section>` : '';
  }
}

function chipPostHtml(p) {
  const [rotulo] = MKT_STATUS[p.status] || [p.status];
  const nome = p.titulo || (p.legenda || '').split('\n')[0] || `Post #${p.id}`;
  return `
    <button type="button" class="mkt-chip st-${escapeHtml(p.status)}" onclick="event.stopPropagation(); abrirEditorPost(${p.id})"
            title="${escapeHtml(nome)} · ${escapeHtml(rotulo)}${p.dia ? ' · ' + escapeHtml(horaSp(p.data_publicacao || p.data_agendada)) : ''}">
      ${p.capa_url ? `<img src="${escapeHtml(p.capa_url)}" alt="" loading="lazy">` : '<span class="mkt-chip-semimg" aria-hidden="true"></span>'}
      <span class="mkt-chip-info">
        ${p.dia ? `<b>${escapeHtml(horaSp(p.data_publicacao || p.data_agendada))}</b>` : ''}
        <span class="mkt-chip-titulo">${escapeHtml(nome)}</span>
        <i class="mkt-chip-status">${escapeHtml(rotulo)}${p.n_midias > 1 ? ` · ${p.n_midias} imagens` : ''}</i>
      </span>
    </button>`;
}

function gradeMesHtml(posts) {
  const { ano, mes } = _mktMes;
  const primeiroDiaSemana = new Date(Date.UTC(ano, mes - 1, 1)).getUTCDay(); // 0 = domingo
  const dias = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const hoje = diaSp(new Date());
  const porDia = {};
  posts.forEach(p => { (porDia[p.dia] = porDia[p.dia] || []).push(p); });
  let celulas = '';
  for (let i = 0; i < primeiroDiaSemana; i++) celulas += '<div class="mkt-dia vazio" aria-hidden="true"></div>';
  for (let d = 1; d <= dias; d++) {
    const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const lista = porDia[iso] || [];
    const passado = iso < hoje;
    celulas += `
      <div class="mkt-dia${iso === hoje ? ' hoje' : ''}${passado ? ' passado' : ''}" ${passado ? '' : `onclick="abrirEditorPost(null, '${iso}')" title="Criar post em ${diaBrCurto(iso)}"`}>
        <span class="mkt-dia-num">${d}</span>
        <div class="mkt-dia-posts">${lista.map(chipPostHtml).join('')}</div>
      </div>`;
  }
  const resto = (primeiroDiaSemana + dias) % 7;
  if (resto) for (let i = resto; i < 7; i++) celulas += '<div class="mkt-dia vazio" aria-hidden="true"></div>';
  const semana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return `
    <div class="mkt-grade" role="grid" aria-label="Calendário do mês">
      ${semana.map(s => `<div class="mkt-semana">${s}</div>`).join('')}
      ${celulas}
    </div>`;
}

function listaPostsHtml(posts) {
  if (!posts.length) return '<p class="fin-muted">Nenhum post neste mês. Use <strong>+ Novo post</strong> ou <strong>Importar agenda</strong>.</p>';
  return `
    <div class="table-container">
      <table>
        <thead><tr><th></th><th>Data (Brasília)</th><th>Post</th><th>Tipo</th><th>Status</th></tr></thead>
        <tbody>${posts.map(p => `
          <tr style="cursor:pointer" onclick="abrirEditorPost(${p.id})">
            <td data-label="" class="mkt-lista-capa">${p.capa_url ? `<img src="${escapeHtml(p.capa_url)}" alt="" loading="lazy">` : '<span class="mkt-chip-semimg"></span>'}</td>
            <td data-label="Data">${p.dia ? escapeHtml(dataHoraSp(p.data_publicacao || p.data_agendada)) : '<span class="fin-muted">sem data</span>'}</td>
            <td data-label="Post"><strong>${escapeHtml(p.titulo || `Post #${p.id}`)}</strong>
              <span class="fin-sub">${escapeHtml((p.legenda || '').split('\n')[0].slice(0, 90))}</span>
              ${p.ultimo_erro && p.status !== 'publicado' ? `<div class="fin-erro">${escapeHtml(p.ultimo_erro)}</div>` : ''}</td>
            <td data-label="Tipo">${p.n_midias > 1 ? `Carrossel (${p.n_midias})` : p.n_midias ? 'Imagem' : '<span class="fin-muted">sem imagem</span>'}</td>
            <td data-label="Status">${pillMkt(p.status)}${p.permalink ? ` <a href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">ver ↗</a>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// =================== EDITOR ===================
async function abrirEditorPost(id, diaInicial) {
  _mktPost = null;
  _mktCriadoNoEditor = false;
  _mktSlide = 0;
  _mktPrevia = 'feed';
  if (id) {
    const r = await mktJson(`${API_URL}/marketing/posts/${id}`);
    if (!r.ok) { alert(r.dados.erro || 'Post não encontrado.'); return; }
    _mktPost = r.dados;
  }
  document.getElementById('mkt-titulo').value = _mktPost ? (_mktPost.titulo || '') : '';
  document.getElementById('mkt-legenda').value = _mktPost ? (_mktPost.legenda || '') : '';
  document.getElementById('mkt-data').value = _mktPost ? isoParaInputSp(_mktPost.data_agendada) : (diaInicial ? `${diaInicial}T12:30` : '');
  document.getElementById('mkt-envio').hidden = true;
  renderEditor();
  showModal('#modal-mkt-post');
}

const mktSomenteLeitura = () => !!_mktPost && ['publicado', 'publicando'].includes(_mktPost.status);

function renderEditor() {
  const p = _mktPost;
  const leitura = mktSomenteLeitura();
  document.getElementById('mkt-editor-titulo').textContent = p ? `${p.titulo || 'Post #' + p.id}` : 'Novo post';
  ['mkt-titulo', 'mkt-legenda', 'mkt-data'].forEach(i => { document.getElementById(i).disabled = leitura; });
  document.getElementById('mkt-dropzone').hidden = leitura || (p && p.midias.length >= MKT_IMAGENS_MAX);

  let status = '';
  if (p) {
    const linhas = [];
    if (p.status === 'publicado') {
      linhas.push(`Publicado em ${escapeHtml(dataHoraSp(p.data_publicacao))}.`);
      if (p.permalink) linhas.push(`<a href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener">Abrir no Instagram ↗</a>`);
    } else if (p.status === 'agendado') {
      linhas.push(`Sai em ${escapeHtml(dataHoraSp(p.data_agendada))} (Brasília).`);
    }
    if (p.tentativas && p.status !== 'publicado') linhas.push(`Tentativas: ${p.tentativas} de 3.`);
    status = `
      <div class="mkt-status-box st-${escapeHtml(p.status)}">
        ${pillMkt(p.status)} <span>${p.tipo === 'carrossel' ? 'Carrossel' : 'Imagem'}</span> ${linhas.join(' ')}
        ${p.ultimo_erro && p.status !== 'publicado' ? `<div class="fin-erro mkt-erro">${escapeHtml(p.ultimo_erro)}</div>` : ''}
        ${leitura ? '<div class="fin-muted">Post publicado: só leitura. Use Duplicar para reaproveitar.</div>' : ''}
      </div>`;
  }
  document.getElementById('mkt-editor-status').innerHTML = status;
  renderMidiasEditor();
  atualizarContadoresLegenda();
  renderAcoesEditor();
}

function renderMidiasEditor() {
  const midias = _mktPost ? _mktPost.midias : [];
  const leitura = mktSomenteLeitura();
  document.getElementById('mkt-midias').innerHTML = midias.map((m, i) => `
    <li class="mkt-midia">
      <span class="mkt-midia-ordem">${i + 1}</span>
      ${m.url ? `<img src="${escapeHtml(m.url)}" alt="Imagem ${i + 1}">` : '<span class="mkt-chip-semimg"></span>'}
      <span class="mkt-midia-info"><span>${escapeHtml(m.nome_arquivo || '')}</span>
        <small>${m.largura}×${m.altura} · ${(Number(m.tamanho_bytes) / 1024).toFixed(0)} KB</small></span>
      ${leitura ? '' : `<span class="mkt-midia-acoes">
        <button type="button" class="btn btn-secondary btn-sm" ${i === 0 ? 'disabled' : ''} onclick="moverMidiaMarketing(${i}, -1)" aria-label="Mover para antes">←</button>
        <button type="button" class="btn btn-secondary btn-sm" ${i === midias.length - 1 ? 'disabled' : ''} onclick="moverMidiaMarketing(${i}, 1)" aria-label="Mover para depois">→</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="removerMidiaMarketing(${m.id})" aria-label="Remover imagem">×</button>
      </span>`}
    </li>`).join('');
  document.getElementById('mkt-dropzone').hidden = leitura || midias.length >= MKT_IMAGENS_MAX;
  if (_mktSlide >= midias.length) _mktSlide = Math.max(0, midias.length - 1);
  renderPrevia();
}

function atualizarContadoresLegenda() {
  const t = document.getElementById('mkt-legenda').value;
  const n = t.length, h = contarHashtagsMkt(t);
  document.getElementById('mkt-contadores').innerHTML = `
    <span class="${n > MKT_LEGENDA_MAX ? 'excedeu' : ''}">${n.toLocaleString('pt-BR')} / ${MKT_LEGENDA_MAX.toLocaleString('pt-BR')} caracteres</span>
    <span class="${h > MKT_HASHTAGS_MAX ? 'excedeu' : ''}">${h} / ${MKT_HASHTAGS_MAX} hashtags</span>`;
  renderPrevia();
}

function renderAcoesEditor() {
  const p = _mktPost;
  const b = (rotulo, acao, classe = 'btn-secondary', extra = '') => `<button type="button" class="btn ${classe}" onclick="${acao}" ${extra}>${rotulo}</button>`;
  let html = '';
  if (mktSomenteLeitura()) {
    html = b('Duplicar', 'duplicarPostMarketing()') +
      (p.permalink ? `<a class="btn btn-primary" href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener">Ver no Instagram ↗</a>` : '');
  } else {
    if (p && ['rascunho', 'cancelado', 'erro'].includes(p.status)) html += b('Excluir', 'excluirPostMarketing()', 'btn-danger');
    if (p && ['rascunho', 'agendado', 'erro'].includes(p.status)) html += b('Cancelar post', 'cancelarPostMarketing()');
    if (p) html += b('Duplicar', 'duplicarPostMarketing()');
    html += '<span class="mkt-acoes-espaco"></span>';
    html += b('Salvar rascunho', "salvarPostMarketing('rascunho')");
    html += b('Publicar agora', 'publicarAgoraMarketing()');
    html += b('Agendar', "salvarPostMarketing('agendado')", 'btn-primary');
  }
  document.getElementById('mkt-editor-acoes').innerHTML = html;
}

// Prévia como no Instagram: feed (moldura 4:5) e carrossel (setas e pontos)
function mudarPrevia(modo) { _mktPrevia = modo; renderPrevia(); }
function slidePrevia(delta) {
  const n = _mktPost ? _mktPost.midias.length : 0;
  _mktSlide = Math.min(Math.max(0, _mktSlide + delta), Math.max(0, n - 1));
  renderPrevia();
}
function renderPrevia() {
  document.querySelectorAll('.mkt-previa-abas [data-previa]').forEach(btn => {
    const ativo = btn.dataset.previa === _mktPrevia;
    btn.classList.toggle('btn-primary', ativo);
    btn.classList.toggle('btn-secondary', !ativo);
  });
  const midias = _mktPost ? _mktPost.midias : [];
  const usuarioIg = _mktUsername || 'marshconsultoria';
  const idx = _mktPrevia === 'carrossel' ? _mktSlide : 0;
  const m = midias[idx];
  const legenda = document.getElementById('mkt-legenda').value;
  // Como no feed: só o começo da legenda, com "mais"
  const legendaHtml = legenda.length > 125
    ? escapeHtml(legenda.slice(0, 125).trimEnd()) + '… <span class="mkt-ig-mais">mais</span>' : escapeHtml(legenda);
  document.getElementById('mkt-previa').innerHTML = `
    <div class="mkt-ig-topo"><span class="mkt-ig-avatar" aria-hidden="true"></span><strong>${escapeHtml(usuarioIg)}</strong></div>
    <div class="mkt-ig-midia">
      ${m && m.url ? `<img src="${escapeHtml(m.url)}" alt="Prévia da imagem ${idx + 1}">` : '<div class="mkt-ig-vazio">Sem imagem</div>'}
      ${midias.length > 1 ? `<span class="mkt-ig-contador">${idx + 1}/${midias.length}</span>` : ''}
      ${_mktPrevia === 'carrossel' && midias.length > 1 ? `
        <button type="button" class="mkt-ig-seta esq" onclick="slidePrevia(-1)" ${idx === 0 ? 'hidden' : ''} aria-label="Imagem anterior">‹</button>
        <button type="button" class="mkt-ig-seta dir" onclick="slidePrevia(1)" ${idx === midias.length - 1 ? 'hidden' : ''} aria-label="Próxima imagem">›</button>` : ''}
    </div>
    ${midias.length > 1 ? `<div class="mkt-ig-pontos">${midias.map((_, i) => `<i class="${i === idx ? 'ativo' : ''}"></i>`).join('')}</div>` : ''}
    <div class="mkt-ig-legenda"><strong>${escapeHtml(usuarioIg)}</strong> ${legendaHtml.replace(/\n/g, '<br>')}</div>`;
}

function coletarCamposPost() {
  return {
    titulo: document.getElementById('mkt-titulo').value.trim(),
    legenda: document.getElementById('mkt-legenda').value,
    data_agendada: inputSpParaIso(document.getElementById('mkt-data').value)
  };
}

// Cria o post (rascunho) na primeira imagem enviada: as imagens são guardadas no post
async function garantirPostMarketing() {
  if (_mktPost) return _mktPost;
  const r = await mktJson(`${API_URL}/marketing/posts`, 'POST', coletarCamposPost());
  if (!r.ok) { alert(r.dados.erro || 'Erro ao criar o post.'); return null; }
  _mktPost = r.dados;
  _mktCriadoNoEditor = true;
  _mktAlterado = true;
  return _mktPost;
}

async function enviarImagensMarketing(lista) {
  const arquivos = [...lista].filter(f => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!arquivos.length) { alert('Escolha imagens PNG, JPEG ou WebP.'); return; }
  const grande = arquivos.find(f => f.size > 8 * 1024 * 1024);
  if (grande) { alert(`${grande.name} passa de 8 MB.`); return; }
  const atuais = _mktPost ? _mktPost.midias.length : 0;
  if (atuais + arquivos.length > MKT_IMAGENS_MAX) { alert(`O post aceita até ${MKT_IMAGENS_MAX} imagens (já tem ${atuais}).`); return; }
  const p = await garantirPostMarketing();
  if (!p) return;
  const envio = document.getElementById('mkt-envio');
  envio.hidden = false;
  envio.textContent = `Enviando e convertendo ${arquivos.length} imagem(ns)...`;
  const form = new FormData();
  arquivos.forEach(f => form.append('imagens', f, f.name));
  try {
    const res = await mktEnviarForm(`${API_URL}/marketing/posts/${p.id}/midias`, form);
    if (!res) return;
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) { alert(corpo.erro || `Falha no envio (HTTP ${res.status}).`); return; }
    _mktPost = corpo;
    _mktAlterado = true;
    renderEditor();
  } finally {
    envio.hidden = true;
    document.getElementById('mkt-arquivos').value = '';
  }
}

async function moverMidiaMarketing(i, delta) {
  const ids = _mktPost.midias.map(m => m.id);
  const j = i + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const r = await mktJson(`${API_URL}/marketing/posts/${_mktPost.id}/midias/ordem`, 'PUT', { ids });
  if (!r.ok) { alert(r.dados.erro); return; }
  _mktPost = r.dados;
  _mktSlide = j;
  _mktAlterado = true;
  renderEditor();
}

async function removerMidiaMarketing(mid) {
  if (!confirm('Remover esta imagem do post?')) return;
  const r = await mktJson(`${API_URL}/marketing/posts/${_mktPost.id}/midias/${mid}`, 'DELETE');
  if (!r.ok) { alert(r.dados.erro); return; }
  _mktPost = r.dados;
  _mktAlterado = true;
  renderEditor();
}

async function salvarPostMarketing(status) {
  const campos = coletarCamposPost();
  if (status === 'agendado' && !campos.data_agendada) { alert('Informe a data e a hora para agendar.'); return; }
  const p = await garantirPostMarketing();
  if (!p) return;
  const r = await mktJson(`${API_URL}/marketing/posts/${p.id}`, 'PUT', { ...campos, status });
  if (!r.ok) { alert(r.dados.erro || 'Erro ao salvar.'); return; }
  _mktPost = r.dados;
  _mktAlterado = true;
  _mktCriadoNoEditor = false;
  fecharEditorPost();
}

async function publicarAgoraMarketing() {
  if (!confirm('Publicar este post agora no Instagram?')) return;
  const p = await garantirPostMarketing();
  if (!p) return;
  const salvo = await mktJson(`${API_URL}/marketing/posts/${p.id}`, 'PUT', { ...coletarCamposPost(), status: 'rascunho' });
  if (!salvo.ok) { alert(salvo.dados.erro || 'Erro ao salvar antes de publicar.'); return; }
  _mktCriadoNoEditor = false;
  const acoes = document.getElementById('mkt-editor-acoes');
  acoes.querySelectorAll('button').forEach(b => { b.disabled = true; });
  const envio = document.getElementById('mkt-envio');
  envio.hidden = false;
  envio.textContent = 'Publicando no Instagram... (pode levar alguns segundos)';
  const r = await mktJson(`${API_URL}/marketing/posts/${p.id}/publicar-agora`, 'POST');
  envio.hidden = true;
  _mktAlterado = true;
  if (r.dados.post) _mktPost = r.dados.post;
  else { const g = await mktJson(`${API_URL}/marketing/posts/${p.id}`); if (g.ok) _mktPost = g.dados; }
  alert(r.ok ? r.dados.mensagem : (r.dados.erro || 'Falha ao publicar.'));
  renderEditor();
}

async function cancelarPostMarketing() {
  if (!confirm('Cancelar este post? Ele não será publicado (fica na lista como cancelado).')) return;
  const r = await mktJson(`${API_URL}/marketing/posts/${_mktPost.id}/cancelar`, 'POST');
  if (!r.ok) { alert(r.dados.erro); return; }
  _mktAlterado = true;
  _mktCriadoNoEditor = false;
  fecharEditorPost();
}

async function duplicarPostMarketing() {
  const r = await mktJson(`${API_URL}/marketing/posts/${_mktPost.id}/duplicar`, 'POST');
  if (!r.ok) { alert(r.dados.erro); return; }
  _mktAlterado = true;
  await abrirEditorPost(r.dados.id);
}

async function excluirPostMarketing() {
  if (!confirm('Excluir este post e as imagens dele? Não dá para desfazer.')) return;
  const r = await mktJson(`${API_URL}/marketing/posts/${_mktPost.id}`, 'DELETE');
  if (!r.ok) { alert(r.dados.erro); return; }
  _mktPost = null;
  _mktAlterado = true;
  fecharEditorPost();
}

// Fecha o editor; post criado aqui só pelo upload e que ficou vazio é descartado
async function fecharEditorPost() {
  const p = _mktPost;
  if (p && _mktCriadoNoEditor && !p.midias.length && !document.getElementById('mkt-titulo').value.trim() &&
      !document.getElementById('mkt-legenda').value.trim()) {
    await mktJson(`${API_URL}/marketing/posts/${p.id}`, 'DELETE');
  }
  _mktCriadoNoEditor = false;
  closeModal(document.getElementById('modal-mkt-post'));
  if (_mktAlterado) { _mktAlterado = false; if (currentPage === 'marketing-calendario') loadCalendarioMarketing(); }
}

function iniciarDropzoneMarketing() {
  const zona = document.getElementById('mkt-dropzone');
  const input = document.getElementById('mkt-arquivos');
  if (!zona || !input) return;
  zona.addEventListener('click', () => input.click());
  zona.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { if (input.files.length) enviarImagensMarketing(input.files); });
  ['dragenter', 'dragover'].forEach(ev => zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.remove('dragover'); }));
  zona.addEventListener('drop', e => { if (e.dataTransfer.files.length) enviarImagensMarketing(e.dataTransfer.files); });
  // Fechar pelo fundo do modal também passa pelo descarte do post vazio
  const modal = document.getElementById('modal-mkt-post');
  modal.addEventListener('mouseup', e => { if (e.target === modal && _mktCriadoNoEditor) fecharEditorPost(); });
}

// =================== IMPORTAR AGENDA ===================
function abrirImportarAgenda() {
  _mktImportacao = null;
  document.getElementById('mkt-importar-arquivos').value = '';
  document.getElementById('mkt-importar-pasta').value = '';
  document.getElementById('mkt-importar-resumo').innerHTML = '';
  document.getElementById('mkt-btn-importar').disabled = true;
  showModal('#modal-mkt-importar');
}

async function lerArquivosAgenda(lista) {
  const arquivos = [...lista];
  const resumo = document.getElementById('mkt-importar-resumo');
  const btn = document.getElementById('mkt-btn-importar');
  btn.disabled = true;
  _mktImportacao = null;
  const agendaArq = arquivos.find(f => f.name.toLowerCase() === 'agenda.json');
  if (!agendaArq) { resumo.innerHTML = '<p class="fin-aviso">Não encontrei o <code>agenda.json</code> entre os arquivos escolhidos.</p>'; return; }
  const texto = await agendaArq.text();
  let agenda;
  try { agenda = JSON.parse(texto.replace(/^﻿/, '')); } catch (e) {
    resumo.innerHTML = `<p class="fin-aviso">O agenda.json não é um JSON válido: ${escapeHtml(e.message)}</p>`; return;
  }
  const posts = agenda && Array.isArray(agenda.posts) ? agenda.posts : [];
  if (!posts.length) { resumo.innerHTML = '<p class="fin-aviso">O agenda.json não tem a lista "posts".</p>'; return; }
  const imagens = new Map(arquivos.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name)).map(f => [f.name.toLowerCase(), f]));
  const usadas = new Map();
  const faltando = new Set();
  let problemas = 0;
  const agora = Date.now();
  const datas = [];
  const linhas = posts.map((p, i) => {
    const avisos = [];
    let s = String(p.data || '');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) s += '-03:00';
    const d = new Date(s);
    const dataOk = p.data && !isNaN(d.getTime());
    if (!dataOk) { avisos.push('data inválida'); problemas++; } else datas.push(d);
    const imgs = Array.isArray(p.imagens) ? p.imagens.map(String) : [];
    if (!imgs.length || imgs.length > MKT_IMAGENS_MAX) { avisos.push('1 a 10 imagens'); problemas++; }
    imgs.forEach(n => {
      const k = n.split(/[\\/]/).pop().toLowerCase();
      if (imagens.has(k)) usadas.set(k, imagens.get(k)); else { faltando.add(n); avisos.push(`falta ${n}`); problemas++; }
    });
    const leg = String(p.legenda || '');
    if (leg.length > MKT_LEGENDA_MAX) { avisos.push(`legenda com ${leg.length} caracteres`); problemas++; }
    if (contarHashtagsMkt(leg) > MKT_HASHTAGS_MAX) { avisos.push(`${contarHashtagsMkt(leg)} hashtags`); problemas++; }
    const situacao = avisos.length ? `<span class="fin-erro">${escapeHtml(avisos.join(' · '))}</span>`
      : (d.getTime() > agora + 60000 ? pillMkt('agendado') : `${pillMkt('rascunho')} <small class="fin-muted">data já passou</small>`);
    return `<tr>
      <td data-label="#">${i + 1}</td>
      <td data-label="Data">${dataOk ? escapeHtml(dataHoraSp(d)) : escapeHtml(p.data || '—')}</td>
      <td data-label="Título">${escapeHtml(p.titulo || '—')}</td>
      <td data-label="Imagens">${imgs.length}${imgs.length > 1 ? ' (carrossel)' : ''}</td>
      <td data-label="Situação">${situacao}</td></tr>`;
  });
  datas.sort((a, b) => a - b);
  resumo.innerHTML = `
    <div class="mkt-importar-totais">
      <span><strong>${posts.length}</strong> post(s)</span>
      ${datas.length ? `<span>de <strong>${escapeHtml(dataHoraSp(datas[0]).slice(0, 10))}</strong> a <strong>${escapeHtml(dataHoraSp(datas[datas.length - 1]).slice(0, 10))}</strong></span>` : ''}
      <span><strong>${usadas.size}</strong> imagem(ns) encontrada(s)</span>
      ${faltando.size ? `<span class="fin-erro">${faltando.size} faltando: ${escapeHtml([...faltando].join(', '))}</span>` : ''}
    </div>
    <div class="table-container"><table>
      <thead><tr><th>#</th><th>Data (Brasília)</th><th>Título</th><th>Imagens</th><th>Situação</th></tr></thead>
      <tbody>${linhas.join('')}</tbody></table></div>
    ${problemas ? '<p class="fin-aviso">Corrija os itens marcados (ou selecione os arquivos que faltam) para importar.</p>' : ''}`;
  if (!problemas) {
    _mktImportacao = { agendaTexto: texto, arquivos: [...usadas.values()] };
    btn.disabled = false;
  }
}

async function confirmarImportacaoAgenda() {
  if (!_mktImportacao) return;
  const btn = document.getElementById('mkt-btn-importar');
  const resumo = document.getElementById('mkt-importar-resumo');
  btn.disabled = true;
  const form = new FormData();
  form.append('agenda', _mktImportacao.agendaTexto);
  _mktImportacao.arquivos.forEach(f => form.append('imagens', f, f.name));
  const aviso = document.createElement('p');
  aviso.className = 'fin-muted';
  aviso.textContent = `Enviando ${_mktImportacao.arquivos.length} imagem(ns) e criando os posts...`;
  resumo.prepend(aviso);
  const res = await mktEnviarForm(`${API_URL}/marketing/importar`, form);
  if (!res) return;
  const corpo = await res.json().catch(() => ({}));
  aviso.remove();
  if (!res.ok) {
    resumo.insertAdjacentHTML('afterbegin', `<div class="fin-aviso"><strong>${escapeHtml(corpo.erro || 'Falha na importação.')}</strong>
      ${(corpo.erros || []).length ? `<ul>${corpo.erros.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}</div>`);
    btn.disabled = false;
    return;
  }
  _mktImportacao = null;
  resumo.innerHTML = `<p class="mkt-ok">${escapeHtml(corpo.mensagem)}</p>`;
  if (corpo.criados && corpo.criados.length) {
    // leva o calendário para o mês do primeiro post importado
    const primeiro = await mktJson(`${API_URL}/marketing/posts/${corpo.criados[0].id}`);
    if (primeiro.ok && primeiro.dados.data_agendada) {
      const pp = partesSp(primeiro.dados.data_agendada);
      _mktMes = { ano: Number(pp.ano), mes: Number(pp.mes) };
    }
  }
  if (currentPage === 'marketing-calendario') loadCalendarioMarketing();
}

// =================== MÉTRICAS ===================
let _mktMetricas = null;

async function loadMetricasMarketing() {
  document.getElementById('mkt-tiles').innerHTML = '<p class="fin-muted">Carregando...</p>';
  const r = await mktJson(`${API_URL}/marketing/metricas`);
  if (!r.ok) { document.getElementById('mkt-tiles').innerHTML = `<p class="fin-muted">${escapeHtml(r.dados.erro || 'Erro ao carregar.')}</p>`; return; }
  _mktMetricas = r.dados;
  renderMetricasMarketing();
}

function renderMetricasMarketing() {
  const d = _mktMetricas;
  if (!d) return;
  const delta = (v, rotulo) => v == null ? '' :
    `<span class="rel-delta ${v >= 0 ? 'sobe' : 'desce'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toLocaleString('pt-BR')} ${rotulo}</span>`;
  const tile = (rotulo, valor, detalhe, extra = '') => `
    <div class="rel-tile"><span class="rel-tile-rotulo">${rotulo}</span><span class="rel-tile-valor">${valor}</span>${extra}
      <span class="rel-tile-detalhe">${detalhe}</span></div>`;
  const semConta = !d.conta || !d.conta.conectada;
  document.getElementById('mkt-tiles').innerHTML = (semConta ? `<p class="fin-aviso mkt-tiles-aviso">Conta do Instagram não conectada.
      <a href="#" onclick="showPage('marketing-conta'); return false;">Conectar →</a></p>` : '') + [
    tile('Seguidores', numBr(d.seguidores), d.variacao_30d != null ? `${d.variacao_30d >= 0 ? '+' : ''}${d.variacao_30d.toLocaleString('pt-BR')} em 30 dias` : 'variação aparece com o histórico',
      delta(d.variacao_7d, 'em 7 dias')),
    tile('Publicados no mês', numBr(d.publicados_mes), `${d.posts_30d} nos últimos 30 dias`),
    tile('Alcance (30 dias)', numBr(d.alcance_30d), 'contas alcançadas, somando os posts'),
    tile('Interações (30 dias)', numBr(d.interacoes_30d), 'curtidas, comentários, salvamentos e compart.')
  ].join('');
  graficoSeguidoresMarketing(document.getElementById('mkt-graf-seguidores'), d.historico_seguidores);
  const tbody = document.getElementById('mkt-metricas-tbody');
  tbody.innerHTML = d.posts.length ? d.posts.map(p => `
    <tr>
      <td data-label="Post"><span class="mkt-metrica-post">
        ${p.capa_url ? `<img src="${escapeHtml(p.capa_url)}" alt="" loading="lazy">` : '<span class="mkt-chip-semimg"></span>'}
        <span><strong>${escapeHtml(p.titulo || `Post #${p.id}`)}</strong>${p.tipo === 'carrossel' ? '<span class="fin-sub">Carrossel</span>' : ''}</span></span></td>
      <td data-label="Publicado em">${escapeHtml(dataHoraSp(p.data_publicacao))}</td>
      <td data-label="Alcance" class="fin-num">${numBr(p.alcance)}</td>
      <td data-label="Curtidas" class="fin-num">${numBr(p.curtidas)}</td>
      <td data-label="Comentários" class="fin-num">${numBr(p.comentarios)}</td>
      <td data-label="Salvamentos" class="fin-num">${numBr(p.salvamentos)}</td>
      <td data-label="Compart." class="fin-num">${numBr(p.compartilhamentos)}</td>
      <td data-label="Link">${p.permalink ? `<a href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener">Abrir ↗</a>` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-center">Nenhum post publicado ainda.</td></tr>';
}

// Linha simples em SVG (cores --viz-* dos relatórios); eixo Y não começa no zero: mostra a variação
function graficoSeguidoresMarketing(el, pontos) {
  if (!pontos || pontos.length < 2) {
    el.innerHTML = '<p class="fin-muted mkt-graf-vazio">O gráfico aparece a partir do segundo dia com a conta conectada (a leitura é diária).</p>';
    return;
  }
  const W = Math.max(el.clientWidth, 280), H = 220;
  const m = { t: 18, r: 14, b: 26, l: 52 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = pontos.map(p => p.seguidores);
  let min = Math.min(...vals), max = Math.max(...vals);
  const passo = escalaPasso(Math.max(1, (max - min) / 4));
  min = Math.floor(min / passo) * passo;
  max = Math.max(min + passo, Math.ceil(max / passo) * passo);
  const t0 = Date.parse(pontos[0].data), t1 = Date.parse(pontos[pontos.length - 1].data);
  const x = p => m.l + (t1 === t0 ? iw / 2 : ((Date.parse(p.data) - t0) / (t1 - t0)) * iw);
  const y = v => m.t + ih - ((v - min) / (max - min)) * ih;
  let svg = '';
  for (let v = min; v <= max + passo / 2; v += passo) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="${v === min ? 'viz-base' : 'viz-grade'}"/>
            <text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" class="viz-eixo">${Math.round(v).toLocaleString('pt-BR')}</text>`;
  }
  const marcas = [0, Math.floor((pontos.length - 1) / 2), pontos.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  marcas.forEach(i => {
    svg += `<text x="${x(pontos[i])}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === pontos.length - 1 ? 'end' : 'middle'}" class="viz-eixo">${diaBrCurto(pontos[i].data)}</text>`;
  });
  svg += `<path d="${pontos.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.seguidores).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--viz-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  pontos.forEach(p => {
    svg += `<circle cx="${x(p)}" cy="${y(p.seguidores)}" r="${pontos.length > 40 ? 2 : 3}" fill="var(--viz-1)"><title>${diaBrCurto(p.data)}: ${p.seguidores.toLocaleString('pt-BR')} seguidores</title></circle>`;
  });
  const u = pontos[pontos.length - 1];
  svg += `<text x="${x(u) - 6}" y="${y(u.seguidores) - 8}" text-anchor="end" class="viz-rotulo">${u.seguidores.toLocaleString('pt-BR')}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" aria-hidden="true">${svg}</svg>`;
}

async function atualizarMetricasMarketing() {
  const btn = document.getElementById('mkt-btn-atualizar-metricas');
  btn.disabled = true;
  btn.textContent = 'Atualizando...';
  const r = await mktJson(`${API_URL}/marketing/metricas/atualizar`, 'POST');
  btn.disabled = false;
  btn.textContent = 'Atualizar agora';
  alert(r.ok ? r.dados.mensagem : (r.dados.erro || 'Falha ao atualizar.'));
  loadMetricasMarketing();
}

// =================== CONTA ===================
async function loadContaMarketing() {
  const alvo = document.getElementById('mkt-conta-status');
  const r = await mktJson(`${API_URL}/marketing/conta`);
  if (!r.ok) { alvo.innerHTML = `<p class="fin-muted">${escapeHtml(r.dados.erro || 'Erro ao carregar.')}</p>`; return; }
  const c = r.dados;
  _mktUsername = c.username;
  const avisos = [];
  if (!c.cifra_configurada) avisos.push('O servidor está sem <code>MARKETING_CHAVE_CIFRA</code>: configure no Render (veja o README) para conectar a conta.');
  if (!c.storage) avisos.push('Storage (S3/R2) não configurado no servidor: sem ele não há como enviar imagens nem publicar.');
  let corpo;
  if (c.conectada) {
    const dias = c.token_expira_em ? Math.ceil((new Date(c.token_expira_em) - Date.now()) / 86400000) : null;
    corpo = `
      <dl class="mkt-conta-dados">
        <dt>Conta</dt><dd><a href="https://www.instagram.com/${encodeURIComponent(c.username || '')}/" target="_blank" rel="noopener">@${escapeHtml(c.username || '?')}</a> <span class="fin-pill" style="--pill:#2e7d4f">Conectada</span></dd>
        <dt>Seguidores</dt><dd>${numBr(c.seguidores)}</dd>
        <dt>Token válido até</dt><dd>${c.token_expira_em ? escapeHtml(dataHoraSp(c.token_expira_em).slice(0, 10)) : '—'}
          ${dias != null ? `<small class="${dias < 10 ? 'fin-erro' : 'fin-muted'}">(${dias} dia(s); renova sozinho)</small>` : ''}</dd>
        <dt>Atualizado em</dt><dd>${escapeHtml(dataHoraSp(c.atualizado_em))}</dd>
      </dl>`;
  } else {
    corpo = '<p class="fin-muted">Nenhuma conta conectada. Cole o token abaixo.</p>';
  }
  alvo.innerHTML = avisos.map(a => `<p class="fin-aviso">${a}</p>`).join('') + corpo;
  document.getElementById('mkt-btn-conectar').textContent = c.conectada ? 'Trocar token' : 'Conectar';
  document.getElementById('mkt-btn-conectar').disabled = !c.cifra_configurada;
  document.getElementById('mkt-btn-testar').disabled = !c.conectada;
  document.getElementById('mkt-btn-desconectar').hidden = !c.conectada;
}

async function conectarContaMarketing(ev) {
  ev.preventDefault();
  const campo = document.getElementById('mkt-token');
  const valor = campo.value.trim();
  if (!valor) { alert('Cole o token de acesso.'); return; }
  const btn = document.getElementById('mkt-btn-conectar');
  btn.disabled = true;
  const r = await mktJson(`${API_URL}/marketing/conta`, 'POST', { token: valor });
  btn.disabled = false;
  if (r.ok) campo.value = '';
  alert(r.ok ? r.dados.mensagem : (r.dados.erro || 'Falha ao conectar.'));
  loadContaMarketing();
}

async function testarContaMarketing() {
  const btn = document.getElementById('mkt-btn-testar');
  btn.disabled = true;
  const r = await mktJson(`${API_URL}/marketing/conta/testar`, 'POST');
  btn.disabled = false;
  alert(r.ok ? r.dados.mensagem : (r.dados.erro || 'Falha no teste.'));
  loadContaMarketing();
}

async function desconectarContaMarketing() {
  if (!confirm('Desconectar a conta do Instagram? Os posts agendados não serão publicados até conectar de novo.')) return;
  const r = await mktJson(`${API_URL}/marketing/conta`, 'DELETE');
  alert(r.ok ? r.dados.mensagem : (r.dados.erro || 'Falha ao desconectar.'));
  loadContaMarketing();
}

// =================== INÍCIO ===================
document.addEventListener('DOMContentLoaded', () => {
  // Marketing é só dos administradores: técnico não vê o grupo
  if (!usuario || !['admin_empresa', 'admin_sistema'].includes(usuario.tipo)) {
    const g = document.querySelector('.nav-group[data-grupo="marketing"]');
    if (g) g.hidden = true;
  }
  iniciarDropzoneMarketing();
});

let _mktResize;
window.addEventListener('resize', () => {
  clearTimeout(_mktResize);
  _mktResize = setTimeout(() => {
    if (_mktMetricas && document.getElementById('marketing-metricas-page').classList.contains('active')) renderMetricasMarketing();
  }, 200);
});
