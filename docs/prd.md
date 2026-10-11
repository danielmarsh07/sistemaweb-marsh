# Contexto do Projeto — Marsh Consultoria Sistema Web

## O que é este projeto

Sistema de gestão interno da Marsh Consultoria, desenvolvido por Daniel Mathias Lopes (Daniel Marsh).
Permite gerenciar clientes, fornecedores e transações financeiras via dashboard web.

O projeto tem duas partes separadas dentro da pasta `marsh-consultoria/`:

```
marsh-consultoria/
├── landingpage/          → Página estática de teste (protótipo inicial, não é o app principal)
└── sistemaweb-marsh/     → APP PRINCIPAL — tudo parte daqui
    ├── server.js         → Servidor Express (entry point: npm start)
    ├── .env              → Variáveis de ambiente (não vai pro GitHub)
    ├── db/index.js       → Conexão com PostgreSQL via pool
    ├── middleware/       → Autenticação JWT
    ├── routes/           → API REST (auth, clientes, fornecedores, transacoes)
    └── public/           → Frontend servido pelo Express
        ├── index.html    → Landing page com botão "Entrar no Sistema"
        ├── login.html    → Tela de login / cadastro
        ├── dashboard.html→ Dashboard principal (clientes, fornecedores, finanças)
        ├── script.js     → Lógica do dashboard (chamadas à API)
        ├── styles.css    → CSS do dashboard e login
        └── style.css     → CSS da landing page
```

---

## Stack

- **Backend:** Node.js + Express 5 + PostgreSQL (`pg`)
- **Auth:** JWT (jsonwebtoken) + bcrypt
- **Frontend:** HTML + CSS + JavaScript vanilla (sem framework)
- **Banco:** PostgreSQL hospedado no Render
- **Deploy:** Render — https://sistemaweb-marsh.onrender.com

---

## Como rodar localmente

```bash
cd sistemaweb-marsh
node server.js
# Acesse: http://localhost:3000
```

> Nunca abrir os arquivos .html diretamente no browser — os links /login.html, /dashboard.html
> só funcionam servidos pelo Express.

> Se der erro de porta em uso, fechar o terminal anterior ou rodar:
> `taskkill //F //IM node.exe` (Windows) para matar processos Node antigos.

---

## Banco de dados (Render)

- **Conexão interna** (só funciona dentro do Render): `dpg-d72slseuk2gs73e5p8qg-a/marsh_db`
- **Conexão externa** (para rodar local): configurada no `.env` com host `.oregon-postgres.render.com`
- Tabelas criadas automaticamente no startup: `usuarios`, `clientes`, `fornecedores`, `transacoes`
- Usuários cadastrados: Daniel (daniel.marsh.sap@gmail.com) e Felipe (felipe@elitelaudos.com.br)

---

## Fluxo da aplicação

```
/ (index.html)
  └── "Entrar no Sistema" → /login.html
        └── Login com JWT → /dashboard.html
              ├── Aba Clientes     → GET/POST/PUT/DELETE /api/clientes
              ├── Aba Fornecedores → GET/POST/PUT/DELETE /api/fornecedores
              └── Aba Transações   → GET/POST/PUT/DELETE /api/transacoes
```

---

## O que foi feito na sessão de hoje (2026-03-31)

1. **Auditoria completa** da pasta `marsh-consultoria` — mapeamento de todos os arquivos
2. **README.md** — resolvido conflito de merge Git que estava no arquivo
3. **package.json** — corrigido `"main"` que apontava para `index.js` → agora aponta para `server.js`
4. **.env** — adicionado `JWT_SECRET` e atualizado `DATABASE_URL` com a URL externa do Render
5. **landingpage/index.html** — removido botão "Entrar no Sistema" (era protótipo, não é o app principal)
6. **Bug de login** — havia processos Node antigos em background interceptando requisições; resolvido

---

## Próximos passos

- [ ] Fazer commit e push das correções de hoje para o GitHub
- [ ] Verificar se o deploy no Render está com a versão mais recente
- [ ] Testar todas as funcionalidades do dashboard (criar/editar/deletar clientes, fornecedores, transações)
- [ ] Avaliar se a pasta `landingpage/` ainda é necessária ou pode ser removida
