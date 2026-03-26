# 🚀 Marsh Consultoria - Sistema Backend

Backend Node.js + Express para gerenciamento de Clientes, Fornecedores e Transações Financeiras.

## ✅ Instalação

Dependências já instaladas! ✨

## 🎯 Como Rodar

```bash
npm start
```

Servidor estará rodando em: **http://localhost:3000**

## 📡 Endpoints da API

### **Clientes**
- `GET /api/clientes` - Listar todos
- `GET /api/clientes/:id` - Um cliente
- `POST /api/clientes` - Criar novo
- `PUT /api/clientes/:id` - Atualizar
- `DELETE /api/clientes/:id` - Deletar

### **Fornecedores**
- `GET /api/fornecedores` - Listar todos
- `GET /api/fornecedores/:id` - Um fornecedor
- `POST /api/fornecedores` - Criar novo
- `PUT /api/fornecedores/:id` - Atualizar
- `DELETE /api/fornecedores/:id` - Deletar

### **Transações Financeiras**
- `GET /api/transacoes` - Listar com resumo
- `GET /api/transacoes/:id` - Uma transação
- `POST /api/transacoes` - Criar nova
- `PUT /api/transacoes/:id` - Atualizar
- `DELETE /api/transacoes/:id` - Deletar

## 📝 Exemplos de Requisições

### Criar Cliente
```bash
curl -X POST http://localhost:3000/api/clientes \
  -H "Content-Type: application/json" \
  -d '{
    "nome": "Empresa ABC",
    "cpf_cnpj": "12.345.678/0001-99",
    "email": "contato@empresa.com.br",
    "telefone": "11 99999-9999",
    "endereco": "Rua X, 123"
  }'
```

### Criar Transação
```bash
curl -X POST http://localhost:3000/api/transacoes \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "entrada",
    "valor": 5000,
    "categoria": "Receita",
    "descricao": "Pagamento Projeto X"
  }'
```

## 🔄 Próximos Passos

1. Conectar ao banco PostgreSQL (Render)
2. Criar Dashboard no Frontend
3. Adicionar Autenticação
4. Deploy no Render

## 📚 Stack

- Node.js
- Express
- PostgreSQL (em desenvolvimento)
- CORS habilitado

---

Desenvolvido por Daniel Marsh 🎯

