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
  document.getElementById('welcome-empresa').textContent = 'Tudo da sua empresa com a Marsh: chamados, licenças, cursos e faturas.';

  const iniciais = usuario.nome.split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  document.getElementById('usuario-avatar').textContent = iniciais || '··';

  inicializarDropzone();
  iniciarNavegacaoPortal();
  carregarPortal().then(atualizarMenuPortal);

  // Botão Minha conta → abre modal com tema e senha
  const btnAp = document.getElementById('btn-aparencia');
  if (btnAp) btnAp.addEventListener('click', abrirAparencia);
});

// ===== NAVEGAÇÃO (mesmo desenho do sistema: menu lateral, páginas, barra de baixo e gaveta no celular) =====
// Cada tela do menu só aparece se a pessoa tem aquilo: a seção correspondente (secao-*) deixa de estar hidden
// quando os dados chegam. Quem só usa licença (papel "aluno") vê só os próprios chamados.
const TELAS_PORTAL = {
  inicio:          { titulo: 'Início' },
  chamados:        { titulo: 'Chamados', resumo: 'Abra e acompanhe chamados de suporte' },
  treinamentos:    { titulo: 'Treinamentos', secao: 'secao-treinamentos', resumo: 'Seus cursos e o progresso' },
  'minha-licenca': { titulo: 'Minha licença', secao: 'secao-minha-licenca', resumo: 'Certificado, chave e instalador do Conector' },
  empresa:         { titulo: 'Licenças da empresa', secao: 'secao-contrato', resumo: 'Convide pessoas e distribua as licenças' },
  conector:        { titulo: 'Conector SAP', secao: 'secao-licenca', resumo: 'Chave da empresa e instalador' },
  financeiro:      { titulo: 'Financeiro', secao: 'secao-financeiro', resumo: 'Faturas e notas fiscais' },
  pedidos:         { titulo: 'Meus pedidos', secao: 'secao-pedidos', resumo: 'Compras na loja de cursos' }
};
let telaAtual = 'inicio';

function mostrarTela(tela, { semHistorico = false } = {}) {
  if (!TELAS_PORTAL[tela] || !document.getElementById(`${tela}-page`)) return;
  if (!semHistorico && tela !== telaAtual) history.pushState({ tela }, '', `#${tela}`);
  telaAtual = tela;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `${tela}-page`));
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === tela));
  const menu = document.getElementById('btn-menu-mobile');
  if (menu) menu.classList.toggle('active', !document.querySelector(`.bottom-nav-item[data-page="${tela}"]`));
  document.getElementById('page-title').textContent = TELAS_PORTAL[tela].titulo;
  window.scrollTo({ top: 0 });
}

const telasVisiveis = () => [...document.querySelectorAll('.sidebar .nav-link[data-page]')].filter(l => !l.hidden);

// Depois de carregar: mostra no menu só as telas com conteúdo, monta a barra de baixo e os atalhos do Início
function atualizarMenuPortal() {
  const aluno = acessoPortal.papel === 'aluno';
  document.querySelectorAll('.sidebar .nav-link[data-page]').forEach(l => {
    const t = TELAS_PORTAL[l.dataset.page];
    if (t.secao) l.hidden = document.getElementById(t.secao).hidden;
  });
  document.getElementById('usuario-papel').textContent = aluno ? 'Usuário de licença'
    : acessoPortal.gestor ? 'Administrador da empresa' : 'Portal do Cliente';

  // Barra de baixo: as 4 primeiras telas + Menu (com a gaveta das demais)
  const links = telasVisiveis();
  const barra = document.getElementById('bottom-nav');
  barra.innerHTML = links.slice(0, 4).map(l => `
    <button class="bottom-nav-item" data-page="${l.dataset.page}" type="button">
      <span class="bn-icon">${l.querySelector('svg.icon').outerHTML}</span>
      <span>${escapeHtml(TELAS_PORTAL[l.dataset.page].titulo.replace('Licenças da empresa', 'Empresa').replace('Minha licença', 'Licença'))}</span>
    </button>`).join('') + `
    <button class="bottom-nav-item bottom-nav-menu" id="btn-menu-mobile" type="button" aria-haspopup="dialog" aria-controls="menu-mobile">
      <span class="bn-icon"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span>
      <span>Menu</span>
    </button>`;
  barra.querySelectorAll('.bottom-nav-item[data-page]').forEach(b => b.addEventListener('click', () => mostrarTela(b.dataset.page)));
  document.getElementById('btn-menu-mobile').addEventListener('click', () => {
    const menu = document.getElementById('menu-mobile');
    menu.hidden ? abrirMenuMobile() : fecharMenuMobile();
  });

  // Atalhos do Início: um cartão por tela que a pessoa tem
  document.getElementById('portal-atalhos').innerHTML = links.filter(l => l.dataset.page !== 'inicio').map(l => {
    const t = TELAS_PORTAL[l.dataset.page];
    return `<button type="button" class="portal-atalho" onclick="mostrarTela('${l.dataset.page}')">
      <span class="portal-atalho-icone">${l.querySelector('svg.icon').outerHTML}</span>
      <span><strong>${escapeHtml(t.titulo)}</strong><small>${escapeHtml(t.resumo || '')}</small></span>
    </button>`;
  }).join('');

  // Abrir já numa tela pelo endereço (ex.: /portal.html#treinamentos), se ela existir para a pessoa
  const inicial = decodeURIComponent(location.hash.slice(1));
  history.replaceState({ tela: 'inicio' }, '', location.pathname);
  if (inicial && links.some(l => l.dataset.page === inicial)) mostrarTela(inicial);
  else mostrarTela(telaAtual, { semHistorico: true });
}

function iniciarNavegacaoPortal() {
  document.querySelectorAll('.sidebar .nav-link[data-page]').forEach(l =>
    l.addEventListener('click', e => { e.preventDefault(); mostrarTela(l.dataset.page); }));
  const menu = document.getElementById('menu-mobile');
  menu.querySelectorAll('[data-fechar-menu]').forEach(el => el.addEventListener('click', fecharMenuMobile));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharMenuMobile(); });
  // Voltar do navegador (e o gesto do iPhone) volta para a tela anterior em vez de sair do portal
  window.addEventListener('popstate', e => {
    fecharMenuMobile();
    mostrarTela((e.state && e.state.tela) || 'inicio', { semHistorico: true });
  });
}

// Gaveta do celular: todas as telas do menu lateral
function abrirMenuMobile() {
  const corpo = document.getElementById('menu-mobile-corpo');
  corpo.innerHTML = `<section class="menu-mobile-secao"><div class="menu-mobile-grade">${telasVisiveis().map(l => `
    <button type="button" class="menu-mobile-item${l.dataset.page === telaAtual ? ' active' : ''}" data-page="${l.dataset.page}">
      ${l.querySelector('svg.icon').outerHTML}<span>${escapeHtml(TELAS_PORTAL[l.dataset.page].titulo)}</span>
    </button>`).join('')}</div></section>`;
  corpo.querySelectorAll('.menu-mobile-item').forEach(b => b.addEventListener('click', () => { fecharMenuMobile(); mostrarTela(b.dataset.page); }));
  document.getElementById('menu-mobile-usuario').textContent = usuario.nome;
  const menu = document.getElementById('menu-mobile');
  menu.hidden = false;
  document.body.classList.add('menu-mobile-aberto');
  requestAnimationFrame(() => menu.classList.add('aberto'));
}

function fecharMenuMobile() {
  const menu = document.getElementById('menu-mobile');
  if (!menu || menu.hidden) return;
  menu.classList.remove('aberto');
  document.body.classList.remove('menu-mobile-aberto');
  setTimeout(() => { if (!menu.classList.contains('aberto')) menu.hidden = true; }, 220);
}

// Botão do cabeçalho: alterna entre o Sereno claro e o escuro (igual ao sistema)
function alternarClaroEscuro() {
  if (!window.Theme) return;
  Theme.set(['sereno-escuro', 'dark'].includes(Theme.get()) ? 'sereno' : 'sereno-escuro');
}

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
// Usuário de vaga do Conector (papel "aluno") vê os próprios treinamentos e só os chamados que ele abriu;
// o gestor do contrato vê tudo da empresa e mais a seção do contrato (vagas e sistemas SAP).
let acessoPortal = { papel: null, gestor: false, vagas: [] };

async function carregarAcesso() {
  const r = await apiFetch(`${API}/contratos-conector/eu`);
  if (r && r.ok) acessoPortal = await r.json();
  renderMinhasVagas();
}

async function carregarPortal() {
  await carregarAcesso();
  if (acessoPortal.papel === 'aluno') {
    // Quem tem vaga vê os próprios treinamentos e abre/acompanha só os próprios chamados (o servidor filtra)
    document.body.classList.add('so-aluno');
    const perfis = [...new Set(acessoPortal.vagas.map(v => v.perfil_nome))].join(' e ');
    document.getElementById('welcome-empresa').textContent = perfis
      ? `Seus treinamentos do Conector SAP — perfil ${perfis}` : 'Seus treinamentos do Conector SAP';
    await Promise.all([carregarTreinamentos(), carregarPedidosPortal(), carregarChamados(), carregarSistemasSap()]);
    if (!cursosPortal.length) {
      const secao = document.getElementById('secao-treinamentos');
      secao.hidden = false;
      document.getElementById('lista-cursos').innerHTML =
        '<div class="empty-state"><p>Nenhum curso liberado no momento. Fale com o responsável pelo contrato.</p></div>';
    }
    return;
  }
  await Promise.all([
    carregarChamados(),
    carregarSistemasSap(),
    carregarTreinamentos(),
    carregarLicencasPortal(),
    carregarFinanceiroPortal(),
    acessoPortal.gestor ? carregarContratosPortal() : null,
    carregarPedidosPortal()
  ]);
}

// ===== MINHA LICENÇA DO CONECTOR (quem ocupa vaga) =====
// Antes do certificado: o que falta por trilha. Depois (ou antes, se o contrato libera a licença sem curso):
// certificado, chave, máquina e o instalador já configurado.
function renderMinhasVagas() {
  const vagas = acessoPortal.vagas || [];
  const secao = document.getElementById('secao-minha-licenca');
  secao.hidden = !vagas.length;
  if (!vagas.length) return;
  const lista = document.getElementById('lista-minhas-vagas');
  lista.classList.toggle('uma-coluna', vagas.length === 1);
  const br = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
  const planos = { leitura: 'Leitura (consulta)', desenvolvimento: 'Desenvolvimento (com gravação)' };
  lista.innerHTML = vagas.map(v => {
    const p = v.progresso || { trilhas: [], total: 0, feitas: 0 };
    const pct = p.total ? Math.round(100 * p.feitas / p.total) : 0;
    const titulo = `<h4>Perfil ${escapeHtml(v.perfil_nome)}
      ${v.vigente ? '' : '<span class="chip" style="background:#ef444420; color:#ef4444">Contrato inativo</span>'}</h4>`;
    if (!v.certificado && !v.licenca) {
      return `
        <div class="licenca-card minha-vaga">
          ${titulo}
          <p class="ajuda" style="margin-top:0">${p.trilhas.length
            ? 'Conclua todas as aulas destes cursos para receber o certificado, a sua licença e o instalador do Conector.'
            : 'Os cursos deste perfil estão sendo preparados. Assim que forem publicados, eles aparecem aqui e em Treinamentos.'}</p>
          <ul class="trilhas">${p.trilhas.map(t => {
            const tot = t.cursos.reduce((s, c) => s + c.total, 0);
            const fei = t.cursos.reduce((s, c) => s + Math.min(c.feitas, c.total), 0);
            return `<li><span>${t.concluida ? '<span class="ok">✓</span> ' : ''}${escapeHtml(t.nome)}</span>
              <strong>${t.cursos.length ? `${fei} de ${tot} aulas` : 'em breve'}</strong></li>`;
          }).join('')}</ul>
          <div class="barra-curso"><i style="width:${pct}%"></i></div>
          <div class="linha"><span>Progresso geral</span><strong>${p.feitas} de ${p.total} aulas (${pct}%)</strong></div>
        </div>`;
    }
    const l = v.licenca;
    const st = !l ? ['Sem licença', '#64748b'] : l.status === 'ativa' && l.vigente ? ['Ativa', '#10b981']
      : l.status === 'suspensa' ? ['Suspensa', '#f59e0b'] : ['Inativa', '#ef4444'];
    return `
      <div class="licenca-card minha-vaga">
        ${titulo}
        <div class="linha"><span>Certificado</span><strong>${v.certificado ? `✓ ${escapeHtml(v.certificado.codigo)}` : `ao concluir os cursos (${p.feitas} de ${p.total} aulas)`}</strong></div>
        ${l ? `
          <div class="linha"><span>Licença</span><strong><span class="chip" style="background:${st[1]}20; color:${st[1]}">${st[0]}</span></strong></div>
          <div class="linha"><span>Plano</span><strong>${escapeHtml(planos[l.plano] || l.plano)}</strong></div>
          <div class="linha"><span>Válida até</span><strong>${br(l.data_fim)}</strong></div>
          <div class="linha"><span>Sistemas SAP</span><strong>${escapeHtml(String(l.sids || '').replace(/,/g, ', ') || 'a cadastrar pelo gestor')}</strong></div>
          <div class="linha"><span>Máquina</span><strong>${l.maquina_nome ? escapeHtml(l.maquina_nome) : 'nenhuma ativada ainda'}</strong></div>
          <div class="chave-box">
            <code>${l.chave ? escapeHtml(l.chave) : `${escapeHtml(l.chave_prefixo)}-…`}</code>
            ${l.chave ? `<button type="button" onclick="copiarChave(this, '${escapeHtml(l.chave)}')">Copiar</button>` : ''}
          </div>
          ${l.chave ? '' : '<p class="ajuda">A chave completa não está disponível aqui; peça à Marsh.</p>'}` : ''}
        <div class="acoes">
          ${v.certificado ? `<a class="btn-curso secundario" href="/certificado.html?c=${encodeURIComponent(v.certificado.codigo)}" target="_blank" rel="noopener">Ver certificado</a>` : ''}
          ${l && st[0] === 'Ativa' ? `<button type="button" class="btn-curso" onclick="baixarPacoteVaga(this, ${v.id})">Baixar instalador</button>` : ''}
        </div>
        ${l && st[0] === 'Ativa' ? `<p class="ajuda">Descompacte o zip e execute <strong>Instalar.cmd</strong>. A sua chave já vai dentro do instalador:
          você só informa o seu usuário e senha do SAP. A licença vale para 1 computador; para trocar, fale com o responsável pelo contrato.</p>` : ''}
      </div>`;
  }).join('');
}

function copiarChave(btn, chave) {
  const ok = () => { btn.textContent = 'Copiada'; setTimeout(() => { btn.textContent = 'Copiar'; }, 1800); };
  if (navigator.clipboard) navigator.clipboard.writeText(chave).then(ok).catch(() => prompt('Copie a chave:', chave));
  else prompt('Copie a chave:', chave);
}

async function baixarPacoteVaga(btn, vagaId) {
  btn.disabled = true;
  try {
    const res = await apiFetch(`${API}/contratos-conector/eu/vagas/${vagaId}/pacote`);
    if (!res) return;
    const r = await res.json();
    if (!res.ok || !r.url) { alert(r.erro || 'Instalador em preparação. Fale com a Marsh.'); return; }
    if (!r.configurado) alert('Este instalador não traz a chave dentro: copie a sua chave e informe-a quando o instalador pedir.');
    window.location.href = r.url;
  } finally {
    btn.disabled = false;
  }
}

// ===== CONTRATO DO CONECTOR (gestor) =====
let contratosPortal = [];
let vagaEmEdicao = null;   // { contratoId, vagaId }
let contratoSids = null;   // contrato aberto no modal de sistemas SAP

async function carregarContratosPortal() {
  const [res, resCursos] = await Promise.all([apiFetch(`${API}/contratos-conector/meus`), apiFetch(`${API}/contratos-cursos/meus`)]);
  if (!res || !res.ok) return;
  contratosPortal = await res.json();
  contratosCursosPortal = resCursos && resCursos.ok ? await resCursos.json() : [];
  renderContratosCursosPortal();
  const secao = document.getElementById('secao-contrato');
  secao.hidden = !contratosPortal.length && !contratosCursosPortal.length;
  document.getElementById('contrato-conector-descricao').hidden = !contratosPortal.length;
  const br = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
  document.getElementById('lista-contratos').innerHTML = contratosPortal.map(k => {
    const ativas = k.vagas.filter(v => v.usuario_id && v.estado !== 'convidada').length;
    const convites = k.vagas.filter(v => v.estado === 'convidada').length;
    const livres = k.vagas.filter(v => !v.usuario_id).length;
    const st = k.status === 'suspenso' ? ['Suspenso', '#f59e0b'] : k.status === 'cancelado' ? ['Cancelado', '#ef4444']
      : k.vigente ? ['Ativo', '#10b981'] : ['Vencido', '#ef4444'];
    const sids = (k.conexoes || []).map(c => c.sid).join(', ');
    return `
      <div class="contrato-resumo">
        <div>
          <strong>Contrato nº ${k.id}</strong>
          <span class="chip" style="background:${st[1]}20; color:${st[1]}">${st[0]}</span>
          <p>Válido de ${br(k.data_inicio)} até <strong>${br(k.data_fim)}</strong></p>
          ${k.suspenso_por_fatura_id ? '<p style="color:#b42318"><strong>Suspenso por pagamento em atraso.</strong> As licenças e os cursos inclusos voltam assim que a fatura for paga.</p>' : ''}
          <p><strong>${k.vagas.length}</strong> licença(s) contratada(s) · <strong>${ativas}</strong> em uso ·
             <strong>${convites}</strong> convite(s) pendente(s) · <strong>${livres}</strong> disponível(is)</p>
          <p class="sids">Sistemas SAP: <strong>${sids ? escapeHtml(sids) : 'nenhum cadastrado'}</strong> (até ${k.max_sids})</p>
        </div>
        <div class="acoes">
          ${livres && k.vigente ? `<button type="button" class="btn-curso" onclick="abrirConvidar(${k.id})">Convidar pessoa</button>` : ''}
          <button type="button" class="btn-curso secundario" onclick="abrirSids(${k.id})">${sids ? 'Editar' : 'Cadastrar'} sistemas SAP</button>
          <button type="button" class="btn-curso secundario" onclick="abrirHistoricoLicencas(${k.id})">Histórico</button>
        </div>
      </div>
      <div class="licencas-portal">${k.vagas.map(v => cartaoVaga(k, v)).join('')}</div>`;
  }).join('<div style="height:18px"></div>');
  carregarAdminsPortal();
}

function cartaoVaga(k, v) {
  const pct = v.aulas_total ? Math.round(100 * v.aulas_concluidas / v.aulas_total) : 0;
  const cursos = `<div class="vaga-cursos">${v.cursos.map(escapeHtml).join(' · ')}</div>`;
  if (!v.usuario_id) {
    return `
      <div class="licenca-card vaga-card livre">
        <h4>Licença ${escapeHtml(v.perfil_nome)} <span class="chip" style="background:#64748b20; color:#64748b">Disponível</span></h4>
        ${cursos}
        <div class="acoes">
          <button type="button" class="btn-curso" onclick="abrirOcuparVaga(${k.id}, ${v.id})">Convidar para esta licença</button>
        </div>
      </div>`;
  }
  if (v.estado === 'convidada') {
    const desde = v.convidado_em ? new Date(v.convidado_em).toLocaleDateString('pt-BR') : '';
    return `
      <div class="licenca-card vaga-card">
        <h4>Licença ${escapeHtml(v.perfil_nome)} <span class="chip" style="background:#f59e0b20; color:#b7791f">Convite pendente</span></h4>
        ${cursos}
        <div class="linha"><span>Convidado</span><strong>${escapeHtml(v.usuario_nome)}</strong></div>
        <div class="linha"><span>E-mail</span><strong>${escapeHtml(v.usuario_email)}</strong></div>
        <p class="ajuda">Convite enviado${desde ? ` em ${desde}` : ''}. A licença fica reservada até a pessoa criar a senha; o link vale 72 horas.</p>
        <div class="acoes">
          <button type="button" class="btn-curso secundario" onclick="reenviarConviteVaga(${k.id}, ${v.id})">Reenviar convite</button>
          <button type="button" class="btn-curso secundario" onclick="liberarVagaPortal(${k.id}, ${v.id}, true)">Cancelar convite</button>
        </div>
      </div>`;
  }
  return `
    <div class="licenca-card vaga-card">
      <h4>Licença ${escapeHtml(v.perfil_nome)} <span class="chip" style="background:#10b98120; color:#10b981">${v.usuario_id === meuId() ? 'Você' : 'Em uso'}</span></h4>
      ${cursos}
      <div class="linha"><span>Pessoa</span><strong>${escapeHtml(v.usuario_nome)}</strong></div>
      <div class="linha"><span>E-mail</span><strong>${escapeHtml(v.usuario_email)}</strong></div>
      <div class="linha"><span>Progresso</span><strong>${v.aulas_concluidas} de ${v.aulas_total} aulas (${pct}%)</strong></div>
      <div class="barra-curso"><i style="width:${pct}%"></i></div>
      <div class="linha"><span>Certificado</span><strong>${v.certificado ? '✓ ' + escapeHtml(v.certificado.codigo) : 'ainda não'}</strong></div>
      ${v.licenca ? `<div class="linha"><span>Chave</span><strong>${escapeHtml(v.licenca.chave_prefixo)}-… · ${v.licenca.maquina_nome ? escapeHtml(v.licenca.maquina_nome) : 'sem máquina'}</strong></div>` : ''}
      <div class="acoes">
        <button type="button" class="btn-curso secundario" onclick="liberarVagaPortal(${k.id}, ${v.id})">Revogar licença</button>
      </div>
    </div>`;
}

const meuId = () => (usuario ? usuario.id : null);

// ===== CONTRATOS DE CURSOS (gestor): vagas por pessoa =====
let contratosCursosPortal = [];

function renderContratosCursosPortal() {
  const bloco = document.getElementById('bloco-contratos-cursos');
  bloco.hidden = !contratosCursosPortal.length;
  if (!contratosCursosPortal.length) return;
  const br = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
  document.getElementById('lista-contratos-cursos').innerHTML = contratosCursosPortal.map(k => {
    const livres = k.vagas.filter(v => !v.usuario_id).length;
    const st = k.vigente ? ['Ativo', '#10b981'] : ['Fora da validade', '#ef4444'];
    const cursos = `<div class="vaga-cursos">${k.cursos.map(c => escapeHtml(c.titulo)).join(' · ')}</div>`;
    const cartoes = k.vagas.map(v => {
      if (!v.usuario_id) {
        return `<div class="licenca-card vaga-card livre">
          <h4>Vaga de cursos <span class="chip" style="background:#64748b20; color:#64748b">Disponível</span></h4>${cursos}
          <div class="acoes"><button type="button" class="btn-curso" onclick="convidarCursosPortal(${k.id}, ${v.id})">Convidar para esta vaga</button></div></div>`;
      }
      const pct = v.aulas_total ? Math.round(100 * v.aulas_concluidas / v.aulas_total) : 0;
      const convite = v.estado === 'convidada';
      return `<div class="licenca-card vaga-card">
        <h4>Vaga de cursos ${convite ? '<span class="chip" style="background:#f59e0b20; color:#b7791f">Convite pendente</span>'
          : `<span class="chip" style="background:#10b98120; color:#10b981">${v.usuario_id === meuId() ? 'Você' : 'Em uso'}</span>`}</h4>${cursos}
        <div class="linha"><span>Pessoa</span><strong>${escapeHtml(v.usuario_nome)}</strong></div>
        <div class="linha"><span>E-mail</span><strong>${escapeHtml(v.usuario_email)}</strong></div>
        ${convite ? '<p class="ajuda">Os cursos aparecem para a pessoa quando ela criar a senha (o link vale 72 horas).</p>'
          : `<div class="linha"><span>Progresso</span><strong>${v.aulas_concluidas} de ${v.aulas_total} aulas (${pct}%)</strong></div>
             <div class="barra-curso"><i style="width:${pct}%"></i></div>`}
        <div class="acoes">
          ${convite ? `<button type="button" class="btn-curso secundario" onclick="reenviarConviteCursosPortal(${k.id}, ${v.id})">Reenviar convite</button>` : ''}
          <button type="button" class="btn-curso secundario" onclick="liberarCursosPortal(${k.id}, ${v.id}, ${convite})">${convite ? 'Cancelar convite' : 'Liberar vaga'}</button>
        </div></div>`;
    }).join('');
    return `<div class="contrato-resumo">
        <div><strong>Contrato de cursos nº ${k.id}</strong> <span class="chip" style="background:${st[1]}20; color:${st[1]}">${st[0]}</span>
          <p>Válido de ${br(k.data_inicio)}${k.data_fim ? ` até <strong>${br(k.data_fim)}</strong>` : ' (sem prazo)'}</p>
          <p><strong>${k.total_vagas}</strong> vaga(s) · <strong>${k.ocupadas}</strong> ocupada(s) · <strong>${livres}</strong> disponível(is)</p></div>
        <div class="acoes">${livres && k.vigente ? `<button type="button" class="btn-curso" onclick="convidarCursosPortal(${k.id})">Convidar pessoa</button>` : ''}</div>
      </div>
      <div class="licencas-portal">${cartoes}</div>`;
  }).join('<div style="height:18px"></div>');
}

async function convidarCursosPortal(contratoId, vagaId) {
  const eu = confirm('Você mesmo vai fazer os cursos desta vaga?\n\nOK = eu mesmo · Cancelar = convidar outra pessoa');
  let corpo;
  if (eu) corpo = { eu: true };
  else {
    const email = prompt('E-mail da pessoa:');
    if (!email) return;
    const nome = prompt('Nome da pessoa:') || '';
    if (!nome.trim()) { alert('Informe o nome da pessoa.'); return; }
    corpo = { email: email.trim(), nome: nome.trim() };
  }
  if (vagaId) corpo.vaga_id = vagaId;
  const res = await apiFetch(`${API}/contratos-cursos/meus/${contratoId}/convidar`, { method: 'POST', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  carregarContratosPortal();
  if (eu) carregarTreinamentos();
}

async function liberarCursosPortal(contratoId, vagaId, convite) {
  if (!confirm(convite ? 'Cancelar este convite? A vaga volta a ficar disponível.'
    : 'Liberar esta vaga? A pessoa perde os cursos deste contrato na hora (a conta e o progresso ficam guardados).')) return;
  const res = await apiFetch(`${API}/contratos-cursos/meus/${contratoId}/vagas/${vagaId}/liberar`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  carregarContratosPortal();
  carregarTreinamentos();
}

async function reenviarConviteCursosPortal(contratoId, vagaId) {
  const res = await apiFetch(`${API}/contratos-cursos/meus/${contratoId}/vagas/${vagaId}/convite`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
}

// Convite pela licença escolhida (vagaId) ou só pelo perfil (o sistema reserva a próxima livre)
function prepararModalConvite(k, { vagaId, perfil }) {
  vagaEmEdicao = { contratoId: k.id, vagaId: vagaId || null };
  const f = document.getElementById('form-ocupar-vaga');
  f.reset();
  const livres = {};
  k.vagas.filter(v => !v.usuario_id).forEach(v => { livres[v.perfil] = livres[v.perfil] || { nome: v.perfil_nome, n: 0, cursos: v.cursos }; livres[v.perfil].n++; });
  f.perfil.innerHTML = Object.entries(livres).map(([p, x]) => `<option value="${p}">${escapeHtml(x.nome)} — ${x.n} disponível(is)</option>`).join('');
  if (perfil) f.perfil.value = perfil;
  document.getElementById('ocupar-vaga-perfil-grupo').style.display = vagaId ? 'none' : '';
  const cursosDe = p => (livres[p] ? livres[p].cursos : []).join(', ');
  const ajuda = () => {
    document.getElementById('ocupar-vaga-ajuda').textContent =
      `A pessoa recebe um convite por e-mail para criar a senha. A licença fica reservada até ela aceitar. Cursos inclusos: ${cursosDe(f.perfil.value)}.`;
  };
  f.perfil.onchange = ajuda;
  ajuda();
  abrirModal('modal-ocupar-vaga');
}

function abrirConvidar(contratoId) {
  const k = contratosPortal.find(x => x.id === contratoId);
  if (!k) return;
  document.getElementById('ocupar-vaga-titulo').textContent = 'Convidar pessoa';
  prepararModalConvite(k, {});
}

function abrirOcuparVaga(contratoId, vagaId) {
  const k = contratosPortal.find(x => x.id === contratoId);
  const v = k && k.vagas.find(x => x.id === vagaId);
  if (!v) return;
  document.getElementById('ocupar-vaga-titulo').textContent = `Convidar para a licença ${v.perfil_nome}`;
  prepararModalConvite(k, { vagaId, perfil: v.perfil });
}

async function enviarOcupacao(corpo) {
  const { contratoId, vagaId } = vagaEmEdicao || {};
  if (!contratoId) return;
  const f = document.getElementById('form-ocupar-vaga');
  const url = vagaId ? `${API}/contratos-conector/meus/${contratoId}/vagas/${vagaId}/ocupar` : `${API}/contratos-conector/meus/${contratoId}/convidar`;
  if (!vagaId) corpo.perfil = f.perfil.value;
  const res = await apiFetch(url, {
    method: 'POST', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (!res.ok) return;
  fecharModal('modal-ocupar-vaga');
  carregarContratosPortal();
  // O gestor que ocupou a própria vaga passa a ver os cursos dela
  if (corpo.eu) carregarTreinamentos();
}

function salvarOcuparVaga(e) {
  e.preventDefault();
  const f = e.target;
  if (!f.nome.value.trim()) { alert('Informe o nome da pessoa.'); return; }
  enviarOcupacao({ nome: f.nome.value.trim(), email: f.email.value.trim() });
}

function ocuparVagaEuMesmo() {
  if (!confirm('Usar esta licença com o seu usuário? Você passa a ver os cursos dela e recebe o Conector ao concluí-los.')) return;
  enviarOcupacao({ eu: true });
}

async function liberarVagaPortal(contratoId, vagaId, convite) {
  if (!confirm(convite
    ? 'Cancelar este convite? O link deixa de valer e a licença volta a ficar disponível.'
    : 'Revogar esta licença? A pessoa perde o Conector e os cursos desta licença na hora. A conta, o progresso e o certificado ficam guardados (e voltam a valer se ela receber a licença de novo).')) return;
  const res = await apiFetch(`${API}/contratos-conector/meus/${contratoId}/vagas/${vagaId}/liberar`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  carregarContratosPortal();
  carregarTreinamentos();
}

async function reenviarConviteVaga(contratoId, vagaId) {
  const res = await apiFetch(`${API}/contratos-conector/meus/${contratoId}/vagas/${vagaId}/convite`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
}

// Histórico das licenças: convites, aceites, revogações e expirações (quem fez e quando)
const ACOES_LICENCA = {
  'vaga.ocupada': 'Licença atribuída', 'vaga.convite_aceito': 'Convite aceito', 'vaga.liberada': 'Licença revogada',
  'vaga.convite_cancelado': 'Convite cancelado', 'vaga.convite_expirado': 'Convite expirou (licença liberada)'
};
async function abrirHistoricoLicencas(contratoId) {
  const lista = document.getElementById('historico-licencas-lista');
  document.getElementById('historico-licencas-titulo').textContent = `Histórico das licenças — contrato nº ${contratoId}`;
  lista.innerHTML = '<li>Carregando…</li>';
  abrirModal('modal-historico-licencas');
  const res = await apiFetch(`${API}/contratos-conector/meus/${contratoId}/historico`);
  if (!res || !res.ok) { lista.innerHTML = '<li>Não foi possível carregar.</li>'; return; }
  const itens = await res.json();
  lista.innerHTML = itens.length ? itens.map(h => {
    const quando = new Date(h.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const perfil = h.dados && h.dados.perfil ? ` (${escapeHtml(h.dados.perfil)})` : '';
    const acao = h.acao === 'vaga.ocupada' && h.dados && h.dados.estado === 'convidada' ? 'Convite enviado' : (ACOES_LICENCA[h.acao] || h.acao);
    return `<li><strong>${escapeHtml(acao)}</strong>${perfil} · ${escapeHtml(h.pessoa_nome || h.dados?.email || '')}
      <small>${quando}${h.feito_por ? ` · por ${escapeHtml(h.feito_por)}` : ' · automático'}</small></li>`;
  }).join('') : '<li>Nada registrado ainda (o histórico começou na versão 3.5).</li>';
}

// Administradores da empresa
async function carregarAdminsPortal() {
  const ul = document.getElementById('lista-admins');
  const res = await apiFetch(`${API}/contratos-conector/meus-admins`);
  if (!res || !res.ok) { ul.innerHTML = ''; return; }
  const admins = await res.json();
  const eu = meuId();
  ul.innerHTML = admins.map(a => `
    <li><span><strong>${escapeHtml(a.nome)}</strong> · ${escapeHtml(a.email)}${a.convite_pendente ? ' <em>(convite pendente)</em>' : ''}${a.id === eu ? ' <em>(você)</em>' : ''}</span>
      ${admins.length > 1 ? `<button type="button" class="btn-linha" onclick="removerAdminPortal(${a.id}, '${escapeHtml(a.nome).replace(/'/g, '&#39;')}')">Remover</button>` : ''}</li>`).join('');
}

async function adicionarAdminPortal() {
  const email = prompt('E-mail do novo administrador da empresa:');
  if (!email) return;
  const nome = prompt('Nome (para quem ainda não tem acesso ao portal):', '') || '';
  const res = await apiFetch(`${API}/contratos-conector/meus-admins`, { method: 'POST', body: JSON.stringify({ email: email.trim(), nome: nome.trim() }) });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (res.ok) carregarAdminsPortal();
}

async function removerAdminPortal(id, nome) {
  if (!confirm(`Remover ${nome} dos administradores? A pessoa continua com a conta e com a própria licença, se tiver.`)) return;
  const res = await apiFetch(`${API}/contratos-conector/meus-admins/${id}`, { method: 'DELETE' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  if (id === meuId()) { location.reload(); return; }
  carregarAdminsPortal();
}

// Sistemas SAP do contrato: SID, descrição, URL, mandante e idioma (nunca usuário/senha do SAP)
function abrirSids(contratoId) {
  contratoSids = contratosPortal.find(x => x.id === contratoId);
  if (!contratoSids) return;
  document.getElementById('sids-ajuda').textContent =
    `Até ${contratoSids.max_sids} sistemas. Todas as vagas usam estes sistemas; o conector chega à máquina de cada pessoa já configurado — ` +
    'ela só informa o próprio usuário e senha do SAP na instalação.';
  const box = document.getElementById('sids-linhas');
  box.innerHTML = '';
  const lista = contratoSids.conexoes && contratoSids.conexoes.length ? contratoSids.conexoes : [{}];
  lista.forEach(c => adicionarLinhaSid(c));
  abrirModal('modal-sids');
}

function adicionarLinhaSid(c = {}) {
  const box = document.getElementById('sids-linhas');
  if (contratoSids && box.children.length >= contratoSids.max_sids) {
    alert(`Este contrato permite até ${contratoSids.max_sids} sistemas SAP.`);
    return;
  }
  const div = document.createElement('div');
  div.className = 'sid-linha';
  div.innerHTML = `
    <div class="form-group"><label>SID</label><input name="sid" maxlength="3" placeholder="DEV" value="${escapeHtml(c.sid || '')}"></div>
    <div class="form-group"><label>Descrição</label><input name="descricao" maxlength="100" placeholder="Desenvolvimento" value="${escapeHtml(c.descricao || '')}"></div>
    <div class="form-group"><label>URL</label><input name="url" maxlength="255" placeholder="https://servidor:8000" value="${escapeHtml(c.url || '')}"></div>
    <div class="form-group"><label>Mandante</label><input name="mandante" maxlength="3" placeholder="100" value="${escapeHtml(c.mandante || '')}"></div>
    <div class="form-group"><label>Idioma</label><input name="idioma" maxlength="2" placeholder="PT" value="${escapeHtml(c.idioma || 'PT')}"></div>
    <button type="button" class="btn-remover" title="Remover" aria-label="Remover sistema" onclick="this.parentElement.remove()">×</button>`;
  box.appendChild(div);
}

async function salvarSids(e) {
  e.preventDefault();
  if (!contratoSids) return;
  const conexoes = [...document.querySelectorAll('#sids-linhas .sid-linha')].map(l => {
    const v = n => l.querySelector(`[name="${n}"]`).value.trim();
    return { sid: v('sid'), descricao: v('descricao'), url: v('url'), mandante: v('mandante'), idioma: v('idioma') };
  }).filter(c => c.sid || c.url);
  const res = await apiFetch(`${API}/contratos-conector/meus/${contratoSids.id}/conexoes`, {
    method: 'PUT', body: JSON.stringify({ conexoes }) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  fecharModal('modal-sids');
  carregarContratosPortal();
}

async function carregarChamados() {
  const res = await apiFetch(`${API}/chamados?limit=200`);
  if (!res) return;

  const data = await res.json();
  // API agora retorna { chamados, paginacao }; mantém compat com array antigo
  todosOsChamados = Array.isArray(data) ? data : (data.chamados || []);

  atualizarStats();
  atualizarFaixaAprovacao();
  // Mantém o filtro escolhido (ex.: depois de aprovar, a lista "aguardando aprovação" já sai sem o chamado)
  renderChamados(filtrarLista(filtroAtivo));
}

// Faixa "N chamados aguardando sua aprovação" (chamados abertos pelo Conector SAP)
function atualizarFaixaAprovacao() {
  const faixa = document.getElementById('faixa-aprovacao');
  if (!faixa) return;
  const n = todosOsChamados.filter(c => c.aprovacao_cliente === 'pendente').length;
  if (!n) { faixa.hidden = true; faixa.innerHTML = ''; return; }
  faixa.hidden = false;
  faixa.innerHTML = `
    <span><strong>${n} ${n === 1 ? 'chamado aguardando' : 'chamados aguardando'} sua aprovação</strong>
      — abertos pelo Conector SAP; a Marsh só começa depois que você aprovar.</span>
    <button type="button" class="cc-btn cc-btn-primario" onclick="filtrarChamados(null, '__aprovacao')">Ver ${n === 1 ? 'o chamado' : 'os chamados'}</button>`;
}

function filtrarLista(status) {
  if (status === '__aprovacao') return todosOsChamados.filter(c => c.aprovacao_cliente === 'pendente');
  return status ? todosOsChamados.filter(c => c.status === status) : todosOsChamados;
}

// Servidores SAP do chamado: os sistemas das licenças ativas do Conector da empresa (e do contrato vigente).
// Sem nenhum servidor habilitado, o passo 1 some e o chamado vai sem servidor.
let sistemasSap = [];
async function carregarSistemasSap() {
  const res = await apiFetch(`${API}/chamados/sistemas-sap`);
  if (!res || !res.ok) return;
  const d = await res.json();
  sistemasSap = d.sistemas || [];
  const sel = document.getElementById('nc-modulo');
  if (sel && sel.options.length <= 1) sel.insertAdjacentHTML('beforeend', (d.modulos || []).filter(m => m !== 'OUTRO')
    .map(m => `<option value="${m}">${m}</option>`).join(''));
}

function renderServidoresChamado() {
  const temServidor = sistemasSap.length > 0;
  document.getElementById('nc-bloco-servidor').hidden = !temServidor;
  document.getElementById('nc-passo-tipo').textContent = temServidor ? '2' : '1';
  document.getElementById('nc-passo-detalhe').textContent = temServidor ? '3' : '2';
  document.getElementById('nc-servidores').innerHTML = sistemasSap.map((s, i) => `
    <label class="nc-servidor">
      <input type="radio" name="sid" value="${escapeHtml(s.sid)}"${i === 0 ? ' required' : ''}${sistemasSap.length === 1 ? ' checked' : ''}>
      <span>
        <strong>${escapeHtml(s.sid)}</strong>
        <small>${escapeHtml(s.descricao || 'Sistema SAP')}</small>
        ${s.mandante ? `<span class="nc-mandante">Mandante ${escapeHtml(s.mandante)}</span>` : ''}
      </span>
    </label>`).join('');
  document.getElementById('nc-servidores-dica').textContent = temServidor
    ? 'Esses são os servidores habilitados nas licenças do Conector da sua empresa. Não achou o servidor? Fale com a Marsh ou com o administrador do contrato.'
    : '';
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
  if (btn) btn.classList.add('active');
  filtroAtivo = status;
  renderChamados(filtrarLista(status));
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
        ${ch.origem === 'conector' ? `<div class="cc-selos-linha">${ChamadoConector.selos(ch, true)}</div>` : ''}
        <div class="chamado-meta">
          ${ch.origem !== 'conector' && ch.sid ? `<span title="Servidor SAP">🖥 ${escapeHtml(ch.sid)}${ch.modulo ? ` · ${escapeHtml(ch.modulo)}` : ''}</span>` : ''}
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

const ROTULO_TIPO_CHAMADO = { erro: 'Erro', duvida: 'Dúvida', melhoria: 'Melhoria', nova_funcionalidade: 'Nova funcionalidade' };

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
    ${ch.origem !== 'conector' && ch.sid ? `<div><strong>Servidor SAP</strong>${escapeHtml(ch.sid)}${ch.modulo ? ` · ${escapeHtml(ch.modulo)}` : ''}</div>` : ''}
    ${ch.origem !== 'conector' && ch.tipo_demanda ? `<div><strong>Tipo</strong>${escapeHtml(ROTULO_TIPO_CHAMADO[ch.tipo_demanda] || ch.tipo_demanda)}</div>` : ''}
    ${ch.tecnologia_nome || !ch.sid ? `<div><strong>Tecnologia</strong>${escapeHtml(ch.tecnologia_nome || 'Geral')}</div>` : ''}
    <div><strong>Aberto em</strong>${formatDataHora(ch.data_abertura)}</div>
    ${acessoPortal.papel !== 'aluno' && (ch.aberto_por_nome || ch.solicitante_nome) ? `<div><strong>Aberto por</strong>${escapeHtml(ch.aberto_por_nome || ch.solicitante_nome)}</div>` : ''}
    ${ch.sla && ch.sla.sla_status !== 'concluido' ? `<div><strong>SLA</strong>${badgeSlaDetalhe(ch.sla)}</div>` : ''}
    ${ch.categoria ? `<div><strong>Categoria</strong>${escapeHtml(ch.categoria)}</div>` : ''}
    ${ch.data_fechamento ? `<div><strong>Fechado em</strong>${formatDataHora(ch.data_fechamento)}</div>` : ''}
    ${ch.origem === 'conector' ? '' : `<div style="grid-column:1/-1;white-space:pre-line"><strong>Descrição</strong>${escapeHtml(ch.descricao || '—')}</div>`}
  `;

  // Chamado do Conector SAP: SID, módulo, objetos, pedido, especificação e a aprovação do gestor
  document.getElementById('detalhe-conector').innerHTML =
    ChamadoConector.blocoHtml(ch, { podeAprovar: acessoPortal.papel !== 'aluno', podeRecusar: acessoPortal.papel !== 'aluno' });
  ChamadoConector.aoDecidir = async (cid) => { await carregarChamados(); await abrirDetalhe(cid); };

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
    solucao: '#10b981',
    reabertura: '#0d6efd',
    aprovacao: '#10b981',
    recusa: '#ef4444'
  };

  const labels = {
    comentario: 'Comentário',
    contato_cliente: 'Retorno da equipe',
    escalamento: 'Escalamento',
    solucao: 'Solução',
    reabertura: 'Reabertura',
    aprovacao: 'Aprovação',
    recusa: 'Recusa'
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

// Recarrega os servidores a cada abertura: servidor novo cadastrado na licença aparece sem atualizar o portal
async function abrirModalNovoChamado() {
  document.getElementById('form-novo-chamado').reset();
  await carregarSistemasSap();
  renderServidoresChamado();
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

  // A transação/programa vai no começo da descrição, para quem atende ver de cara onde olhar no SAP
  const transacao = form.transacao.value.trim();
  const descricao = form.descricao.value.trim();
  const dados = {
    titulo: form.titulo.value,
    descricao: [transacao && `Transação/programa: ${transacao}`, descricao].filter(Boolean).join('\n\n'),
    prioridade: form.prioridade.value,
    sid: (form.querySelector('input[name="sid"]:checked') || {}).value || null,
    modulo: form.modulo.value || null,
    tipo_demanda: (form.querySelector('input[name="tipo_demanda"]:checked') || {}).value || null
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

// Por que a pessoa tem o curso: licença do Conector (gratuito enquanto a licença valer), compra própria ou empresa
function origensCurso(c) {
  const br = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
  const chips = [];
  if (c.via_compra) chips.push(['#1d6fd8', c.compra_sem_fim || !c.compra_fim ? 'Seu' : `Seu até ${br(c.compra_fim)}`]);
  if (c.via_beneficio) chips.push(['#10b981', 'Incluso na licença do Conector']);
  if (c.via_liberacao || c.via_contrato) chips.push(['#64748b', 'Liberado pela empresa']);
  return chips.map(([cor, txt]) => `<span class="chip" style="background:${cor}1a; color:${cor}">${escapeHtml(txt)}</span>`).join(' ');
}

// Compras na loja de cursos: status, valor, validade do acesso e o link para pagar o que está pendente
const STATUS_PEDIDO_PORTAL = { pendente: ['Aguardando pagamento', '#1d6fd8'], pago: ['Pago', '#10b981'], vencido: ['Vencido', '#f59e0b'],
  cancelado: ['Cancelado', '#64748b'], expirado: ['Expirado', '#64748b'], recusado: ['Recusado', '#ef4444'],
  estornado: ['Estornado', '#ef4444'], contestado: ['Contestado', '#ef4444'] };
async function carregarPedidosPortal() {
  const res = await apiFetch(`${API}/loja/meus-pedidos`);
  if (!res || !res.ok) return;
  const pedidos = await res.json();
  const secao = document.getElementById('secao-pedidos');
  secao.hidden = !pedidos.length;
  const br = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
  const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  document.getElementById('lista-pedidos').innerHTML = pedidos.map(p => {
    const [txt, cor] = STATUS_PEDIDO_PORTAL[p.status] || [p.status, '#64748b'];
    return `<div class="pedido-linha">
      <div><strong>${escapeHtml(p.titulo)}</strong> · pedido #${p.id} · ${new Date(p.criado_em).toLocaleDateString('pt-BR')}
        ${p.status === 'pago' ? ` · acesso ${p.acesso_fim ? 'até ' + br(p.acesso_fim) : 'sem prazo'}` : ''}${p.modo === 'teste' ? ' · teste' : ''}</div>
      <div>${moeda(p.valor)} <span class="chip" style="background:${cor}20; color:${cor}">${txt}</span>
        ${p.link_pagamento ? `<a class="btn-curso" href="${escapeHtml(p.link_pagamento)}" target="_blank" rel="noopener">Pagar</a>` : ''}</div>
    </div>`;
  }).join('');
}

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
          <div class="curso-origens">${origensCurso(c)}</div>
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
  const r = await res.json().catch(() => ({}));
  a.concluida = !a.concluida;
  // Última aula do perfil: certificado e licença emitidos agora
  if (r.certificados && r.certificados.length) {
    alert('Parabéns! Você concluiu os cursos do seu perfil. Seu certificado e sua licença do Conector SAP já estão no portal, em "Minha licença do Conector SAP".');
    carregarAcesso();
    if (acessoPortal.gestor) carregarContratosPortal();
  }
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

// ===== CONECTOR SAP: licença (só leitura) e download do instalador =====
async function carregarLicencasPortal() {
  const res = await apiFetch(`${API}/licencas/minhas`);
  if (!res || !res.ok) return;
  const lista = await res.json();
  document.getElementById('secao-licenca').hidden = !lista.length;
  if (lista.length) carregarDownloadConector();
  const planos = { leitura: 'Leitura', desenvolvimento: 'Desenvolvimento', empresa: 'Empresa' };
  const hoje = isoLocal();
  document.getElementById('lista-licencas').innerHTML = lista.map(l => {
    const fim = String(l.data_fim).slice(0, 10);
    const vencida = fim < hoje;
    const st = l.status === 'suspensa' ? ['Suspensa', '#f59e0b'] : vencida ? ['Vencida', '#ef4444'] : ['Ativa', '#10b981'];
    return `
      <div class="licenca-card">
        <h4>Plano ${escapeHtml(planos[l.plano] || l.plano)}
          <span style="background:${st[1]}20; color:${st[1]}; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:600">${st[0]}</span></h4>
        ${l.titular_nome ? `<div class="linha"><span>Titular</span><strong>${escapeHtml(l.titular_nome)}</strong></div>` : ''}
        <div class="linha"><span>Válida até</span><strong>${fim.split('-').reverse().join('/')}</strong></div>
        <div class="linha"><span>Sistemas</span><strong>${escapeHtml(String(l.sids).replace(/,/g, ', '))}</strong></div>
        <div class="linha"><span>Máquinas ativas</span><strong>${Number(l.maquinas_ativas) || 0}${l.max_maquinas ? ' de ' + l.max_maquinas : ''}</strong></div>
        <div class="linha"><span>Usuários ativos (30 dias)</span><strong>${l.usuarios_ativos}${l.max_usuarios ? ' de ' + l.max_usuarios : ''}</strong></div>
        <div class="linha"><span>Uso do conector (30 dias)</span><strong>${Number(l.chamadas_30d).toLocaleString('pt-BR')} operações</strong></div>
      </div>`;
  }).join('');
}

// Botão "Baixar instalador": a URL vem do servidor (CONECTOR_DOWNLOAD_URL); sem ela, aviso de "em preparação"
async function carregarDownloadConector() {
  const box = document.getElementById('conector-download');
  const instrucao = '<p>Execute o instalador e informe a chave de licença que a Marsh enviou.</p>';
  const res = await apiFetch(`${API}/licencas/download`);
  if (!res) return;
  if (!res.ok) {
    box.innerHTML = '<div><strong>Instalador do conector</strong><p>Disponível enquanto a licença estiver ativa. Fale com a Marsh.</p></div>';
    return;
  }
  const { url, versao } = await res.json();
  const urlSegura = /^https?:\/\//i.test(url || '') ? url : null;
  // O link do storage vale poucos minutos: o botão pede um link novo a cada clique
  box.innerHTML = urlSegura
    ? `<div><strong>Instalador do conector${versao ? ' — versão ' + escapeHtml(versao) : ''}</strong>${instrucao}</div>
       <button type="button" class="btn-curso" id="btn-baixar-conector">Baixar instalador</button>`
    : `<div><strong>Instalador do conector</strong><p>Instalador em preparação — fale com a Marsh.</p></div>`;
  const btn = document.getElementById('btn-baixar-conector');
  if (btn) btn.addEventListener('click', baixarInstaladorConector);
}

async function baixarInstaladorConector(ev) {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const res = await apiFetch(`${API}/licencas/download`);
    const dados = res && res.ok ? await res.json() : null;
    if (dados && /^https?:\/\//i.test(dados.url || '')) window.location.href = dados.url;
    else alert('Não foi possível gerar o link do instalador. Fale com a Marsh.');
  } finally {
    btn.disabled = false;
  }
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
        <div class="linha"><span>NFS-e</span><strong>${f.nfse_status === 'emitida' && !f.nfse_simulada ? 'Nº ' + escapeHtml(f.nfse_numero || '-') : f.nfse_status === 'processando' ? 'Em emissão' : '—'}</strong></div>
        ${f.pix_payload ? blocoPixPortal(f) : ''}
        ${docs ? `<div class="docs">${docs}</div>` : ''}
      </div>`;
  }).join('');
}

// Cobrança PIX do Asaas: QR code + copia e cola (a baixa é automática quando o cliente paga)
function blocoPixPortal(f) {
  const qr = /^[A-Za-z0-9+/=]+$/.test(f.pix_qrcode || '') ? f.pix_qrcode : null;
  return `
    <div class="pix-box">
      <strong>Pague com PIX</strong>
      ${qr ? `<img src="data:image/png;base64,${qr}" alt="QR code PIX da fatura" width="180" height="180">` : ''}
      <code class="pix-codigo">${escapeHtml(f.pix_payload)}</code>
      <button type="button" class="pix-copiar" onclick="copiarPix(this)">Copiar código PIX</button>
      <small>A confirmação do pagamento é automática.</small>
    </div>`;
}

async function copiarPix(btn) {
  const codigo = btn.parentElement.querySelector('.pix-codigo').textContent;
  try {
    await navigator.clipboard.writeText(codigo);
    btn.textContent = 'Código copiado!';
    setTimeout(() => { btn.textContent = 'Copiar código PIX'; }, 2500);
  } catch {
    prompt('Copie o código PIX:', codigo);
  }
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
// Datas: DATE do Postgres chega como "AAAA-MM-DD" ou ISO à meia-noite UTC; TIMESTAMP chega como instante (UTC).
// Data pura fica como está; instante vira o dia/hora de Brasília (senão, depois das 21h aparece o dia seguinte).
const FUSO_BR = 'America/Sao_Paulo';
const ehDataPura = s => /^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(s);
const isoLocal = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
const diaIso = v => {
  if (!v) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  const d = new Date(s);
  return ehDataPura(s) || isNaN(d) ? s.slice(0, 10) : isoLocal(d);
};

function formatData(val) {
  const d = diaIso(val);
  return d ? d.split('-').reverse().join('/') : '-';
}

function formatDataHora(val) {
  if (!val) return '-';
  return new Date(val).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: FUSO_BR });
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

// ===== MINHA CONTA: alterar a própria senha =====
async function alterarMinhaSenhaPortal(e) {
  e.preventDefault();
  const form = document.getElementById('form-minha-senha-portal');
  if (form.nova_senha.value !== form.confirma.value) { alert('As duas senhas novas não conferem.'); return; }
  const res = await apiFetch(`${API}/usuarios/me/senha`, {
    method: 'PUT', body: JSON.stringify({ senha_atual: form.senha_atual.value, nova_senha: form.nova_senha.value })
  });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  if (res.ok) form.reset();
}
