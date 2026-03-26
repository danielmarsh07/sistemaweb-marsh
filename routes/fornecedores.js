const express = require('express');
const router = express.Router();

// Array temporário
let fornecedores = [
  {
    id: 1,
    nome: 'Distribuidor XYZ',
    cnpj: '12.345.678/0001-99',
    email: 'contato@xyz.com.br',
    telefone: '11 3333-3333',
    ramo: 'Eletrônicos',
    data_criacao: new Date()
  }
];

let proximoId = 2;

// GET - Listar todos
router.get('/', (req, res) => {
  res.json(fornecedores);
});

// GET - Um fornecedor por ID
router.get('/:id', (req, res) => {
  const fornecedor = fornecedores.find(f => f.id === parseInt(req.params.id));
  if (!fornecedor) {
    return res.status(404).json({ erro: 'Fornecedor não encontrado' });
  }
  res.json(fornecedor);
});

// POST - Criar novo fornecedor
router.post('/', (req, res) => {
  const { nome, cnpj, email, telefone, ramo } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }

  const novoFornecedor = {
    id: proximoId++,
    nome,
    cnpj: cnpj || '',
    email: email || '',
    telefone: telefone || '',
    ramo: ramo || '',
    data_criacao: new Date()
  };

  fornecedores.push(novoFornecedor);
  res.status(201).json({
    mensagem: 'Fornecedor criado com sucesso!',
    fornecedor: novoFornecedor
  });
});

// PUT - Atualizar fornecedor
router.put('/:id', (req, res) => {
  const fornecedor = fornecedores.find(f => f.id === parseInt(req.params.id));
  
  if (!fornecedor) {
    return res.status(404).json({ erro: 'Fornecedor não encontrado' });
  }

  const { nome, cnpj, email, telefone, ramo } = req.body;

  if (nome) fornecedor.nome = nome;
  if (cnpj) fornecedor.cnpj = cnpj;
  if (email) fornecedor.email = email;
  if (telefone) fornecedor.telefone = telefone;
  if (ramo) fornecedor.ramo = ramo;

  res.json({
    mensagem: 'Fornecedor atualizado com sucesso!',
    fornecedor
  });
});

// DELETE - Deletar fornecedor
router.delete('/:id', (req, res) => {
  const index = fornecedores.findIndex(f => f.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ erro: 'Fornecedor não encontrado' });
  }

  const fornecedorDeletado = fornecedores.splice(index, 1);
  res.json({
    mensagem: 'Fornecedor deletado com sucesso!',
    fornecedor: fornecedorDeletado[0]
  });
});

module.exports = router;
