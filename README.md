# Marsh Consultoria — Sistema de Gestão Web

Sistema de gestão interno desenvolvido para a Marsh Consultoria, com painel administrativo completo e portal exclusivo para clientes.

## Stack

- **Backend**: Node.js + Express 5.x
- **Banco de dados**: PostgreSQL (hospedado no Render)
- **Autenticação**: JWT com bcrypt
- **Frontend**: HTML + CSS + JavaScript puro (sem frameworks)
- **PWA**: Service Worker + manifest.json (instalável em mobile)

---

## Funcionalidades

### Painel Administrativo (`/dashboard.html`)

| Módulo | Descrição |
|---|---|
| Dashboard | Cards de resumo: clientes, chamados, receita, despesa |
| Clientes | Cadastro completo com endereço, responsável e datas de contrato |
| Fornecedores | Cadastro com ramo, contato e status |
| Transações | Controle financeiro com entradas e saídas por categoria |
| Tecnologias | Catálogo de tecnologias disponíveis para vincular a clientes |
| Chamados | Abertura, acompanhamento e fechamento de chamados de suporte |
| Atendimentos | Timeline de ações por chamado (comentários, atualizações) |
| Usuários | Criação e gestão de usuários com perfis diferenciados |

### Portal do Cliente (`/portal.html`)

- Acesso isolado: cada cliente vê apenas seus próprios chamados
- Acompanhe status (aberto, em andamento, resolvido)
- Abrir novos chamados
- Enviar comentários na timeline

---

## Perfis de Usuário

| Tipo | Acesso |
|---|---|
| `admin_sistema` | Acesso total a todas as empresas |
| `admin_empresa` | Acesso total à sua empresa |
| `tecnico` | Acesso ao painel sem gestão de usuários |
| `cliente` | Acesso apenas ao portal do cliente |

O perfil é armazenado no JWT e validado em todas as rotas protegidas.

---

## Arquitetura Multi-tenant

Toda a API filtra dados por `empresa_id` extraído do JWT. Isso permite que o sistema evolua para SaaS com múltiplas empresas sem alterar o banco.

---

## Rotas da API

Todas as rotas (exceto `/api/auth`) exigem header:
```
Authorization: Bearer <token>
```

### Auth
- `POST /api/auth/login` — Login e geração de token JWT

### Clientes
- `GET /api/clientes` — Listar clientes da empresa
- `POST /api/clientes` — Cadastrar cliente
- `PUT /api/clientes/:id` — Atualizar
- `DELETE /api/clientes/:id` — Desativar (soft delete)
- `POST /api/clientes/:id/tecnologias` — Vincular tecnologia
- `DELETE /api/clientes/:id/tecnologias/:tec_id` — Desvincular tecnologia

### Fornecedores
- `GET /api/fornecedores` — Listar
- `POST /api/fornecedores` — Cadastrar
- `PUT /api/fornecedores/:id` — Atualizar
- `DELETE /api/fornecedores/:id` — Desativar

### Tecnologias
- `GET /api/tecnologias` — Listar
- `POST /api/tecnologias` — Cadastrar
- `PUT /api/tecnologias/:id` — Atualizar
- `DELETE /api/tecnologias/:id` — Desativar

### Chamados
- `GET /api/chamados` — Listar (clientes veem apenas os seus)
- `POST /api/chamados` — Abrir chamado
- `PUT /api/chamados/:id` — Atualizar status/prioridade
- `DELETE /api/chamados/:id` — Desativar

### Atendimentos (timeline)
- `GET /api/atendimentos?chamado_id=X` — Histórico do chamado
- `POST /api/atendimentos` — Adicionar comentário/ação

### Usuários
- `GET /api/usuarios` — Listar usuários da empresa
- `POST /api/usuarios` — Criar usuário
- `PUT /api/usuarios/:id` — Editar usuário
- `PUT /api/usuarios/:id/senha` — Redefinir senha
- `DELETE /api/usuarios/:id` — Desativar usuário

### Transações
- `GET /api/transacoes` — Listar com resumo financeiro
- `POST /api/transacoes` — Registrar entrada/saída
- `PUT /api/transacoes/:id` — Atualizar
- `DELETE /api/transacoes/:id` — Remover

### Empresas
- `GET /api/empresas/minha` — Dados da empresa logada
- `GET /api/empresas/resumo` — Resumo para o dashboard

---

## Instalação local

```bash
npm install
```

Crie um arquivo `.env` na raiz:

```env
DATABASE_URL=postgres://usuario:senha@host:5432/banco
JWT_SECRET=sua_chave_secreta
PORT=3000
```

Rode o servidor:

```bash
node server.js
```

O servidor cria/migra todas as tabelas automaticamente na inicialização.

Acesse: `http://localhost:3000`

---

## Deploy (Render)

O projeto está configurado para deploy no Render como **Web Service**:

- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- **Variáveis de ambiente**: `DATABASE_URL`, `JWT_SECRET`

O banco PostgreSQL também é hospedado no Render (plano free).

---

Desenvolvido por Daniel Marsh
