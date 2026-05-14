// ===== CONFIG =====
const API_URL = '/api';

// ===== AUTH =====
const token = localStorage.getItem('token');
const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');

if (!token) {
  window.location.href = '/login.html';
}

if (usuario) {
  const el = document.getElementById('usuario-nome');
  if (el) el.textContent = usuario.nome;

  const emp = document.getElementById('sidebar-empresa');
  if (emp) emp.textContent = usuario.empresa_nome || 'Marsh Consultoria';
}

// Helper: fetch com token automático
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

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  window.location.href = '/login.html';
}

// ===== STATE =====
let currentPage = 'dashboard';
let clienteEmEdicao = null;
let fornecedorEmEdicao = null;
let tecnologiaEmEdicao = null;
let chamadoEmEdicao = null;
let usuarioEmEdicao = null;
let transacaoEmEdicao = null;

// Caches das listagens (para filtragem/ordenacao client-side)
let _clientesCache = [];
let _fornecedoresCache = [];
let _usuariosCache = [];
let _transacoesCache = [];
let _clientesChamadosCache = [];

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadDashboard();
});

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Navegação
  document.querySelectorAll('.nav-link, .bottom-nav-item').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      showPage(page);
    });
  });

  // Botões de novo
  document.getElementById('btn-novo-cliente').addEventListener('click', () => {
    clienteEmEdicao = null;
    resetForm('#form-cliente');
    document.getElementById('modal-cliente-titulo').textContent = 'Novo Cliente';
    showModal('#modal-cliente');
  });

  document.getElementById('btn-novo-fornecedor').addEventListener('click', () => {
    fornecedorEmEdicao = null;
    resetForm('#form-fornecedor');
    document.getElementById('modal-fornecedor-titulo').textContent = 'Novo Fornecedor';
    showModal('#modal-fornecedor');
  });

  document.getElementById('btn-novo-usuario').addEventListener('click', async () => {
    usuarioEmEdicao = null;
    resetForm('#form-usuario');
    document.getElementById('modal-usuario-titulo').textContent = 'Novo Usuário';
    document.getElementById('campo-senha-usuario').style.display = 'block';
    document.querySelector('#form-usuario [name="senha"]').required = true;
    toggleClienteSelect();
    await preencherSelectClientesUsuario();
    showModal('#modal-usuario');
  });

  document.getElementById('btn-nova-tecnologia').addEventListener('click', () => {
    tecnologiaEmEdicao = null;
    resetForm('#form-tecnologia');
    document.getElementById('modal-tecnologia-titulo').textContent = 'Nova Tecnologia';
    showModal('#modal-tecnologia');
  });

  document.getElementById('btn-novo-chamado').addEventListener('click', async () => {
    chamadoEmEdicao = null;
    resetForm('#form-chamado');
    document.getElementById('modal-chamado-titulo').textContent = 'Novo Chamado';
    document.getElementById('campo-status-chamado').style.display = 'none';
    document.getElementById('campo-anexos-chamado').style.display = 'block';
    arquivosPendentesChamado = [];
    renderListaPendentesChamado();
    document.getElementById('upload-progresso-chamado').style.display = 'none';
    await preencherSelectsChamado();
    showModal('#modal-chamado');
  });

  inicializarDropzoneChamado();

  document.getElementById('btn-nova-transacao').addEventListener('click', () => {
    transacaoEmEdicao = null;
    resetForm('#form-transacao');
    document.getElementById('modal-transacao-titulo').textContent = 'Nova Transação';
    document.getElementById('transacao-id').value = '';
    const btn = document.getElementById('btn-salvar-transacao');
    if (btn) btn.textContent = 'Salvar';
    showModal('#modal-transacao');
  });

  // Fechar modais
  document.querySelectorAll('.btn-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      closeModal(e.target.closest('.modal'));
    });
  });

  document.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      closeModal(e.target.closest('.modal'));
    });
  });

  // Fecha o modal só quando o usuário clicou no backdrop (mousedown E mouseup no backdrop).
  // Evita fechar quando o usuário começa a selecionar texto dentro do form e solta o mouse fora.
  document.querySelectorAll('.modal').forEach(modal => {
    let mousedownNoBackdrop = false;
    modal.addEventListener('mousedown', (e) => {
      mousedownNoBackdrop = (e.target === modal);
    });
    modal.addEventListener('mouseup', (e) => {
      if (mousedownNoBackdrop && e.target === modal) {
        closeModal(modal);
      }
      mousedownNoBackdrop = false;
    });
  });

  // Submits
  document.getElementById('form-cliente').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarCliente();
  });

  document.getElementById('form-fornecedor').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarFornecedor();
  });

  document.getElementById('form-tecnologia').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarTecnologia();
  });

  document.getElementById('form-chamado').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarChamado();
  });

  document.getElementById('form-atendimento').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarAtendimento();
  });

  document.getElementById('form-usuario').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarUsuario();
  });

  document.getElementById('form-reset-senha').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarResetSenha();
  });

  document.getElementById('form-transacao').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarTransacao();
  });
}

// ===== NAVIGATION =====
function showPage(page) {
  document.querySelectorAll('.nav-link, .bottom-nav-item').forEach(link => link.classList.remove('active'));
  document.querySelectorAll(`[data-page="${page}"]`).forEach(el => el.classList.add('active'));

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById(`${page}-page`);
  if (pageEl) pageEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    clientes: 'Clientes',
    fornecedores: 'Fornecedores',
    tecnologias: 'Tecnologias',
    chamados: 'Chamados',
    transacoes: 'Transações Financeiras',
    usuarios: 'Usuários do Sistema'
  };
  document.getElementById('page-title').textContent = titles[page] || page;

  currentPage = page;

  if (page === 'clientes') loadClientes();
  if (page === 'fornecedores') loadFornecedores();
  if (page === 'tecnologias') loadTecnologias();
  if (page === 'chamados') loadChamados();
  if (page === 'transacoes') loadTransacoes();
  if (page === 'usuarios') loadUsuarios();
}

// ===== DASHBOARD =====
async function loadDashboard() {
  const tbodyRecent = document.getElementById('dashboard-chamados-tbody');
  if (tbodyRecent && tbodyRecent.querySelector('.text-center')) {
    tbodyRecent.innerHTML = skeletonRows(6, 3);
  }
  try {
    const [resumo, transacoes, chamadosResp] = await Promise.all([
      apiFetch(`${API_URL}/empresas/resumo`).then(r => r ? r.json() : {}),
      apiFetch(`${API_URL}/transacoes`).then(r => r ? r.json() : {}),
      apiFetch(`${API_URL}/chamados?status=aberto&limit=10`).then(r => r ? r.json() : {})
    ]);
    const chamados = Array.isArray(chamadosResp) ? chamadosResp : (chamadosResp.chamados || []);

    if (resumo) {
      animateCounter(document.getElementById('total-clientes'), resumo.clientes || 0);
      animateCounter(document.getElementById('total-fornecedores'), resumo.fornecedores || 0);
      animateCounter(document.getElementById('total-tecnologias'), resumo.tecnologias || 0);
      if (resumo.chamados) {
        const abertos = parseInt(resumo.chamados.abertos || 0) + parseInt(resumo.chamados.em_andamento || 0);
        animateCounter(document.getElementById('total-chamados-abertos'), abertos);
      }
    }

    if (transacoes && transacoes.resumo) {
      const { totalEntradas, totalSaidas, saldo } = transacoes.resumo;
      animateCounter(document.getElementById('total-entradas'), totalEntradas, { formatter: formatMoeda });
      animateCounter(document.getElementById('total-saidas'), totalSaidas, { formatter: formatMoeda });
      animateCounter(document.getElementById('total-saldo'), saldo, { formatter: formatMoeda });
      const elSaldo = document.getElementById('total-saldo');
      if (elSaldo) elSaldo.style.color = saldo < 0 ? '#ef4444' : (saldo > 0 ? '#10b981' : '');
    }

    // Chamados recentes
    renderDashboardChamados(Array.isArray(chamados) ? chamados.slice(0, 5) : []);
  } catch (err) {
    console.error('Erro ao carregar dashboard:', err);
  }
}

function renderDashboardChamados(chamados) {
  const tbody = document.getElementById('dashboard-chamados-tbody');
  if (!chamados || chamados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Nenhum chamado aberto</td></tr>';
    return;
  }
  tbody.innerHTML = chamados.map(ch => `
    <tr style="cursor:pointer" onclick="abrirDetalheChamado(${ch.id})">
      <td data-label="#">#${ch.id}</td>
      <td data-label="Título">${escapeHtml(ch.titulo)}</td>
      <td data-label="Cliente">${escapeHtml(ch.cliente_nome || '-')}</td>
      <td data-label="Status">${badgeStatus(ch.status)}</td>
      <td data-label="Prioridade">${badgePrioridade(ch.prioridade)}</td>
      <td data-label="Abertura">${formatData(ch.data_criacao)}</td>
    </tr>
  `).join('');
}

// ===== CLIENTES =====
async function loadClientes() {
  const tbody = document.getElementById('clientes-tbody');
  if (tbody && _clientesCache.length === 0) tbody.innerHTML = skeletonRows(7);
  const res = await apiFetch(`${API_URL}/clientes`);
  if (!res) return;
  _clientesCache = await res.json();
  popularSelectsClientes(_clientesCache);
  renderClientes();
}

function popularSelectsClientes(lista) {
  const segmentos = [...new Set(lista.map(c => c.segmento).filter(Boolean))].sort();
  const ufs = [...new Set(lista.map(c => c.uf).filter(Boolean))].sort();
  preencherSelectOptions('filtro-clientes-segmento', segmentos);
  preencherSelectOptions('filtro-clientes-uf', ufs);
}

function renderClientes() {
  const tbody = document.getElementById('clientes-tbody');
  const contador = document.getElementById('filtro-clientes-contador');

  const busca = (document.getElementById('filtro-clientes-busca')?.value || '').trim().toLowerCase();
  const status = document.getElementById('filtro-clientes-status')?.value || '';
  const segmento = document.getElementById('filtro-clientes-segmento')?.value || '';
  const porte = document.getElementById('filtro-clientes-porte')?.value || '';
  const uf = document.getElementById('filtro-clientes-uf')?.value || '';
  const ordem = document.getElementById('filtro-clientes-ordenar')?.value || 'razao_asc';

  let lista = _clientesCache.filter(c => {
    if (status && c.status !== status) return false;
    if (segmento && c.segmento !== segmento) return false;
    if (porte && c.porte !== porte) return false;
    if (uf && c.uf !== uf) return false;
    if (busca) {
      const alvo = [
        c.razao_social, c.nome, c.nome_fantasia, c.cpf_cnpj,
        c.responsavel_nome, c.email, c.telefone, c.celular, c.cidade
      ].filter(Boolean).join(' ').toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  lista = ordenarClientes(lista, ordem);

  if (contador) contador.textContent = `${lista.length} de ${_clientesCache.length}`;

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">${_clientesCache.length === 0 ? 'Nenhum cliente cadastrado' : 'Nenhum cliente para os filtros aplicados'}</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(c => `
    <tr>
      <td data-label="Razão Social">
        <strong>${escapeHtml(c.razao_social || c.nome)}</strong>
        ${c.nome_fantasia ? `<br><small style="color:#94a3b8">${escapeHtml(c.nome_fantasia)}</small>` : ''}
        ${auditMeta(c)}
      </td>
      <td data-label="CNPJ/CPF">${escapeHtml(c.cpf_cnpj || '-')}</td>
      <td data-label="Responsável">${escapeHtml(c.responsavel_nome || c.email || '-')}</td>
      <td data-label="Telefone">${escapeHtml(c.telefone || c.celular || '-')}</td>
      <td data-label="Status">${badgeStatusGeral(c.status)}</td>
      <td data-label="Chamados">
        ${parseInt(c.chamados_abertos) > 0
          ? `<span class="badge badge-aberto">${c.chamados_abertos} aberto(s)</span>`
          : '<span style="color:#94a3b8">0</span>'
        }
      </td>
      <td data-label="Ações" class="td-acoes">
        <button class="btn btn-icon btn-edit" title="Editar" aria-label="Editar" onclick="editarCliente(${c.id})">${iconSVG('edit')}</button>
        <button class="btn btn-icon btn-danger" title="Remover" aria-label="Remover" onclick="deletarCliente(${c.id})">${iconSVG('trash')}</button>
      </td>
    </tr>
  `).join('');
}

function ordenarClientes(lista, ordem) {
  const arr = [...lista];
  switch (ordem) {
    case 'razao_desc':
      return arr.sort((a, b) => (b.razao_social || b.nome || '').localeCompare(a.razao_social || a.nome || '', 'pt-BR'));
    case 'recentes':
      return arr.sort((a, b) => new Date(b.data_criacao || 0) - new Date(a.data_criacao || 0));
    case 'antigos':
      return arr.sort((a, b) => new Date(a.data_criacao || 0) - new Date(b.data_criacao || 0));
    case 'chamados_desc':
      return arr.sort((a, b) => (parseInt(b.chamados_abertos) || 0) - (parseInt(a.chamados_abertos) || 0));
    case 'razao_asc':
    default:
      return arr.sort((a, b) => (a.razao_social || a.nome || '').localeCompare(b.razao_social || b.nome || '', 'pt-BR'));
  }
}

let _filtroClientesTimer = null;
function onFiltroClientesChange(debounce = false) {
  if (debounce) {
    clearTimeout(_filtroClientesTimer);
    _filtroClientesTimer = setTimeout(renderClientes, 250);
  } else {
    renderClientes();
  }
}

async function salvarCliente() {
  const form = document.getElementById('form-cliente');

  // Validação client-side de CPF/CNPJ (não bloqueia se vazio)
  if (form.cpf_cnpj.value && !validarDocumentoFront(form.cpf_cnpj.value)) {
    alert('CPF/CNPJ inválido. Verifique os dígitos.');
    form.cpf_cnpj.focus();
    return;
  }

  const dados = {
    razao_social: form.razao_social.value,
    nome_fantasia: form.nome_fantasia.value,
    cpf_cnpj: form.cpf_cnpj.value,
    status: form.status.value,
    inscricao_estadual: form.inscricao_estadual.value,
    inscricao_municipal: form.inscricao_municipal.value,
    email: form.email.value,
    telefone: form.telefone.value,
    celular: form.celular.value,
    site: form.site.value,
    responsavel_nome: form.responsavel_nome.value,
    responsavel_email: form.responsavel_email.value,
    responsavel_telefone: form.responsavel_telefone.value,
    cep: form.cep.value,
    logradouro: form.logradouro.value,
    numero: form.numero.value,
    complemento: form.complemento.value,
    bairro: form.bairro.value,
    cidade: form.cidade.value,
    uf: form.uf.value,
    data_inicio_contrato: form.data_inicio_contrato.value || null,
    data_fim_contrato: form.data_fim_contrato.value || null,
    observacoes: form.observacoes.value,
    segmento: form.segmento ? form.segmento.value : null,
    porte: form.porte ? form.porte.value : null,
    tier_sla: form.tier_sla ? form.tier_sla.value : null
  };

  try {
    const url = clienteEmEdicao ? `${API_URL}/clientes/${clienteEmEdicao}` : `${API_URL}/clientes`;
    const method = clienteEmEdicao ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: JSON.stringify(dados) });
    if (!res) return;

    if (!res.ok) {
      const err = await res.json();
      alert((err.erro || 'Erro ao salvar') + (err.detalhe ? '\n\nDetalhe: ' + err.detalhe : ''));
      return;
    }

    alert(clienteEmEdicao ? 'Cliente atualizado!' : 'Cliente criado!');
    closeModal(document.getElementById('modal-cliente'));
    loadClientes();
    loadDashboard();
  } catch (err) {
    alert('Erro ao salvar cliente: ' + err.message);
  }
}

async function editarCliente(id) {
  const res = await apiFetch(`${API_URL}/clientes/${id}`);
  if (!res) return;
  const c = await res.json();

  clienteEmEdicao = id;
  const form = document.getElementById('form-cliente');

  const fields = ['razao_social','nome_fantasia','cpf_cnpj','inscricao_estadual',
    'inscricao_municipal','email','telefone','celular','site','responsavel_nome',
    'responsavel_email','responsavel_telefone','cep','logradouro','numero',
    'complemento','bairro','cidade','uf','observacoes',
    'segmento','porte','tier_sla'];

  fields.forEach(f => {
    if (form[f]) form[f].value = c[f] || '';
  });

  if (form.status) form.status.value = c.status || 'ativo';
  if (form.uf) form.uf.value = c.uf || '';
  if (form.data_inicio_contrato) form.data_inicio_contrato.value = c.data_inicio_contrato ? c.data_inicio_contrato.split('T')[0] : '';
  if (form.data_fim_contrato) form.data_fim_contrato.value = c.data_fim_contrato ? c.data_fim_contrato.split('T')[0] : '';

  document.getElementById('modal-cliente-titulo').textContent = 'Editar Cliente';
  showModal('#modal-cliente');
}

async function deletarCliente(id) {
  if (!confirm('Deseja remover este cliente? Esta ação é reversível pelo administrador.')) return;
  const res = await apiFetch(`${API_URL}/clientes/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  alert('Cliente removido!');
  loadClientes();
  loadDashboard();
}

// ===== FORNECEDORES =====
async function loadFornecedores() {
  const tbody = document.getElementById('fornecedores-tbody');
  if (tbody && _fornecedoresCache.length === 0) tbody.innerHTML = skeletonRows(6);
  const res = await apiFetch(`${API_URL}/fornecedores`);
  if (!res) return;
  _fornecedoresCache = await res.json();
  popularSelectsFornecedores(_fornecedoresCache);
  renderFornecedores();
}

function popularSelectsFornecedores(lista) {
  const ufs = [...new Set(lista.map(f => f.uf).filter(Boolean))].sort();
  preencherSelectOptions('filtro-fornecedores-uf', ufs);
}

function renderFornecedores() {
  const tbody = document.getElementById('fornecedores-tbody');
  const contador = document.getElementById('filtro-fornecedores-contador');

  const busca = (document.getElementById('filtro-fornecedores-busca')?.value || '').trim().toLowerCase();
  const tipo = document.getElementById('filtro-fornecedores-tipo')?.value || '';
  const status = document.getElementById('filtro-fornecedores-status')?.value || '';
  const uf = document.getElementById('filtro-fornecedores-uf')?.value || '';
  const ordem = document.getElementById('filtro-fornecedores-ordenar')?.value || 'razao_asc';

  let lista = _fornecedoresCache.filter(f => {
    if (tipo && f.tipo !== tipo) return false;
    if (status && f.status !== status) return false;
    if (uf && f.uf !== uf) return false;
    if (busca) {
      const alvo = [f.razao_social, f.nome, f.nome_fantasia, f.cnpj, f.contato_nome, f.email, f.telefone, f.ramo, f.cidade]
        .filter(Boolean).join(' ').toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  const arr = [...lista];
  switch (ordem) {
    case 'razao_desc': arr.sort((a, b) => (b.razao_social || b.nome || '').localeCompare(a.razao_social || a.nome || '', 'pt-BR')); break;
    case 'recentes': arr.sort((a, b) => new Date(b.data_criacao || 0) - new Date(a.data_criacao || 0)); break;
    case 'antigos': arr.sort((a, b) => new Date(a.data_criacao || 0) - new Date(b.data_criacao || 0)); break;
    default: arr.sort((a, b) => (a.razao_social || a.nome || '').localeCompare(b.razao_social || b.nome || '', 'pt-BR'));
  }

  if (contador) contador.textContent = `${arr.length} de ${_fornecedoresCache.length}`;

  if (!arr.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">${_fornecedoresCache.length === 0 ? 'Nenhum fornecedor cadastrado' : 'Nenhum fornecedor para os filtros aplicados'}</td></tr>`;
    return;
  }

  tbody.innerHTML = arr.map(f => `
    <tr>
      <td data-label="Razão Social">
        <strong>${escapeHtml(f.razao_social || f.nome)}</strong>
        ${f.nome_fantasia ? `<br><small style="color:#94a3b8">${escapeHtml(f.nome_fantasia)}</small>` : ''}
        ${auditMeta(f)}
      </td>
      <td data-label="CNPJ">${escapeHtml(f.cnpj || '-')}</td>
      <td data-label="Tipo">${f.tipo ? escapeHtml(capitalize(f.tipo)) : escapeHtml(f.ramo || '-')}</td>
      <td data-label="Contato">${escapeHtml(f.contato_nome || f.email || '-')}</td>
      <td data-label="Status">${badgeStatusGeral(f.status)}</td>
      <td data-label="Ações" class="td-acoes">
        <button class="btn btn-icon btn-edit" title="Editar" aria-label="Editar" onclick="editarFornecedor(${f.id})">${iconSVG('edit')}</button>
        <button class="btn btn-icon btn-danger" title="Remover" aria-label="Remover" onclick="deletarFornecedor(${f.id})">${iconSVG('trash')}</button>
      </td>
    </tr>
  `).join('');
}

let _filtroFornecedoresTimer = null;
function onFiltroFornecedoresChange(debounce = false) {
  if (debounce) {
    clearTimeout(_filtroFornecedoresTimer);
    _filtroFornecedoresTimer = setTimeout(renderFornecedores, 250);
  } else {
    renderFornecedores();
  }
}

async function salvarFornecedor() {
  const form = document.getElementById('form-fornecedor');

  // Validação client-side de CNPJ (não bloqueia se vazio)
  if (form.cnpj.value && !validarCNPJFront(form.cnpj.value)) {
    alert('CNPJ inválido. Verifique os dígitos.');
    form.cnpj.focus();
    return;
  }

  const dados = {
    razao_social: form.razao_social.value,
    nome_fantasia: form.nome_fantasia.value,
    cnpj: form.cnpj.value,
    tipo: form.tipo.value,
    ramo: form.ramo.value,
    status: form.status.value,
    email: form.email.value,
    telefone: form.telefone.value,
    celular: form.celular.value,
    site: form.site.value,
    contato_nome: form.contato_nome.value,
    contato_email: form.contato_email.value,
    observacoes: form.observacoes.value,
    cep: form.cep ? form.cep.value : null,
    logradouro: form.logradouro ? form.logradouro.value : null,
    numero: form.numero ? form.numero.value : null,
    complemento: form.complemento ? form.complemento.value : null,
    bairro: form.bairro ? form.bairro.value : null,
    cidade: form.cidade ? form.cidade.value : null,
    uf: form.uf ? form.uf.value : null
  };

  try {
    const url = fornecedorEmEdicao ? `${API_URL}/fornecedores/${fornecedorEmEdicao}` : `${API_URL}/fornecedores`;
    const method = fornecedorEmEdicao ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: JSON.stringify(dados) });
    if (!res) return;

    if (!res.ok) {
      const err = await res.json();
      alert(err.erro || 'Erro ao salvar');
      return;
    }

    alert(fornecedorEmEdicao ? 'Fornecedor atualizado!' : 'Fornecedor criado!');
    closeModal(document.getElementById('modal-fornecedor'));
    loadFornecedores();
    loadDashboard();
  } catch (err) {
    alert('Erro ao salvar fornecedor: ' + err.message);
  }
}

async function editarFornecedor(id) {
  const res = await apiFetch(`${API_URL}/fornecedores/${id}`);
  if (!res) return;
  const f = await res.json();

  fornecedorEmEdicao = id;
  const form = document.getElementById('form-fornecedor');

  const fields = ['razao_social','nome_fantasia','cnpj','ramo','email','telefone',
    'celular','site','contato_nome','contato_email','observacoes',
    'cep','logradouro','numero','complemento','bairro','cidade','uf'];
  fields.forEach(field => {
    if (form[field]) form[field].value = f[field] || '';
  });
  if (form.tipo) form.tipo.value = f.tipo || '';
  if (form.status) form.status.value = f.status || 'ativo';

  document.getElementById('modal-fornecedor-titulo').textContent = 'Editar Fornecedor';
  showModal('#modal-fornecedor');
}

async function deletarFornecedor(id) {
  if (!confirm('Deseja remover este fornecedor?')) return;
  const res = await apiFetch(`${API_URL}/fornecedores/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  alert('Fornecedor removido!');
  loadFornecedores();
  loadDashboard();
}

// ===== TECNOLOGIAS =====
async function loadTecnologias() {
  const tbodyPre = document.getElementById('tecnologias-tbody');
  if (tbodyPre && tbodyPre.querySelector('.text-center')) tbodyPre.innerHTML = skeletonRows(7);
  const res = await apiFetch(`${API_URL}/tecnologias`);
  if (!res) return;
  const lista = await res.json();
  const tbody = document.getElementById('tecnologias-tbody');

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">Nenhuma tecnologia cadastrada</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(t => `
    <tr>
      <td data-label="Nome">
        <strong>${escapeHtml(t.nome)}</strong>
        ${auditMeta(t)}
      </td>
      <td data-label="Categoria">${escapeHtml(t.categoria || '-')}</td>
      <td data-label="Fabricante">${escapeHtml(t.fabricante || '-')}</td>
      <td data-label="Versão">${escapeHtml(t.versao || '-')}</td>
      <td data-label="Clientes">${t.total_clientes || 0} cliente(s)</td>
      <td data-label="Status">${badgeStatusTec(t.status)}</td>
      <td data-label="Ações" class="td-acoes">
        <button class="btn btn-icon btn-edit" title="Editar" aria-label="Editar" onclick="editarTecnologia(${t.id})">${iconSVG('edit')}</button>
        <button class="btn btn-icon btn-danger" title="Remover" aria-label="Remover" onclick="deletarTecnologia(${t.id})">${iconSVG('trash')}</button>
      </td>
    </tr>
  `).join('');
}

async function salvarTecnologia() {
  const form = document.getElementById('form-tecnologia');
  const dados = {
    nome: form.nome.value,
    categoria: form.categoria.value,
    descricao: form.descricao.value,
    fabricante: form.fabricante.value,
    versao: form.versao.value,
    status: form.status.value
  };

  try {
    const url = tecnologiaEmEdicao ? `${API_URL}/tecnologias/${tecnologiaEmEdicao}` : `${API_URL}/tecnologias`;
    const method = tecnologiaEmEdicao ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: JSON.stringify(dados) });
    if (!res) return;

    if (!res.ok) { const e = await res.json(); alert(e.erro); return; }

    alert(tecnologiaEmEdicao ? 'Tecnologia atualizada!' : 'Tecnologia criada!');
    closeModal(document.getElementById('modal-tecnologia'));
    loadTecnologias();
    loadDashboard();
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

async function editarTecnologia(id) {
  const res = await apiFetch(`${API_URL}/tecnologias/${id}`);
  if (!res) return;
  const t = await res.json();

  tecnologiaEmEdicao = id;
  const form = document.getElementById('form-tecnologia');
  form.nome.value = t.nome || '';
  form.descricao.value = t.descricao || '';
  form.fabricante.value = t.fabricante || '';
  form.versao.value = t.versao || '';
  if (form.categoria) form.categoria.value = t.categoria || '';
  if (form.status) form.status.value = t.status || 'ativa';

  document.getElementById('modal-tecnologia-titulo').textContent = 'Editar Tecnologia';
  showModal('#modal-tecnologia');
}

async function deletarTecnologia(id) {
  if (!confirm('Deseja remover esta tecnologia?')) return;
  const res = await apiFetch(`${API_URL}/tecnologias/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  alert('Tecnologia removida!');
  loadTecnologias();
  loadDashboard();
}

// ===== CHAMADOS =====
async function preencherSelectsChamado() {
  const [clientes, tecnologias] = await Promise.all([
    apiFetch(`${API_URL}/clientes`).then(r => r ? r.json() : []),
    apiFetch(`${API_URL}/tecnologias`).then(r => r ? r.json() : [])
  ]);

  const selCli = document.getElementById('select-cliente-chamado');
  selCli.innerHTML = '<option value="">Selecione o cliente...</option>' +
    clientes.map(c => `<option value="${c.id}">${c.razao_social || c.nome}</option>`).join('');

  const selTec = document.getElementById('select-tecnologia-chamado');
  selTec.innerHTML = '<option value="">Nenhuma tecnologia</option>' +
    tecnologias.map(t => `<option value="${t.id}">${t.nome} ${t.categoria ? '(' + t.categoria + ')' : ''}</option>`).join('');
}

let chamadosPaginacao = { page: 1, limit: 25 };

async function loadChamados() {
  const tbodyPre = document.getElementById('chamados-tbody');
  if (tbodyPre && tbodyPre.querySelector('.text-center')) tbodyPre.innerHTML = skeletonRows(8);
  const status = document.getElementById('filtro-status')?.value || '';
  const prioridade = document.getElementById('filtro-prioridade')?.value || '';
  const busca = document.getElementById('filtro-busca')?.value?.trim() || '';
  const clienteId = document.getElementById('filtro-chamados-cliente')?.value || '';
  const dataDe = document.getElementById('filtro-chamados-data-de')?.value || '';
  const dataAte = document.getElementById('filtro-chamados-data-ate')?.value || '';

  // popula select de clientes (uma vez)
  await popularSelectClientesChamados();

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (prioridade) params.set('prioridade', prioridade);
  if (busca) params.set('busca', busca);
  if (clienteId) params.set('cliente_id', clienteId);
  if (dataDe) params.set('data_de', dataDe);
  if (dataAte) params.set('data_ate', dataAte);
  params.set('page', chamadosPaginacao.page);
  params.set('limit', chamadosPaginacao.limit);

  const res = await apiFetch(`${API_URL}/chamados?${params.toString()}`);
  if (!res) return;
  const data = await res.json();
  const lista = Array.isArray(data) ? data : (data.chamados || []);
  const paginacao = data.paginacao || { total: lista.length, page: 1, limit: lista.length, total_paginas: 1 };
  const tbody = document.getElementById('chamados-tbody');

  renderPaginacaoChamados(paginacao);

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center">Nenhum chamado encontrado</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(ch => {
    const naoLidos = parseInt(ch.atendimentos_nao_lidos) || 0;
    return `
    <tr${naoLidos > 0 ? ' class="row-novidade"' : ''}>
      <td data-label="#"><strong>#${ch.id}</strong></td>
      <td data-label="Título" class="td-titulo" style="max-width:240px;" title="${escapeHtml(ch.titulo)}">
        <div class="td-titulo-inner" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          ${escapeHtml(ch.titulo)}
          ${naoLidos > 0 ? `<span class="badge-novo-dash" title="${naoLidos} não lido(s)">${naoLidos}</span>` : ''}
        </div>
        ${auditMeta(ch)}
      </td>
      <td data-label="Cliente">${escapeHtml(ch.cliente_nome || '-')}</td>
      <td data-label="Tecnologia">${escapeHtml(ch.tecnologia_nome || '-')}</td>
      <td data-label="Status">${badgeStatus(ch.status)}${badgeSlaInline(ch.sla)}</td>
      <td data-label="Prioridade">${badgePrioridade(ch.prioridade)}${ch.avaliacao_nota ? `<br><small style="color:#f59e0b">${'★'.repeat(ch.avaliacao_nota)}</small>` : ''}</td>
      <td data-label="Abertura">${formatData(ch.data_criacao)}</td>
      <td data-label="Ações" class="td-acoes">
        <button class="btn btn-icon btn-edit" title="Ver detalhes" aria-label="Ver detalhes" onclick="abrirDetalheChamado(${ch.id})">${iconSVG('eye')}</button>
        <button class="btn btn-icon btn-edit" title="Editar" aria-label="Editar" onclick="editarChamado(${ch.id})">${iconSVG('edit')}</button>
        <button class="btn btn-icon btn-danger" title="Remover" aria-label="Remover" onclick="deletarChamado(${ch.id})">${iconSVG('trash')}</button>
      </td>
    </tr>
    `;
  }).join('');
}

async function popularSelectClientesChamados() {
  const sel = document.getElementById('filtro-chamados-cliente');
  if (!sel || _clientesChamadosCache.length) return;
  try {
    const r = await apiFetch(`${API_URL}/clientes`);
    if (!r) return;
    _clientesChamadosCache = await r.json();
    const atual = sel.value;
    sel.innerHTML = '<option value="">Todos os clientes</option>' +
      _clientesChamadosCache.map(c => `<option value="${c.id}">${escapeHtml(c.razao_social || c.nome)}</option>`).join('');
    if (atual) sel.value = atual;
  } catch (e) { /* silencioso */ }
}

function badgeSlaInline(sla) {
  if (!sla || sla.sla_status === 'concluido' || sla.sla_status === 'ok') return '';
  if (sla.sla_status === 'estourado') return '<br><small style="color:#ef4444; font-weight:600">⏱ SLA estourado</small>';
  const h = Math.max(0, Math.floor(sla.restante_minutos / 60));
  return `<br><small style="color:#f59e0b; font-weight:600">⏱ ${h}h restantes</small>`;
}

function renderPaginacaoChamados(p) {
  const container = document.getElementById('chamados-paginacao');
  if (!container) return;
  if (p.total_paginas <= 1) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <button class="btn btn-secondary" ${p.page <= 1 ? 'disabled' : ''} onclick="mudarPaginaChamados(${p.page - 1})">← Anterior</button>
    <span style="font-size:12.5px; color:#64748b">Página ${p.page} de ${p.total_paginas} · ${p.total} chamado(s)</span>
    <button class="btn btn-secondary" ${p.page >= p.total_paginas ? 'disabled' : ''} onclick="mudarPaginaChamados(${p.page + 1})">Próxima →</button>
  `;
}

function mudarPaginaChamados(p) {
  chamadosPaginacao.page = p;
  loadChamados();
}

function onFiltroChamadosChange() {
  chamadosPaginacao.page = 1;
  loadChamados();
}

let _buscaTimer = null;
function onBuscaChamadosChange() {
  clearTimeout(_buscaTimer);
  _buscaTimer = setTimeout(() => {
    chamadosPaginacao.page = 1;
    loadChamados();
  }, 350);
}

// ===== ANEXOS PENDENTES (modal Novo Chamado) =====
let arquivosPendentesChamado = [];

function inicializarDropzoneChamado() {
  const dropzone = document.getElementById('dropzone-chamado');
  const fileInput = document.getElementById('file-input-chamado');
  if (!dropzone || !fileInput) return;

  fileInput.addEventListener('change', e => {
    adicionarArquivosChamado(Array.from(e.target.files || []));
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
    adicionarArquivosChamado(Array.from(e.dataTransfer.files || []));
  });
}

function adicionarArquivosChamado(arquivos) {
  for (const arq of arquivos) {
    if (arq.size > 10 * 1024 * 1024) {
      alert(`"${arq.name}" tem mais de 10 MB e foi ignorado.`);
      continue;
    }
    arquivosPendentesChamado.push(arq);
  }
  renderListaPendentesChamado();
}

function renderListaPendentesChamado() {
  const ul = document.getElementById('lista-pendentes-chamado');
  if (!ul) return;
  ul.innerHTML = arquivosPendentesChamado.map((a, i) => `
    <li>
      <span class="nome" title="${escapeHtml(a.name)}">📎 ${escapeHtml(a.name)}</span>
      <span class="tamanho">${formatarTamanhoDash(a.size)}</span>
      <button type="button" class="remover" onclick="removerPendenteChamado(${i})" title="Remover">×</button>
    </li>
  `).join('');
}

function removerPendenteChamado(i) {
  arquivosPendentesChamado.splice(i, 1);
  renderListaPendentesChamado();
}

async function salvarChamado() {
  const form = document.getElementById('form-chamado');
  const dados = {
    titulo: form.titulo.value,
    descricao: form.descricao.value,
    cliente_id: form.cliente_id.value || null,
    tecnologia_id: form.tecnologia_id.value || null,
    prioridade: form.prioridade.value,
    categoria: form.categoria.value
  };

  if (chamadoEmEdicao) {
    dados.status = form.status?.value;
  }

  try {
    const url = chamadoEmEdicao ? `${API_URL}/chamados/${chamadoEmEdicao}` : `${API_URL}/chamados`;
    const method = chamadoEmEdicao ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: JSON.stringify(dados) });
    if (!res) return;
    if (!res.ok) { const e = await res.json(); alert(e.erro); return; }

    const data = await res.json();

    // Se for novo chamado e há anexos pendentes, faz upload sequencial
    if (!chamadoEmEdicao && data.chamado && arquivosPendentesChamado.length > 0) {
      const progresso = document.getElementById('upload-progresso-chamado');
      const fill = document.getElementById('progress-fill-chamado');
      const status = document.getElementById('upload-status-chamado');
      progresso.style.display = 'block';

      for (let i = 0; i < arquivosPendentesChamado.length; i++) {
        status.textContent = `Enviando anexo ${i + 1} de ${arquivosPendentesChamado.length}: ${arquivosPendentesChamado[i].name}`;
        const fd = new FormData();
        fd.append('arquivo', arquivosPendentesChamado[i]);
        try {
          const r = await fetch(`${API_URL}/chamados/${data.chamado.id}/anexos`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body: fd
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            alert(`Falha ao enviar "${arquivosPendentesChamado[i].name}": ${e.erro || 'erro'}`);
          }
        } catch (err) {
          alert(`Falha ao enviar "${arquivosPendentesChamado[i].name}": ${err.message}`);
        }
        fill.style.width = `${((i + 1) / arquivosPendentesChamado.length) * 100}%`;
      }
    }

    arquivosPendentesChamado = [];
    closeModal(document.getElementById('modal-chamado'));
    loadChamados();
    loadDashboard();
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

async function editarChamado(id) {
  const res = await apiFetch(`${API_URL}/chamados/${id}`);
  if (!res) return;
  const ch = await res.json();

  chamadoEmEdicao = id;
  await preencherSelectsChamado();

  const form = document.getElementById('form-chamado');
  form.titulo.value = ch.titulo || '';
  form.descricao.value = ch.descricao || '';
  form.cliente_id.value = ch.cliente_id || '';
  form.tecnologia_id.value = ch.tecnologia_id || '';
  form.prioridade.value = ch.prioridade || 'media';
  form.categoria.value = ch.categoria || '';

  // Mostrar campo de status ao editar; esconder anexos (uso o painel do detalhe)
  document.getElementById('campo-status-chamado').style.display = 'block';
  document.getElementById('campo-anexos-chamado').style.display = 'none';
  if (form.status) form.status.value = ch.status || 'aberto';

  document.getElementById('modal-chamado-titulo').textContent = `Editar Chamado #${id}`;
  showModal('#modal-chamado');
}

async function deletarChamado(id) {
  if (!confirm('Deseja remover este chamado?')) return;
  const res = await apiFetch(`${API_URL}/chamados/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  alert('Chamado removido!');
  loadChamados();
  loadDashboard();
}

// ===== DETALHE DO CHAMADO + ATENDIMENTOS =====
async function abrirDetalheChamado(id) {
  const res = await apiFetch(`${API_URL}/chamados/${id}`);
  if (!res) return;
  const ch = await res.json();

  document.getElementById('detalhe-chamado-titulo').textContent = `Chamado #${ch.id} — ${ch.titulo}`;
  document.getElementById('atendimento-chamado-id').value = ch.id;

  document.getElementById('detalhe-chamado-info').innerHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px,1fr)); gap:0.75rem;">
      <div><strong>Cliente:</strong> ${escapeHtml(ch.cliente_nome || '-')}</div>
      <div><strong>Tecnologia:</strong> ${escapeHtml(ch.tecnologia_nome || '-')}</div>
      <div><strong>Status:</strong> ${badgeStatus(ch.status)}</div>
      <div><strong>Prioridade:</strong> ${badgePrioridade(ch.prioridade)}</div>
      ${ch.sla && ch.sla.sla_status !== 'concluido' ? `<div><strong>SLA:</strong> ${badgeSlaInlineDetalhe(ch.sla)}</div>` : ''}
      <div><strong>Categoria:</strong> ${escapeHtml(ch.categoria || '-')}</div>
      <div><strong>Abertura:</strong> ${formatData(ch.data_abertura)}</div>
      <div><strong>Aberto por:</strong> ${escapeHtml(ch.aberto_por_nome || '-')}</div>
      <div><strong>Atribuído para:</strong> ${escapeHtml(ch.atribuido_para_nome || '-')}</div>
      ${ch.avaliacao ? `<div><strong>Avaliação:</strong> <span style="color:#f59e0b">${'★'.repeat(ch.avaliacao.nota)}${'☆'.repeat(5 - ch.avaliacao.nota)}</span></div>` : ''}
    </div>
    ${ch.descricao ? `<div style="margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid #e2e8f0"><strong>Descrição:</strong><br>${escapeHtml(ch.descricao)}</div>` : ''}
    ${ch.avaliacao && ch.avaliacao.comentario ? `<div style="margin-top:0.75rem; padding:0.75rem; background:#fef3c720; border-left:3px solid #f59e0b; border-radius:6px"><strong>Comentário do cliente:</strong><br><em>"${escapeHtml(ch.avaliacao.comentario)}"</em></div>` : ''}
  `;

  renderTimeline(ch.atendimentos || []);
  renderAnexosDashboard(ch);
  resetForm('#form-atendimento');
  document.getElementById('atendimento-chamado-id').value = ch.id;

  showModal('#modal-detalhe-chamado');

  // Marca atendimentos como lidos para o usuário atual
  apiFetch(`${API_URL}/chamados/${id}/marcar-lido`, { method: 'POST' }).catch(() => {});
}

function renderAnexosDashboard(ch) {
  let wrapper = document.getElementById('anexos-dashboard');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'anexos-dashboard';
    wrapper.style.cssText = 'padding: 0 0.5rem 0.75rem; margin-bottom:0.75rem;';
    const timeline = document.getElementById('timeline-atendimentos');
    timeline.parentNode.insertBefore(wrapper, timeline);
  }
  const anexos = ch.anexos || [];
  const imagens = anexos.filter(a => a.preview_url);
  const arquivos = anexos.filter(a => !a.preview_url);

  wrapper.innerHTML = `
    <h4 style="margin-bottom:0.5rem; color:#0d6efd; font-size:13px;">Anexos ${anexos.length ? `(${anexos.length})` : ''}</h4>

    ${imagens.length ? `
      <div class="thumbs-grid-dash">
        ${imagens.map(a => `
          <div class="thumb-card-dash">
            <div class="thumb-img-dash" style="background-image:url('${escapeHtml(a.preview_url)}')"
                 data-url="${escapeHtml(a.preview_url)}" data-legenda="${escapeHtml(a.nome_original)}"
                 onclick="abrirLightboxDashFromCard(this)"></div>
            <div class="thumb-info-dash">
              <span title="${escapeHtml(a.nome_original)}">${escapeHtml(a.nome_original)}</span>
              <div class="thumb-actions-dash">
                <small>${formatarTamanhoDash(a.tamanho_bytes)} · ${escapeHtml(a.enviado_por_nome || '')}</small>
                <button class="btn btn-danger" onclick="removerAnexoDashboard(${ch.id}, ${a.id})">×</button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${arquivos.length ? `
      <ul style="list-style:none; padding:0; margin-bottom:8px;">
        ${arquivos.map(a => `
          <li style="display:flex; align-items:center; gap:8px; padding:5px 0; border-bottom:1px solid #e2e8f0; font-size:13px;">
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(a.nome_original)}">📎 ${escapeHtml(a.nome_original)}</span>
            <span style="font-size:11px; color:#94a3b8;">${formatarTamanhoDash(a.tamanho_bytes)} · ${escapeHtml(a.enviado_por_nome || '')}</span>
            <button class="btn btn-edit" onclick="baixarAnexoDashboard(${ch.id}, ${a.id})">Baixar</button>
            <button class="btn btn-danger" onclick="removerAnexoDashboard(${ch.id}, ${a.id})">×</button>
          </li>
        `).join('')}
      </ul>
    ` : ''}

    ${anexos.length === 0 ? '<p style="font-size:12.5px; color:#94a3b8; margin-bottom:8px;">Nenhum anexo.</p>' : ''}

    <label style="display:inline-block; background:white; color:#0d6efd; border:1px dashed #0d6efd; border-radius:6px; padding:5px 12px; font-size:12.5px; font-weight:600; cursor:pointer;">
      + Enviar anexo
      <input type="file" hidden onchange="enviarAnexoDashboard(${ch.id}, this)">
    </label>
    <small style="margin-left:8px; font-size:11px; color:#94a3b8;">Máx 10 MB</small>
  `;
}

// Wrapper que pega url+legenda dos data-attributes; evita XSS via onclick com strings.
function abrirLightboxDashFromCard(el) {
  abrirLightboxDash(el.dataset.url, el.dataset.legenda);
}

function abrirLightboxDash(url, legenda) {
  let lb = document.getElementById('lightbox-dash');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox-dash';
    lb.className = 'lightbox-dash';
    lb.onclick = () => lb.classList.remove('show');
    document.body.appendChild(lb);
  }
  // Constrói o conteúdo via DOM API (textContent/setAttribute escapam por padrão).
  lb.innerHTML = '';
  const btnFechar = document.createElement('button');
  btnFechar.className = 'lightbox-dash-fechar';
  btnFechar.innerHTML = '&times;';
  btnFechar.onclick = (e) => { e.stopPropagation(); lb.classList.remove('show'); };
  const img = document.createElement('img');
  img.className = 'lightbox-dash-img';
  img.src = url;
  img.alt = legenda || '';
  img.onclick = (e) => e.stopPropagation();
  const cap = document.createElement('div');
  cap.className = 'lightbox-dash-legenda';
  cap.textContent = legenda || '';
  lb.appendChild(btnFechar);
  lb.appendChild(img);
  lb.appendChild(cap);
  lb.classList.add('show');
}

function formatarTamanhoDash(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

async function enviarAnexoDashboard(chamadoId, input) {
  if (!input.files || !input.files[0]) return;
  const arquivo = input.files[0];
  if (arquivo.size > 10 * 1024 * 1024) { alert('Máximo 10 MB.'); input.value = ''; return; }

  const formData = new FormData();
  formData.append('arquivo', arquivo);

  const res = await fetch(`${API_URL}/chamados/${chamadoId}/anexos`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
    body: formData
  });
  input.value = '';
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    alert(e.erro || 'Erro ao enviar anexo.');
    return;
  }
  await abrirDetalheChamado(chamadoId);
}

async function baixarAnexoDashboard(chamadoId, anexoId) {
  const res = await apiFetch(`${API_URL}/chamados/${chamadoId}/anexos/${anexoId}/download`);
  if (!res || !res.ok) { alert('Erro ao baixar.'); return; }
  const data = await res.json();
  window.open(data.url, '_blank');
}

async function removerAnexoDashboard(chamadoId, anexoId) {
  if (!confirm('Remover este anexo?')) return;
  const res = await apiFetch(`${API_URL}/chamados/${chamadoId}/anexos/${anexoId}`, { method: 'DELETE' });
  if (!res || !res.ok) { const e = res ? await res.json() : {}; alert(e.erro || 'Erro ao remover.'); return; }
  await abrirDetalheChamado(chamadoId);
}

function badgeSlaInlineDetalhe(sla) {
  if (!sla) return '';
  if (sla.sla_status === 'estourado') return '<span style="color:#ef4444; font-weight:600">⏱ Estourado</span>';
  const h = Math.max(0, Math.floor(sla.restante_minutos / 60));
  const cor = sla.sla_status === 'alerta' ? '#f59e0b' : '#10b981';
  return `<span style="color:${cor}; font-weight:600">⏱ ${h}h restantes</span>`;
}

function renderTimeline(atendimentos) {
  const container = document.getElementById('timeline-atendimentos');
  if (!atendimentos.length) {
    container.innerHTML = '<p style="color:#94a3b8; font-size:0.9rem; text-align:center; padding:1rem 0;">Nenhum atendimento registrado ainda.</p>';
    return;
  }

  container.innerHTML = atendimentos.map(a => `
    <div class="timeline-item">
      <div class="timeline-badge badge-tipo-${escapeHtml(a.tipo)}"></div>
      <div class="timeline-content">
        <div class="timeline-header">
          <span class="timeline-tipo">${badgeTipoAtendimento(a.tipo)}</span>
          <span class="timeline-meta">${escapeHtml(a.usuario_nome || 'Sistema')} — ${formatDataHora(a.data_atendimento)}</span>
          ${a.tempo_gasto_minutos > 0 ? `<span style="color:#94a3b8; font-size:0.78rem">⏱ ${a.tempo_gasto_minutos}min</span>` : ''}
        </div>
        <div class="timeline-desc">${escapeHtml(a.descricao)}</div>
      </div>
    </div>
  `).join('');
}

async function salvarAtendimento() {
  const form = document.getElementById('form-atendimento');
  const dados = {
    chamado_id: parseInt(form.chamado_id.value),
    tipo: form.tipo.value,
    descricao: form.descricao.value,
    tempo_gasto_minutos: parseInt(form.tempo_gasto_minutos.value) || 0
  };

  try {
    const res = await apiFetch(`${API_URL}/atendimentos`, { method: 'POST', body: JSON.stringify(dados) });
    if (!res) return;
    if (!res.ok) { const e = await res.json(); alert(e.erro); return; }

    // Recarregar o detalhe do chamado
    await abrirDetalheChamado(dados.chamado_id);
    loadChamados();
    loadDashboard();
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

// ===== TRANSAÇÕES =====
async function loadTransacoes() {
  const tbody = document.getElementById('transacoes-tbody');
  if (tbody && _transacoesCache.length === 0) tbody.innerHTML = skeletonRows(6);
  const res = await apiFetch(`${API_URL}/transacoes`);
  if (!res) return;
  const dados = await res.json();
  _transacoesCache = dados.transacoes || [];
  popularSelectsTransacoes(_transacoesCache);
  renderTransacoes();
}

function popularSelectsTransacoes(lista) {
  const categorias = [...new Set(lista.map(t => t.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  preencherSelectOptions('filtro-transacoes-categoria', categorias);

  // datalist no modal
  const dl = document.getElementById('categorias-transacao');
  if (dl) dl.innerHTML = categorias.map(c => `<option value="${escapeHtml(c)}">`).join('');
}

function renderTransacoes() {
  const tbody = document.getElementById('transacoes-tbody');

  const busca = (document.getElementById('filtro-transacoes-busca')?.value || '').trim().toLowerCase();
  const tipo = document.getElementById('filtro-transacoes-tipo')?.value || '';
  const categoria = document.getElementById('filtro-transacoes-categoria')?.value || '';
  const dataDe = document.getElementById('filtro-transacoes-data-de')?.value || '';
  const dataAte = document.getElementById('filtro-transacoes-data-ate')?.value || '';
  const ordem = document.getElementById('filtro-transacoes-ordenar')?.value || 'data_desc';

  const dataDeMs = dataDe ? new Date(dataDe + 'T00:00:00').getTime() : null;
  const dataAteMs = dataAte ? new Date(dataAte + 'T23:59:59').getTime() : null;

  let lista = _transacoesCache.filter(t => {
    if (tipo && t.tipo !== tipo) return false;
    if (categoria && t.categoria !== categoria) return false;
    if (dataDeMs || dataAteMs) {
      const dms = t.data ? new Date(t.data).getTime() : 0;
      if (dataDeMs && dms < dataDeMs) return false;
      if (dataAteMs && dms > dataAteMs) return false;
    }
    if (busca) {
      const alvo = [t.categoria, t.descricao].filter(Boolean).join(' ').toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  // Ordenação
  switch (ordem) {
    case 'data_asc': lista.sort((a, b) => new Date(a.data || 0) - new Date(b.data || 0)); break;
    case 'valor_desc': lista.sort((a, b) => parseFloat(b.valor) - parseFloat(a.valor)); break;
    case 'valor_asc': lista.sort((a, b) => parseFloat(a.valor) - parseFloat(b.valor)); break;
    case 'categoria_asc': lista.sort((a, b) => (a.categoria || '').localeCompare(b.categoria || '', 'pt-BR')); break;
    case 'tipo': lista.sort((a, b) => (a.tipo || '').localeCompare(b.tipo || '') || (new Date(b.data || 0) - new Date(a.data || 0))); break;
    case 'data_desc':
    default: lista.sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0));
  }

  // Totais (sobre o filtro)
  let totEntradas = 0, totSaidas = 0, qtdEntradas = 0, qtdSaidas = 0;
  lista.forEach(t => {
    const v = parseFloat(t.valor) || 0;
    if (t.tipo === 'entrada') { totEntradas += v; qtdEntradas++; }
    else if (t.tipo === 'saída') { totSaidas += v; qtdSaidas++; }
  });
  const saldo = totEntradas - totSaidas;
  const elEntradas = document.getElementById('totais-entradas');
  const elSaidas = document.getElementById('totais-saidas');
  const elSaldo = document.getElementById('totais-saldo');
  if (elEntradas) elEntradas.textContent = formatMoeda(totEntradas);
  if (elSaidas) elSaidas.textContent = formatMoeda(totSaidas);
  if (elSaldo) {
    elSaldo.textContent = formatMoeda(saldo);
    elSaldo.style.color = saldo < 0 ? '#ef4444' : (saldo > 0 ? '#10b981' : '');
  }
  const elQtdE = document.getElementById('totais-qtd-entradas');
  const elQtdS = document.getElementById('totais-qtd-saidas');
  const elQtdT = document.getElementById('totais-qtd-total');
  if (elQtdE) elQtdE.textContent = `${qtdEntradas} lançamento(s)`;
  if (elQtdS) elQtdS.textContent = `${qtdSaidas} lançamento(s)`;
  if (elQtdT) elQtdT.textContent = `${lista.length} de ${_transacoesCache.length} lançamento(s)`;

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">${_transacoesCache.length === 0 ? 'Nenhuma transação cadastrada' : 'Nenhuma transação para os filtros aplicados'}</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(t => `
    <tr>
      <td data-label="Data">${formatData(t.data)}</td>
      <td data-label="Tipo"><span class="badge badge-${t.tipo === 'entrada' ? 'resolvido' : 'alta'}">${t.tipo === 'entrada' ? 'Entrada' : 'Saída'}</span></td>
      <td data-label="Categoria">
        ${escapeHtml(t.categoria)}
        ${auditMeta(t)}
      </td>
      <td data-label="Descrição">${escapeHtml(t.descricao || '-')}</td>
      <td data-label="Valor"><strong style="color:${t.tipo === 'entrada' ? '#10b981' : '#ef4444'}">${t.tipo === 'saída' ? '- ' : ''}${formatMoeda(t.valor)}</strong></td>
      <td data-label="Ações" class="td-acoes">
        <button class="btn btn-icon btn-edit" title="Editar" aria-label="Editar" onclick="editarTransacao(${t.id})">${iconSVG('edit')}</button>
        <button class="btn btn-icon btn-danger" title="Deletar" aria-label="Deletar" onclick="deletarTransacao(${t.id})">${iconSVG('trash')}</button>
      </td>
    </tr>
  `).join('');
}

let _filtroTransacoesTimer = null;
function onFiltroTransacoesChange(debounce = false) {
  if (debounce) {
    clearTimeout(_filtroTransacoesTimer);
    _filtroTransacoesTimer = setTimeout(renderTransacoes, 250);
  } else {
    renderTransacoes();
  }
}

function limparFiltrosTransacoes() {
  ['filtro-transacoes-busca','filtro-transacoes-tipo','filtro-transacoes-categoria',
   'filtro-transacoes-data-de','filtro-transacoes-data-ate'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const ord = document.getElementById('filtro-transacoes-ordenar');
  if (ord) ord.value = 'data_desc';
  renderTransacoes();
}

async function editarTransacao(id) {
  const t = _transacoesCache.find(x => x.id === id);
  if (!t) { alert('Transação não encontrada.'); return; }

  transacaoEmEdicao = id;
  const form = document.getElementById('form-transacao');
  resetForm('#form-transacao');

  document.getElementById('modal-transacao-titulo').textContent = `Editar Transação #${id}`;
  document.getElementById('transacao-id').value = id;
  form.tipo.value = t.tipo || '';
  form.valor.value = t.valor != null ? parseFloat(t.valor) : '';
  form.categoria.value = t.categoria || '';
  form.descricao.value = t.descricao || '';
  if (form.data) form.data.value = t.data ? String(t.data).split('T')[0] : '';

  const btn = document.getElementById('btn-salvar-transacao');
  if (btn) btn.textContent = 'Salvar Alterações';

  showModal('#modal-transacao');
}

async function salvarTransacao() {
  const form = document.getElementById('form-transacao');
  const dados = {
    tipo: form.tipo.value,
    valor: parseFloat(form.valor.value),
    categoria: form.categoria.value,
    descricao: form.descricao.value,
    data: form.data?.value || null
  };

  try {
    const url = transacaoEmEdicao ? `${API_URL}/transacoes/${transacaoEmEdicao}` : `${API_URL}/transacoes`;
    const method = transacaoEmEdicao ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: JSON.stringify(dados) });
    if (!res) return;
    if (!res.ok) { const e = await res.json(); alert(e.erro || 'Erro ao salvar'); return; }
    alert(transacaoEmEdicao ? 'Transação atualizada!' : 'Transação criada!');
    transacaoEmEdicao = null;
    closeModal(document.getElementById('modal-transacao'));
    loadTransacoes();
    loadDashboard();
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

async function deletarTransacao(id) {
  if (!confirm('Deseja deletar esta transação?')) return;
  const res = await apiFetch(`${API_URL}/transacoes/${id}`, { method: 'DELETE' });
  if (!res) return;
  alert('Transação deletada!');
  loadTransacoes();
  loadDashboard();
}

// ===== USUÁRIOS =====
async function preencherSelectClientesUsuario() {
  const res = await apiFetch(`${API_URL}/clientes`);
  if (!res) return;
  const lista = await res.json();
  const sel = document.getElementById('select-cliente-usuario');
  sel.innerHTML = '<option value="">Selecione o cliente...</option>' +
    lista.map(c => `<option value="${c.id}">${c.razao_social || c.nome}</option>`).join('');
}

function toggleClienteSelect() {
  const tipo = document.querySelector('#form-usuario [name="tipo"]').value;
  const campo = document.getElementById('campo-cliente-usuario');
  const sel = document.getElementById('select-cliente-usuario');
  if (tipo === 'cliente') {
    campo.style.display = 'block';
    sel.required = true;
  } else {
    campo.style.display = 'none';
    sel.required = false;
  }
}

async function loadUsuarios() {
  const tbody = document.getElementById('usuarios-tbody');
  if (tbody && _usuariosCache.length === 0) tbody.innerHTML = skeletonRows(6);
  const res = await apiFetch(`${API_URL}/usuarios`);
  if (!res) return;
  _usuariosCache = await res.json();
  popularSelectsUsuarios(_usuariosCache);
  renderUsuarios();
}

function popularSelectsUsuarios(lista) {
  const clientes = [...new Map(lista
    .filter(u => u.cliente_id && u.cliente_nome)
    .map(u => [u.cliente_id, u.cliente_nome])
  ).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'pt-BR'));

  const sel = document.getElementById('filtro-usuarios-cliente');
  if (!sel) return;
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todos os vínculos</option><option value="sem_vinculo">Sem vínculo</option>' +
    clientes.map(([id, nome]) => `<option value="${id}">${escapeHtml(nome)}</option>`).join('');
  if (atual) sel.value = atual;
}

function renderUsuarios() {
  const tbody = document.getElementById('usuarios-tbody');
  const contador = document.getElementById('filtro-usuarios-contador');

  const busca = (document.getElementById('filtro-usuarios-busca')?.value || '').trim().toLowerCase();
  const perfil = document.getElementById('filtro-usuarios-perfil')?.value || '';
  const status = document.getElementById('filtro-usuarios-status')?.value || '';
  const cliente = document.getElementById('filtro-usuarios-cliente')?.value || '';
  const ordem = document.getElementById('filtro-usuarios-ordenar')?.value || 'nome_asc';

  let lista = _usuariosCache.filter(u => {
    if (perfil && u.tipo !== perfil) return false;
    if (status === 'ativo' && u.ativo === false) return false;
    if (status === 'inativo' && u.ativo !== false) return false;
    if (cliente === 'sem_vinculo' && u.cliente_id) return false;
    if (cliente && cliente !== 'sem_vinculo' && String(u.cliente_id) !== String(cliente)) return false;
    if (busca) {
      const alvo = [u.nome, u.email, u.cliente_nome].filter(Boolean).join(' ').toLowerCase();
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });

  switch (ordem) {
    case 'nome_desc': lista.sort((a, b) => (b.nome || '').localeCompare(a.nome || '', 'pt-BR')); break;
    case 'perfil': lista.sort((a, b) => (a.tipo || '').localeCompare(b.tipo || '') || (a.nome || '').localeCompare(b.nome || '', 'pt-BR')); break;
    case 'recentes': lista.sort((a, b) => new Date(b.data_criacao || 0) - new Date(a.data_criacao || 0)); break;
    case 'nome_asc':
    default: lista.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
  }

  if (contador) contador.textContent = `${lista.length} de ${_usuariosCache.length}`;

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">${_usuariosCache.length === 0 ? 'Nenhum usuário cadastrado' : 'Nenhum usuário para os filtros aplicados'}</td></tr>`;
    return;
  }

  const tipoLabel = {
    admin_sistema: { label: 'Admin Sistema', color: '#ef4444' },
    admin_empresa: { label: 'Administrador', color: '#0d6efd' },
    tecnico:       { label: 'Técnico',        color: '#f59e0b' },
    cliente:       { label: 'Cliente',         color: '#10b981' }
  };

  tbody.innerHTML = lista.map(u => {
    const t = tipoLabel[u.tipo] || { label: escapeHtml(u.tipo), color: '#64748b' };
    const ehVoce = u.id === usuario?.id;
    return `
      <tr>
        <td data-label="Nome"><strong>${escapeHtml(u.nome)}</strong>${ehVoce ? ' <small style="color:#94a3b8">(você)</small>' : ''}</td>
        <td data-label="Email">${escapeHtml(u.email)}</td>
        <td data-label="Perfil"><span style="background:${t.color}20;color:${t.color};padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:600">${t.label}</span></td>
        <td data-label="Vinculado a">${escapeHtml(u.cliente_nome || '') || (u.tipo === 'cliente' ? '<span style="color:#ef4444">⚠ sem vínculo</span>' : '—')}</td>
        <td data-label="Status">${u.ativo !== false
          ? '<span style="background:#10b98120;color:#10b981;padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:600">Ativo</span>'
          : '<span style="background:#ef444420;color:#ef4444;padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:600">Inativo</span>'
        }</td>
        <td data-label="Ações" class="td-acoes">
          <button class="btn btn-icon btn-edit" title="Editar" aria-label="Editar" onclick="abrirEditarUsuario(${u.id}, '${u.nome.replace(/'/g, "\\'")}', '${u.email}', '${u.tipo}', ${u.cliente_id || 'null'})">${iconSVG('edit')}</button>
          <button class="btn btn-icon btn-edit" title="Redefinir senha" aria-label="Redefinir senha" onclick="abrirResetSenha(${u.id}, '${u.nome.replace(/'/g, "\\'")}')">${iconSVG('key')}</button>
          ${u.ativo !== false
            ? `<button class="btn btn-icon btn-danger" title="${ehVoce ? 'Não pode desativar a si mesmo' : 'Desativar'}" aria-label="Desativar" onclick="desativarUsuario(${u.id})"${ehVoce ? ' disabled' : ''}>${iconSVG('ban')}</button>`
            : `<button class="btn btn-icon btn-edit" title="Reativar" aria-label="Reativar" onclick="reativarUsuario(${u.id})">${iconSVG('check')}</button>`
          }
        </td>
      </tr>
    `;
  }).join('');
}

let _filtroUsuariosTimer = null;
function onFiltroUsuariosChange(debounce = false) {
  if (debounce) {
    clearTimeout(_filtroUsuariosTimer);
    _filtroUsuariosTimer = setTimeout(renderUsuarios, 250);
  } else {
    renderUsuarios();
  }
}

async function abrirEditarUsuario(id, nome, email, tipo, cliente_id) {
  usuarioEmEdicao = { id };
  resetForm('#form-usuario');
  document.getElementById('modal-usuario-titulo').textContent = 'Editar Usuário';

  // Senha não obrigatória na edição
  document.getElementById('campo-senha-usuario').style.display = 'none';
  document.querySelector('#form-usuario [name="senha"]').required = false;

  await preencherSelectClientesUsuario();

  document.querySelector('#form-usuario [name="nome"]').value = nome;
  document.querySelector('#form-usuario [name="email"]').value = email;
  document.querySelector('#form-usuario [name="email"]').disabled = true;
  document.querySelector('#form-usuario [name="tipo"]').value = tipo;

  toggleClienteSelect();

  if (cliente_id) {
    document.getElementById('select-cliente-usuario').value = cliente_id;
  }

  showModal('#modal-usuario');
}

async function salvarUsuario() {
  const form = document.getElementById('form-usuario');
  const emailField = document.querySelector('#form-usuario [name="email"]');

  const dados = {
    nome: form.nome.value,
    tipo: form.tipo.value,
    cliente_id: form.cliente_id?.value || null
  };

  try {
    let res;
    if (usuarioEmEdicao) {
      // Edição — PUT
      res = await apiFetch(`${API_URL}/usuarios/${usuarioEmEdicao.id}`, {
        method: 'PUT',
        body: JSON.stringify(dados)
      });
    } else {
      // Criação — POST
      dados.email = emailField.value;
      dados.senha = form.senha.value;
      res = await apiFetch(`${API_URL}/usuarios`, {
        method: 'POST',
        body: JSON.stringify(dados)
      });
    }

    if (!res) return;

    if (!res.ok) {
      const err = await res.json();
      alert(err.erro || 'Erro ao salvar usuário');
      return;
    }

    alert(usuarioEmEdicao ? 'Usuário atualizado!' : 'Usuário criado com sucesso! Compartilhe o email e senha com o usuário.');
    emailField.disabled = false;
    closeModal(document.getElementById('modal-usuario'));
    loadUsuarios();
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

function abrirResetSenha(id, nome) {
  document.getElementById('reset-usuario-id').value = id;
  document.getElementById('reset-usuario-nome').textContent = nome;
  document.querySelector('#form-reset-senha [name="nova_senha"]').value = '';
  showModal('#modal-reset-senha');
}

async function salvarResetSenha() {
  const id = document.getElementById('reset-usuario-id').value;
  const nova_senha = document.querySelector('#form-reset-senha [name="nova_senha"]').value;

  const res = await apiFetch(`${API_URL}/usuarios/${id}/senha`, {
    method: 'PUT',
    body: JSON.stringify({ nova_senha })
  });
  if (!res) return;

  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  alert('Senha redefinida com sucesso!');
  closeModal(document.getElementById('modal-reset-senha'));
}

async function desativarUsuario(id) {
  if (!confirm('Deseja desativar este usuário? Ele perderá o acesso imediatamente.')) return;
  const res = await apiFetch(`${API_URL}/usuarios/${id}`, { method: 'DELETE' });
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  loadUsuarios();
}

async function reativarUsuario(id) {
  const res = await apiFetch(`${API_URL}/usuarios/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ ativo: true })
  });
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  alert('Usuário reativado!');
  loadUsuarios();
}

// ===== UTILITIES =====
function showModal(selector) {
  document.querySelector(selector).classList.add('show');
}

function closeModal(modal) {
  if (modal) modal.classList.remove('show');
}

function resetForm(selector) {
  const f = document.querySelector(selector);
  if (f) f.reset();
}

// ===== ESCAPE HTML =====
// Aplica em qualquer dado user-controlled (titulo, descricao, nomes, anexos, etc)
// antes de injetar via innerHTML em template strings. Defesa contra XSS persistente.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);
}

function formatData(val) {
  if (!val) return '-';
  return new Date(val).toLocaleDateString('pt-BR');
}

function formatDataHora(val) {
  if (!val) return '-';
  return new Date(val).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Ícones Lucide (subset) — substitui emojis nos botões de ação.
// Stroke=currentColor para herdar a cor do botão. 16x16 com stroke 2.
const _ICONS = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/>',
  ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
};
function iconSVG(name, size = 16) {
  const body = _ICONS[name];
  if (!body) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * Gera linhas-fantasma para uma tabela enquanto a API responde.
 * @param {number} cols - quantas colunas (= colspan da tabela)
 * @param {number} rows - quantas linhas-fantasma (default 5)
 */
function skeletonRows(cols, rows = 5) {
  const padroes = ['sk-md', 'sk-lg', 'sk-sm', 'sk-pill', 'sk-md', 'sk-sm', 'sk-lg'];
  let html = '';
  for (let r = 0; r < rows; r++) {
    html += '<tr class="skeleton-row">';
    for (let c = 0; c < cols; c++) {
      const tipo = padroes[(r + c) % padroes.length];
      html += `<td><span class="skeleton-bar ${tipo}"></span></td>`;
    }
    html += '</tr>';
  }
  return html;
}

/**
 * Anima um contador numérico de 0 (ou valor atual) até o valor final.
 * Aceita inteiros ou strings tipo "R$ 1.234,56" — preserva o prefixo/sufixo.
 */
function animateCounter(el, valorFinal, opts = {}) {
  if (!el) return;
  const dur = opts.duration ?? 700;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = opts.formatter ? opts.formatter(valorFinal) : String(valorFinal);
    return;
  }
  el.classList.add('is-counting');
  const start = performance.now();
  const from = 0;
  const to = Number(valorFinal) || 0;
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    const v = from + (to - from) * eased;
    el.textContent = opts.formatter ? opts.formatter(v) : Math.round(v).toString();
    if (t < 1) requestAnimationFrame(step);
    else { el.classList.remove('is-counting'); el.textContent = opts.formatter ? opts.formatter(to) : String(to); }
  }
  requestAnimationFrame(step);
}

/**
 * Cola o efeito ripple em qualquer botão acionado por clique.
 * Coordenadas relativas ao botão alimentam --ripple-x/y no CSS.
 */
function _bindRipple() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-primary, .btn-login, .btn-edit:not(.btn-icon), .btn-danger:not(.btn-icon)');
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    btn.style.setProperty('--ripple-x', `${e.clientX - rect.left}px`);
    btn.style.setProperty('--ripple-y', `${e.clientY - rect.top}px`);
    btn.classList.remove('is-rippling');
    void btn.offsetWidth; // força reflow para reiniciar animação
    btn.classList.add('is-rippling');
    setTimeout(() => btn.classList.remove('is-rippling'), 600);
  });
}
document.addEventListener('DOMContentLoaded', _bindRipple);

// Preenche um <select> de filtro mantendo a 1ª <option> (placeholder) e o valor atualmente selecionado.
function preencherSelectOptions(selectId, valores) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const placeholder = sel.querySelector('option:first-child');
  const placeholderHTML = placeholder ? placeholder.outerHTML : '';
  const atual = sel.value;
  sel.innerHTML = placeholderHTML + valores
    .map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  if (atual && valores.includes(atual)) sel.value = atual;
}

// Validação de CPF/CNPJ no client-side (mesma lógica do services/validacao.js)
function _digits(s) { return String(s || '').replace(/\D/g, ''); }

function validarCPFFront(cpf) {
  const d = _digits(cpf);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
  let v = (s * 10) % 11; if (v === 10) v = 0;
  if (v !== parseInt(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
  v = (s * 10) % 11; if (v === 10) v = 0;
  return v === parseInt(d[10]);
}

function validarCNPJFront(cnpj) {
  const d = _digits(cnpj);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const p1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  let s = 0;
  for (let i = 0; i < 12; i++) s += parseInt(d[i]) * p1[i];
  let v = s % 11; v = v < 2 ? 0 : 11 - v;
  if (v !== parseInt(d[12])) return false;
  const p2 = [6, ...p1];
  s = 0;
  for (let i = 0; i < 13; i++) s += parseInt(d[i]) * p2[i];
  v = s % 11; v = v < 2 ? 0 : 11 - v;
  return v === parseInt(d[13]);
}

function validarDocumentoFront(doc) {
  const d = _digits(doc);
  if (d.length === 11) return validarCPFFront(d);
  if (d.length === 14) return validarCNPJFront(d);
  return false;
}

// Linha de auditoria: "Criado por X em DD/MM • Editado por Y em DD/MM"
// Aceita tanto criado_por_nome (clientes/fornecedores/etc) quanto aberto_por_nome (chamados).
function auditMeta(item) {
  if (!item) return '';
  const criadoPor = item.criado_por_nome || item.aberto_por_nome;
  const dataCriacao = item.data_criacao || item.data_abertura;
  const atualizadoPor = item.atualizado_por_nome;
  const dataAtualizacao = item.data_atualizacao;

  if (!criadoPor && !dataCriacao && !atualizadoPor && !dataAtualizacao) return '';

  const partes = [];
  if (criadoPor || dataCriacao) {
    let p = 'Criado';
    if (criadoPor) p += ` por ${criadoPor}`;
    if (dataCriacao) p += ` em ${formatData(dataCriacao)}`;
    partes.push(p);
  }
  if (atualizadoPor || dataAtualizacao) {
    let p = 'Editado';
    if (atualizadoPor) p += ` por ${atualizadoPor}`;
    if (dataAtualizacao) p += ` em ${formatData(dataAtualizacao)}`;
    partes.push(p);
  }

  const texto = partes.join(' • ');
  const tooltip = [
    criadoPor || dataCriacao ? `Criado${criadoPor ? ' por ' + criadoPor : ''}${dataCriacao ? ' em ' + formatDataHora(dataCriacao) : ''}` : '',
    atualizadoPor || dataAtualizacao ? `Última edição${atualizadoPor ? ' por ' + atualizadoPor : ''}${dataAtualizacao ? ' em ' + formatDataHora(dataAtualizacao) : ''}` : ''
  ].filter(Boolean).join('\n');

  // Escapa antes de injetar no innerHTML — nome do usuário pode conter HTML.
  return `<div class="audit-meta" title="${escapeHtml(tooltip)}">${escapeHtml(texto)}</div>`;
}

// ===== BADGES =====
function badgeStatus(status) {
  const map = {
    aberto: { label: 'Aberto', color: '#0d6efd' },
    em_andamento: { label: 'Em andamento', color: '#f59e0b' },
    aguardando_cliente: { label: 'Aguardando', color: '#8b5cf6' },
    resolvido: { label: 'Resolvido', color: '#10b981' },
    fechado: { label: 'Fechado', color: '#64748b' }
  };
  const s = map[status] || { label: status, color: '#64748b' };
  return `<span style="background:${s.color}20; color:${s.color}; padding:2px 8px; border-radius:20px; font-size:0.78rem; font-weight:600">${s.label}</span>`;
}

function badgePrioridade(prioridade) {
  const map = {
    critica: { label: 'Crítica', color: '#ef4444' },
    alta: { label: 'Alta', color: '#f97316' },
    media: { label: 'Média', color: '#f59e0b' },
    baixa: { label: 'Baixa', color: '#10b981' }
  };
  const p = map[prioridade] || { label: prioridade, color: '#64748b' };
  return `<span style="background:${p.color}20; color:${p.color}; padding:2px 8px; border-radius:20px; font-size:0.78rem; font-weight:600">${p.label}</span>`;
}

function badgeStatusGeral(status) {
  const color = status === 'ativo' ? '#10b981' : status === 'suspenso' ? '#f59e0b' : '#ef4444';
  return `<span style="background:${color}20; color:${color}; padding:2px 8px; border-radius:20px; font-size:0.78rem; font-weight:600">${capitalize(status || 'ativo')}</span>`;
}

function badgeStatusTec(status) {
  const color = status === 'ativa' ? '#10b981' : '#ef4444';
  return `<span style="background:${color}20; color:${color}; padding:2px 8px; border-radius:20px; font-size:0.78rem; font-weight:600">${capitalize(status || 'ativa')}</span>`;
}

function badgeTipoAtendimento(tipo) {
  const map = {
    comentario: { label: 'Comentário', color: '#64748b' },
    contato_cliente: { label: 'Contato c/ cliente', color: '#0d6efd' },
    escalamento: { label: 'Escalamento', color: '#f59e0b' },
    solucao: { label: 'Solução', color: '#10b981' }
  };
  const t = map[tipo] || { label: tipo, color: '#64748b' };
  return `<span style="background:${t.color}20; color:${t.color}; padding:2px 6px; border-radius:4px; font-size:0.78rem; font-weight:600">${t.label}</span>`;
}
