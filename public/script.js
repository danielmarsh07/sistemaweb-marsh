// ===== CONFIG =====
// Use relative URL para funcionar tanto em desenvolvimento quanto em produção
const API_URL = '/api';

// ===== STATE =====
let currentPage = 'dashboard';
let clienteEmEdicao = null;
let fornecedorEmEdicao = null;

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadDashboard();
});

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Navegação
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      showPage(page);
    });
  });

  // Botões de ação
  document.getElementById('btn-novo-cliente').addEventListener('click', () => {
    clienteEmEdicao = null;
    resetForm('#form-cliente');
    document.querySelector('#modal-cliente .modal-header h3').textContent = 'Novo Cliente';
    showModal('#modal-cliente');
  });

  document.getElementById('btn-novo-fornecedor').addEventListener('click', () => {
    fornecedorEmEdicao = null;
    resetForm('#form-fornecedor');
    document.querySelector('#modal-fornecedor .modal-header h3').textContent = 'Novo Fornecedor';
    showModal('#modal-fornecedor');
  });

  document.getElementById('btn-nova-transacao').addEventListener('click', () => {
    resetForm('#form-transacao');
    showModal('#modal-transacao');
  });

  // Fechar modals
  document.querySelectorAll('.btn-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      closeModal(modal);
    });
  });

  document.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      closeModal(modal);
    });
  });

  // Fechar modal ao clicar fora
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal);
      }
    });
  });

  // Forms
  document.getElementById('form-cliente').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarCliente();
  });

  document.getElementById('form-fornecedor').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarFornecedor();
  });

  document.getElementById('form-transacao').addEventListener('submit', (e) => {
    e.preventDefault();
    salvarTransacao();
  });
}

// ===== NAVIGATION =====
function showPage(page) {
  // Atualizar nav
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  // Atualizar página
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
  });
  document.getElementById(`${page}-page`).classList.add('active');

  // Atualizar título
  const titles = {
    dashboard: 'Dashboard',
    clientes: 'Clientes',
    fornecedores: 'Fornecedores',
    transacoes: 'Transações Financeiras'
  };
  document.getElementById('page-title').textContent = titles[page];

  currentPage = page;

  // Carregar dados
  if (page === 'clientes') loadClientes();
  if (page === 'fornecedores') loadFornecedores();
  if (page === 'transacoes') loadTransacoes();
}

// ===== DASHBOARD =====
async function loadDashboard() {
  try {
    const [clientes, fornecedores, transacoes] = await Promise.all([
      fetch(`${API_URL}/clientes`).then(r => r.json()),
      fetch(`${API_URL}/fornecedores`).then(r => r.json()),
      fetch(`${API_URL}/transacoes`).then(r => r.json())
    ]);

    document.getElementById('total-clientes').textContent = clientes.length;
    document.getElementById('total-fornecedores').textContent = fornecedores.length;

    if (transacoes.resumo) {
      const { totalEntradas, totalSaidas, saldo } = transacoes.resumo;
      document.getElementById('total-entradas').textContent = formatMoeda(totalEntradas);
      document.getElementById('total-saidas').textContent = formatMoeda(totalSaidas);
      document.getElementById('total-saldo').textContent = formatMoeda(saldo);

      if (saldo < 0) {
        document.getElementById('total-saldo').style.color = '#ef4444';
      }
    }
  } catch (erro) {
    console.error('Erro ao carregar dashboard:', erro);
    alert('Erro ao carregar dashboard!');
  }
}

// ===== CLIENTES =====
async function loadClientes() {
  try {
    const response = await fetch(`${API_URL}/clientes`);
    const clientes = await response.json();

    const tbody = document.getElementById('clientes-tbody');
    if (clientes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">Nenhum cliente cadastrado</td></tr>';
      return;
    }

    tbody.innerHTML = clientes.map(cliente => `
      <tr>
        <td>${cliente.nome}</td>
        <td>${cliente.cpf_cnpj || '-'}</td>
        <td>${cliente.email || '-'}</td>
        <td>${cliente.telefone || '-'}</td>
        <td>
          <button class="btn btn-edit" onclick="editarCliente(${cliente.id})">Editar</button>
          <button class="btn btn-danger" onclick="deletarCliente(${cliente.id})">Deletar</button>
        </td>
      </tr>
    `).join('');
  } catch (erro) {
    console.error('Erro ao carregar clientes:', erro);
  }
}

async function salvarCliente() {
  const form = document.getElementById('form-cliente');
  const dados = {
    nome: form.nome.value,
    cpf_cnpj: form.cpf_cnpj.value,
    email: form.email.value,
    telefone: form.telefone.value,
    endereco: form.endereco.value
  };

  try {
    if (clienteEmEdicao) {
      await fetch(`${API_URL}/clientes/${clienteEmEdicao}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados)
      });
      alert('Cliente atualizado com sucesso!');
    } else {
      await fetch(`${API_URL}/clientes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados)
      });
      alert('Cliente criado com sucesso!');
    }

    closeModal(document.getElementById('modal-cliente'));
    loadClientes();
    loadDashboard();
  } catch (erro) {
    alert('Erro ao salvar cliente: ' + erro.message);
  }
}

async function editarCliente(id) {
  try {
    const response = await fetch(`${API_URL}/clientes/${id}`);
    const cliente = await response.json();

    clienteEmEdicao = id;
    const form = document.getElementById('form-cliente');
    form.nome.value = cliente.nome;
    form.cpf_cnpj.value = cliente.cpf_cnpj || '';
    form.email.value = cliente.email || '';
    form.telefone.value = cliente.telefone || '';
    form.endereco.value = cliente.endereco || '';

    document.querySelector('#modal-cliente .modal-header h3').textContent = 'Editar Cliente';
    showModal('#modal-cliente');
  } catch (erro) {
    alert('Erro ao carregar cliente: ' + erro.message);
  }
}

async function deletarCliente(id) {
  if (!confirm('Tem certeza que deseja deletar este cliente?')) return;

  try {
    await fetch(`${API_URL}/clientes/${id}`, { method: 'DELETE' });
    alert('Cliente deletado com sucesso!');
    loadClientes();
    loadDashboard();
  } catch (erro) {
    alert('Erro ao deletar cliente: ' + erro.message);
  }
}

// ===== FORNECEDORES =====
async function loadFornecedores() {
  try {
    const response = await fetch(`${API_URL}/fornecedores`);
    const fornecedores = await response.json();

    const tbody = document.getElementById('fornecedores-tbody');
    if (fornecedores.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">Nenhum fornecedor cadastrado</td></tr>';
      return;
    }

    tbody.innerHTML = fornecedores.map(forn => `
      <tr>
        <td>${forn.nome}</td>
        <td>${forn.cnpj || '-'}</td>
        <td>${forn.email || '-'}</td>
        <td>${forn.ramo || '-'}</td>
        <td>
          <button class="btn btn-edit" onclick="editarFornecedor(${forn.id})">Editar</button>
          <button class="btn btn-danger" onclick="deletarFornecedor(${forn.id})">Deletar</button>
        </td>
      </tr>
    `).join('');
  } catch (erro) {
    console.error('Erro ao carregar fornecedores:', erro);
  }
}

async function salvarFornecedor() {
  const form = document.getElementById('form-fornecedor');
  const dados = {
    nome: form.nome.value,
    cnpj: form.cnpj.value,
    email: form.email.value,
    telefone: form.telefone.value,
    ramo: form.ramo.value
  };

  try {
    if (fornecedorEmEdicao) {
      await fetch(`${API_URL}/fornecedores/${fornecedorEmEdicao}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados)
      });
      alert('Fornecedor atualizado com sucesso!');
    } else {
      await fetch(`${API_URL}/fornecedores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dados)
      });
      alert('Fornecedor criado com sucesso!');
    }

    closeModal(document.getElementById('modal-fornecedor'));
    loadFornecedores();
    loadDashboard();
  } catch (erro) {
    alert('Erro ao salvar fornecedor: ' + erro.message);
  }
}

async function editarFornecedor(id) {
  try {
    const response = await fetch(`${API_URL}/fornecedores/${id}`);
    const forn = await response.json();

    fornecedorEmEdicao = id;
    const form = document.getElementById('form-fornecedor');
    form.nome.value = forn.nome;
    form.cnpj.value = forn.cnpj || '';
    form.email.value = forn.email || '';
    form.telefone.value = forn.telefone || '';
    form.ramo.value = forn.ramo || '';

    document.querySelector('#modal-fornecedor .modal-header h3').textContent = 'Editar Fornecedor';
    showModal('#modal-fornecedor');
  } catch (erro) {
    alert('Erro ao carregar fornecedor: ' + erro.message);
  }
}

async function deletarFornecedor(id) {
  if (!confirm('Tem certeza que deseja deletar este fornecedor?')) return;

  try {
    await fetch(`${API_URL}/fornecedores/${id}`, { method: 'DELETE' });
    alert('Fornecedor deletado com sucesso!');
    loadFornecedores();
    loadDashboard();
  } catch (erro) {
    alert('Erro ao deletar fornecedor: ' + erro.message);
  }
}

// ===== TRANSAÇÕES =====
async function loadTransacoes() {
  try {
    const response = await fetch(`${API_URL}/transacoes`);
    const dados = await response.json();
    const transacoes = dados.transacoes || [];

    const tbody = document.getElementById('transacoes-tbody');
    if (transacoes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">Nenhuma transação cadastrada</td></tr>';
      return;
    }

    tbody.innerHTML = transacoes.map(t => `
      <tr>
        <td>${new Date(t.data).toLocaleDateString('pt-BR')}</td>
        <td><span class="badge badge-${t.tipo}">${t.tipo === 'entrada' ? 'Entrada' : 'Saída'}</span></td>
        <td>${t.categoria}</td>
        <td>${t.descricao}</td>
        <td>${formatMoeda(t.valor)}</td>
        <td>
          <button class="btn btn-danger" onclick="deletarTransacao(${t.id})">Deletar</button>
        </td>
      </tr>
    `).join('');
  } catch (erro) {
    console.error('Erro ao carregar transações:', erro);
  }
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
    await fetch(`${API_URL}/transacoes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados)
    });

    alert('Transação criada com sucesso!');
    closeModal(document.getElementById('modal-transacao'));
    loadTransacoes();
    loadDashboard();
  } catch (erro) {
    alert('Erro ao salvar transação: ' + erro.message);
  }
}

async function deletarTransacao(id) {
  if (!confirm('Tem certeza que deseja deletar esta transação?')) return;

  try {
    await fetch(`${API_URL}/transacoes/${id}`, { method: 'DELETE' });
    alert('Transação deletada com sucesso!');
    loadTransacoes();
    loadDashboard();
  } catch (erro) {
    alert('Erro ao deletar transação: ' + erro.message);
  }
}

// ===== UTILITIES =====
function showModal(selector) {
  document.querySelector(selector).classList.add('show');
}

function closeModal(modal) {
  modal.classList.remove('show');
}

function resetForm(selector) {
  document.querySelector(selector).reset();
}

function formatMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valor);
}
