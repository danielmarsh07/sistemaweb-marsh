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
    await preencherSelectsChamado();
    showModal('#modal-chamado');
  });

  document.getElementById('btn-nova-transacao').addEventListener('click', () => {
    resetForm('#form-transacao');
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
  try {
    const [resumo, transacoes, chamados] = await Promise.all([
      apiFetch(`${API_URL}/empresas/resumo`).then(r => r ? r.json() : {}),
      apiFetch(`${API_URL}/transacoes`).then(r => r ? r.json() : {}),
      apiFetch(`${API_URL}/chamados?status=aberto`).then(r => r ? r.json() : [])
    ]);

    if (resumo) {
      document.getElementById('total-clientes').textContent = resumo.clientes || 0;
      document.getElementById('total-fornecedores').textContent = resumo.fornecedores || 0;
      document.getElementById('total-tecnologias').textContent = resumo.tecnologias || 0;
      if (resumo.chamados) {
        const abertos = parseInt(resumo.chamados.abertos || 0) + parseInt(resumo.chamados.em_andamento || 0);
        document.getElementById('total-chamados-abertos').textContent = abertos;
      }
    }

    if (transacoes && transacoes.resumo) {
      const { totalEntradas, totalSaidas, saldo } = transacoes.resumo;
      document.getElementById('total-entradas').textContent = formatMoeda(totalEntradas);
      document.getElementById('total-saidas').textContent = formatMoeda(totalSaidas);
      document.getElementById('total-saldo').textContent = formatMoeda(saldo);
      if (saldo < 0) document.getElementById('total-saldo').style.color = '#ef4444';
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
      <td>#${ch.id}</td>
      <td>${ch.titulo}</td>
      <td>${ch.cliente_nome || '-'}</td>
      <td>${badgeStatus(ch.status)}</td>
      <td>${badgePrioridade(ch.prioridade)}</td>
      <td>${formatData(ch.data_criacao)}</td>
    </tr>
  `).join('');
}

// ===== CLIENTES =====
async function loadClientes() {
  const res = await apiFetch(`${API_URL}/clientes`);
  if (!res) return;
  const clientes = await res.json();
  const tbody = document.getElementById('clientes-tbody');

  if (!clientes.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">Nenhum cliente cadastrado</td></tr>';
    return;
  }

  tbody.innerHTML = clientes.map(c => `
    <tr>
      <td>
        <strong>${c.razao_social || c.nome}</strong>
        ${c.nome_fantasia ? `<br><small style="color:#94a3b8">${c.nome_fantasia}</small>` : ''}
      </td>
      <td>${c.cpf_cnpj || '-'}</td>
      <td>${c.responsavel_nome || c.email || '-'}</td>
      <td>${c.telefone || c.celular || '-'}</td>
      <td>${badgeStatusGeral(c.status)}</td>
      <td>
        ${parseInt(c.chamados_abertos) > 0
          ? `<span class="badge badge-aberto">${c.chamados_abertos} aberto(s)</span>`
          : '<span style="color:#94a3b8">0</span>'
        }
      </td>
      <td>
        <button class="btn btn-edit" onclick="editarCliente(${c.id})">Editar</button>
        <button class="btn btn-danger" onclick="deletarCliente(${c.id})">Remover</button>
      </td>
    </tr>
  `).join('');
}

async function salvarCliente() {
  const form = document.getElementById('form-cliente');
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
    observacoes: form.observacoes.value
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
    'complemento','bairro','cidade','uf','observacoes'];

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
  const res = await apiFetch(`${API_URL}/fornecedores`);
  if (!res) return;
  const lista = await res.json();
  const tbody = document.getElementById('fornecedores-tbody');

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Nenhum fornecedor cadastrado</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(f => `
    <tr>
      <td>
        <strong>${f.razao_social || f.nome}</strong>
        ${f.nome_fantasia ? `<br><small style="color:#94a3b8">${f.nome_fantasia}</small>` : ''}
      </td>
      <td>${f.cnpj || '-'}</td>
      <td>${f.tipo ? capitalize(f.tipo) : (f.ramo || '-')}</td>
      <td>${f.contato_nome || f.email || '-'}</td>
      <td>${badgeStatusGeral(f.status)}</td>
      <td>
        <button class="btn btn-edit" onclick="editarFornecedor(${f.id})">Editar</button>
        <button class="btn btn-danger" onclick="deletarFornecedor(${f.id})">Remover</button>
      </td>
    </tr>
  `).join('');
}

async function salvarFornecedor() {
  const form = document.getElementById('form-fornecedor');
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
    observacoes: form.observacoes.value
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
    'celular','site','contato_nome','contato_email','observacoes'];
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
      <td><strong>${t.nome}</strong></td>
      <td>${t.categoria || '-'}</td>
      <td>${t.fabricante || '-'}</td>
      <td>${t.versao || '-'}</td>
      <td>${t.total_clientes || 0} cliente(s)</td>
      <td>${badgeStatusTec(t.status)}</td>
      <td>
        <button class="btn btn-edit" onclick="editarTecnologia(${t.id})">Editar</button>
        <button class="btn btn-danger" onclick="deletarTecnologia(${t.id})">Remover</button>
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

async function loadChamados() {
  const status = document.getElementById('filtro-status')?.value || '';
  const prioridade = document.getElementById('filtro-prioridade')?.value || '';

  let url = `${API_URL}/chamados?`;
  if (status) url += `status=${status}&`;
  if (prioridade) url += `prioridade=${prioridade}&`;

  const res = await apiFetch(url);
  if (!res) return;
  const lista = await res.json();
  const tbody = document.getElementById('chamados-tbody');

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center">Nenhum chamado encontrado</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(ch => `
    <tr>
      <td><strong>#${ch.id}</strong></td>
      <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="${ch.titulo}">${ch.titulo}</td>
      <td>${ch.cliente_nome || '-'}</td>
      <td>${ch.tecnologia_nome || '-'}</td>
      <td>${badgeStatus(ch.status)}</td>
      <td>${badgePrioridade(ch.prioridade)}</td>
      <td>${formatData(ch.data_criacao)}</td>
      <td>
        <button class="btn btn-edit" onclick="abrirDetalheChamado(${ch.id})">Ver</button>
        <button class="btn btn-edit" onclick="editarChamado(${ch.id})">Editar</button>
        <button class="btn btn-danger" onclick="deletarChamado(${ch.id})">Remover</button>
      </td>
    </tr>
  `).join('');
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

    alert(chamadoEmEdicao ? 'Chamado atualizado!' : 'Chamado aberto!');
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

  // Mostrar campo de status ao editar
  document.getElementById('campo-status-chamado').style.display = 'block';
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
      <div><strong>Cliente:</strong> ${ch.cliente_nome || '-'}</div>
      <div><strong>Tecnologia:</strong> ${ch.tecnologia_nome || '-'}</div>
      <div><strong>Status:</strong> ${badgeStatus(ch.status)}</div>
      <div><strong>Prioridade:</strong> ${badgePrioridade(ch.prioridade)}</div>
      <div><strong>Categoria:</strong> ${ch.categoria || '-'}</div>
      <div><strong>Abertura:</strong> ${formatData(ch.data_abertura)}</div>
      <div><strong>Aberto por:</strong> ${ch.aberto_por_nome || '-'}</div>
      <div><strong>Atribuído para:</strong> ${ch.atribuido_para_nome || '-'}</div>
    </div>
    ${ch.descricao ? `<div style="margin-top:0.75rem; padding-top:0.75rem; border-top:1px solid #e2e8f0"><strong>Descrição:</strong><br>${ch.descricao}</div>` : ''}
  `;

  renderTimeline(ch.atendimentos || []);
  resetForm('#form-atendimento');
  document.getElementById('atendimento-chamado-id').value = ch.id;

  showModal('#modal-detalhe-chamado');
}

function renderTimeline(atendimentos) {
  const container = document.getElementById('timeline-atendimentos');
  if (!atendimentos.length) {
    container.innerHTML = '<p style="color:#94a3b8; font-size:0.9rem; text-align:center; padding:1rem 0;">Nenhum atendimento registrado ainda.</p>';
    return;
  }

  container.innerHTML = atendimentos.map(a => `
    <div class="timeline-item">
      <div class="timeline-badge badge-tipo-${a.tipo}"></div>
      <div class="timeline-content">
        <div class="timeline-header">
          <span class="timeline-tipo">${badgeTipoAtendimento(a.tipo)}</span>
          <span class="timeline-meta">${a.usuario_nome || 'Sistema'} — ${formatDataHora(a.data_atendimento)}</span>
          ${a.tempo_gasto_minutos > 0 ? `<span style="color:#94a3b8; font-size:0.78rem">⏱ ${a.tempo_gasto_minutos}min</span>` : ''}
        </div>
        <div class="timeline-desc">${a.descricao}</div>
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
  const res = await apiFetch(`${API_URL}/transacoes`);
  if (!res) return;
  const dados = await res.json();
  const transacoes = dados.transacoes || [];
  const tbody = document.getElementById('transacoes-tbody');

  if (!transacoes.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Nenhuma transação cadastrada</td></tr>';
    return;
  }

  tbody.innerHTML = transacoes.map(t => `
    <tr>
      <td>${formatData(t.data)}</td>
      <td><span class="badge badge-${t.tipo === 'entrada' ? 'resolvido' : 'alta'}">${t.tipo === 'entrada' ? 'Entrada' : 'Saída'}</span></td>
      <td>${t.categoria}</td>
      <td>${t.descricao || '-'}</td>
      <td><strong>${formatMoeda(t.valor)}</strong></td>
      <td>
        <button class="btn btn-danger" onclick="deletarTransacao(${t.id})">Deletar</button>
      </td>
    </tr>
  `).join('');
}

async function salvarTransacao() {
  const form = document.getElementById('form-transacao');
  const dados = {
    tipo: form.tipo.value,
    valor: parseFloat(form.valor.value),
    categoria: form.categoria.value,
    descricao: form.descricao.value
  };

  try {
    const res = await apiFetch(`${API_URL}/transacoes`, { method: 'POST', body: JSON.stringify(dados) });
    if (!res) return;
    if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
    alert('Transação criada!');
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
  const res = await apiFetch(`${API_URL}/usuarios`);
  if (!res) return;
  const lista = await res.json();
  const tbody = document.getElementById('usuarios-tbody');

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Nenhum usuário cadastrado</td></tr>';
    return;
  }

  const tipoLabel = {
    admin_sistema: { label: 'Admin Sistema', color: '#ef4444' },
    admin_empresa: { label: 'Administrador', color: '#0d6efd' },
    tecnico:       { label: 'Técnico',        color: '#f59e0b' },
    cliente:       { label: 'Cliente',         color: '#10b981' }
  };

  tbody.innerHTML = lista.map(u => {
    const t = tipoLabel[u.tipo] || { label: u.tipo, color: '#64748b' };
    const ehVoce = u.id === usuario?.id;
    return `
      <tr>
        <td><strong>${u.nome}</strong>${ehVoce ? ' <small style="color:#94a3b8">(você)</small>' : ''}</td>
        <td>${u.email}</td>
        <td><span style="background:${t.color}20;color:${t.color};padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:600">${t.label}</span></td>
        <td>${u.cliente_nome || (u.tipo === 'cliente' ? '<span style="color:#ef4444">⚠ sem vínculo</span>' : '—')}</td>
        <td>${u.ativo !== false
          ? '<span style="background:#10b98120;color:#10b981;padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:600">Ativo</span>'
          : '<span style="background:#ef444420;color:#ef4444;padding:2px 8px;border-radius:20px;font-size:0.78rem;font-weight:600">Inativo</span>'
        }</td>
        <td>
          <button class="btn btn-edit" onclick="abrirEditarUsuario(${u.id}, '${u.nome.replace(/'/g, "\\'")}', '${u.email}', '${u.tipo}', ${u.cliente_id || 'null'})">Editar</button>
          <button class="btn btn-edit" onclick="abrirResetSenha(${u.id}, '${u.nome.replace(/'/g, "\\'")}')">Senha</button>
          ${u.ativo !== false
            ? `<button class="btn btn-danger" onclick="desativarUsuario(${u.id})"${ehVoce ? ' disabled title="Não pode desativar a si mesmo"' : ''}>Desativar</button>`
            : `<button class="btn btn-edit" onclick="reativarUsuario(${u.id})">Reativar</button>`
          }
        </td>
      </tr>
    `;
  }).join('');
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
