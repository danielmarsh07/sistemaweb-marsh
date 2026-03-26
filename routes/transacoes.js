const express = require('express');
const router = express.Router();

// Array temporário
let transacoes = [
  {
    id: 1,
    tipo: 'entrada',
    valor: 5000.00,
    categoria: 'Receita',
    descricao: 'Consultoria SAP - Cliente ABC',
    data: new Date('2026-03-15'),
    usuario_id: 1
  },
  {
    id: 2,
    tipo: 'saída',
    valor: 1200.00,
    categoria: 'Despesa Operacional',
    descricao: 'Aluguel do escritório',
    data: new Date('2026-03-10'),
    usuario_id: 1
  }
];

let proximoId = 3;

// GET - Listar todas
router.get('/', (req, res) => {
  // Calcular totais
  let totalEntradas = 0;
  let totalSaidas = 0;

  transacoes.forEach(t => {
    if (t.tipo === 'entrada') {
      totalEntradas += t.valor;
    } else if (t.tipo === 'saída') {
      totalSaidas += t.valor;
    }
  });

  res.json({
    transacoes,
    resumo: {
      totalEntradas,
      totalSaidas,
      saldo: totalEntradas - totalSaidas
    }
  });
});

// GET - Uma transação por ID
router.get('/:id', (req, res) => {
  const transacao = transacoes.find(t => t.id === parseInt(req.params.id));
  if (!transacao) {
    return res.status(404).json({ erro: 'Transação não encontrada' });
  }
  res.json(transacao);
});

// POST - Criar nova transação
router.post('/', (req, res) => {
  const { tipo, valor, categoria, descricao, usuario_id } = req.body;

  if (!tipo || !valor || !categoria) {
    return res.status(400).json({ erro: 'Tipo, valor e categoria são obrigatórios' });
  }

  if (!['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  const novaTransacao = {
    id: proximoId++,
    tipo,
    valor: parseFloat(valor),
    categoria,
    descricao: descricao || '',
    data: new Date(),
    usuario_id: usuario_id || 1
  };

  transacoes.push(novaTransacao);
  res.status(201).json({
    mensagem: 'Transação criada com sucesso!',
    transacao: novaTransacao
  });
});

// PUT - Atualizar transação
router.put('/:id', (req, res) => {
  const transacao = transacoes.find(t => t.id === parseInt(req.params.id));
  
  if (!transacao) {
    return res.status(404).json({ erro: 'Transação não encontrada' });
  }

  const { tipo, valor, categoria, descricao } = req.body;

  if (tipo && !['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  if (tipo) transacao.tipo = tipo;
  if (valor) transacao.valor = parseFloat(valor);
  if (categoria) transacao.categoria = categoria;
  if (descricao) transacao.descricao = descricao;

  res.json({
    mensagem: 'Transação atualizada com sucesso!',
    transacao
  });
});

// DELETE - Deletar transação
router.delete('/:id', (req, res) => {
  const index = transacoes.findIndex(t => t.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ erro: 'Transação não encontrada' });
  }

  const transacaoDeletada = transacoes.splice(index, 1);
  res.json({
    mensagem: 'Transação deletada com sucesso!',
    transacao: transacaoDeletada[0]
  });
});

module.exports = router;
