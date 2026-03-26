const express = require('express');
const router = express.Router();

// Array temporário (depois vai ser banco de dados)
let clientes = [
  {
    id: 1,
    nome: 'João Silva',
    cpf_cnpj: '123.456.789-10',
    email: 'joao@example.com',
    telefone: '11 99999-9999',
    endereco: 'Rua das Flores, 123 - São Paulo, SP',
    data_criacao: new Date()
  }
];

let proximoId = 2;

// GET - Listar todos
router.get('/', (req, res) => {
  res.json(clientes);
});

// GET - Um cliente por ID
router.get('/:id', (req, res) => {
  const cliente = clientes.find(c => c.id === parseInt(req.params.id));
  if (!cliente) {
    return res.status(404).json({ erro: 'Cliente não encontrado' });
  }
  res.json(cliente);
});

// POST - Criar novo cliente
router.post('/', (req, res) => {
  const { nome, cpf_cnpj, email, telefone, endereco } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }

  const novoCliente = {
    id: proximoId++,
    nome,
    cpf_cnpj: cpf_cnpj || '',
    email: email || '',
    telefone: telefone || '',
    endereco: endereco || '',
    data_criacao: new Date()
  };

  clientes.push(novoCliente);
  res.status(201).json({
    mensagem: 'Cliente criado com sucesso!',
    cliente: novoCliente
  });
});

// PUT - Atualizar cliente
router.put('/:id', (req, res) => {
  const cliente = clientes.find(c => c.id === parseInt(req.params.id));
  
  if (!cliente) {
    return res.status(404).json({ erro: 'Cliente não encontrado' });
  }

  const { nome, cpf_cnpj, email, telefone, endereco } = req.body;

  if (nome) cliente.nome = nome;
  if (cpf_cnpj) cliente.cpf_cnpj = cpf_cnpj;
  if (email) cliente.email = email;
  if (telefone) cliente.telefone = telefone;
  if (endereco) cliente.endereco = endereco;

  res.json({
    mensagem: 'Cliente atualizado com sucesso!',
    cliente
  });
});

// DELETE - Deletar cliente
router.delete('/:id', (req, res) => {
  const index = clientes.findIndex(c => c.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ erro: 'Cliente não encontrado' });
  }

  const clienteDeletado = clientes.splice(index, 1);
  res.json({
    mensagem: 'Cliente deletado com sucesso!',
    cliente: clienteDeletado[0]
  });
});

module.exports = router;
