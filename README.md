# Marsh Consultoria — Sistema de Gestão Web

Sistema de gestão interno desenvolvido para a Marsh Consultoria, com painel administrativo completo e portal exclusivo para clientes.

## Stack

- **Backend**: Node.js + Express 5.x
- **Banco de dados**: PostgreSQL (hospedado no Render)
- **Autenticação**: JWT com bcrypt
- **Frontend**: HTML + CSS + JavaScript puro (sem frameworks)
- **PWA**: Service Worker + manifest.json (instalável em mobile)

---

## Estrutura de pastas

```
sistemaweb-marsh/
├── server.js, package.json      ← raiz: o Render roda "node server.js" daqui
├── backend/                     ← API (Node/Express)
│   ├── routes/                  ← endpoints /api/...
│   ├── services/                ← regras: faturamento, Asaas, e-mail, comercial...
│   ├── middleware/  db/
│   └── scripts/                 ← seed local, chaves de licença, imagens
├── frontend/                    ← servido na raiz do site (os endereços não mostram a pasta)
│   ├── site/                    ← página institucional: index.html, style.css, landing-script.js
│   ├── sistema/                 ← dashboard, portal do cliente, login, proposta e seus scripts
│   └── comum/                   ← logo (img/), tema, manifest e service worker
├── docs/                        ← PRD, licenças do conector, marca, notas fiscais (fora do git)
└── testes/                      ← testes da API e screenshots (só no banco local; veja testes/README.md)
```

Local: `docker compose up -d` e `npm run dev:local` (usa `.env.local`, banco Docker). O `.env` é o de produção.

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

### Comercial

Só administradores (`admin_sistema`/`admin_empresa`); rotas em `/api/comercial`.

- **Funil de vendas**: oportunidades (cliente ou prospect) em kanban, histórico, propostas com itens mensais/únicos, link público para o cliente aceitar (`/proposta.html?t=...`), impressão/PDF (`/proposta.html?id=...`) e *Gerar contrato* (cria o cliente, se for prospect, e o contrato recorrente).
- **Simulador Conector SAP** (Comercial → Simulador Conector SAP, ou *Simular Conector SAP* na oportunidade): monta a oferta do Conector SAP Marsh e gera a proposta pelo mesmo fluxo.
  - Entradas: oportunidade, nº de funcionais e ABAPs, ciclo (mensal/anual), modalidade (Individual, Empresa ou Automático = a mais barata), nº de sistemas SAP, porte do legado Z, chamados P/M/G estimados por mês **ou** pacotes de sustentação, desconto % por N meses (opcionalmente na implantação), validade e ROI (horas economizadas × custo/hora).
  - Saída ao vivo: itens, total mensal (cheio e com desconto), total único, total do 1º ano, comparação Individual × Empresa e ROI (economia × custo das licenças, payback da implantação).
  - *Gerar proposta*: `POST /api/comercial/oportunidades/:id/propostas` com `{ simulador_conector: {...}, incluir_roi }` cria o rascunho com itens, totais, título "Conector SAP Marsh — cliente" e textos padrão (produto, implantação, premissas: IA por conta do cliente, só sistemas cadastrados e nunca produção, licença por máquina, LGPD, chamados por demanda aprovada, IPCA, vigência mínima no anual). O total mensal da proposta é o valor com desconto; o preço cheio aparece nos itens e nas condições.
  - Regra de preço numa função pura: `backend/services/precificacao-conector.js`. Rotas: `POST /api/comercial/simulador-conector/calcular`, `GET/PUT /api/comercial/simulador-conector/config`.
  - **Tabela de preços** editável no botão *Tabela de preços* do simulador (gravada em `financeiro_config.prop_precos_conector`; campo vazio = padrão do código). Padrões: Leitura R$ 490 mensal / R$ 390 anual; Desenvolvimento R$ 990 / R$ 790; Empresa até 5 = R$ 3.500, até 10 = R$ 6.000, + R$ 450 por usuário acima de 10 (acréscimo opcional no ciclo mensal); implantação P/M/G R$ 8.000 / 15.000 / 25.000 + R$ 2.000 por sistema adicional; chamados P/M/G R$ 1.500 / 4.000 / 9.000; sustentação 40 h por R$ 7.500/mês.
  - Teste: `node testes/simulador-conector.js [saida.pdf]`.

### Marketing (Instagram)

Só administradores (`admin_sistema`/`admin_empresa`; técnico e cliente recebem 403); rotas em `/api/marketing`. Menu **Marketing**: Calendário, Conta do Instagram e Métricas.

- **Calendário**: grade do mês com miniaturas (ou lista), filtro por status, clique no dia vazio cria um post. Horários sempre em America/Sao_Paulo.
- **Editor**: 1 a 10 imagens (arrastar e soltar, setas para reordenar; 2 ou mais = carrossel), prévia do feed (4:5) e do carrossel, legenda com contador (2.200 caracteres, 30 hashtags), data/hora, *Salvar rascunho*, *Agendar*, *Publicar agora*, *Cancelar post*, *Duplicar*, *Excluir*. Publicado fica só leitura, com o link do Instagram.
- **Imagens**: PNG/JPEG/WebP até 8 MB, convertidas no upload para JPEG sRGB (qualidade 90, sem metadados, até 1440 px de largura) com `sharp`; proporção aceita de 4:5 a 1,91:1 (padrão Marsh 1080×1350). Ficam no storage em `marketing/<post_id>/<nn>-<nome>.jpg`; sem storage, 503.
- **Importar agenda**: seleciona os arquivos (ou a pasta) com `agenda.json` + imagens; mostra o resumo e cria os posts agendados (data passada = rascunho; mesmo título e data = ignorado). Formato: `{ "posts": [ { "titulo", "data": "2026-10-19T12:30:00-03:00", "imagens": ["post-01.png"], "legenda" } ] }`.
- **Publicação** (`backend/services/instagram.js`, Instagram API with Instagram Login): `POST /{ig_user_id}/media` (imagem, ou itens `is_carousel_item` + contêiner `CAROUSEL`) → `status_code` até `FINISHED` → `media_publish` → `permalink`. A `image_url` é um link assinado do storage de 1 hora.
- **Rotina** (`backend/services/marketing-jobs.js`, dentro do servidor): a cada 5 min publica os agendados vencidos (trava com `UPDATE ... WHERE status='agendado' RETURNING`, então duas instâncias não publicam duas vezes); 1x por dia renova o token se faltar < 10 dias, grava os seguidores do dia e as métricas (alcance, curtidas, comentários, salvamentos, compartilhamentos, interações, visualizações; a que a API não der fica nula) dos posts dos últimos 30 dias. Falha: 3 tentativas (de novo em 5 e 15 min), depois status *erro* + alerta em Sistema → Alertas; limite de publicação do Instagram reagenda +1 h sem contar tentativa. Post parado em *publicando* por 15 min vira erro (não republica sozinho).
- **Conta**: o admin cola o token de longa duração; o servidor valida em `/me`, renova para saber a validade e grava **cifrado** (AES-256-GCM com `MARKETING_CHAVE_CIFRA`). O token nunca volta em nenhuma rota.
- Tabelas: `marketing_posts`, `marketing_midias`, `marketing_metricas`, `marketing_conta`, `marketing_seguidores`.
- Teste: `node testes/marketing.js` (servidor falso do Graph; ver o topo do arquivo).

Variáveis (Render → Environment):

| Variável | Para quê |
|---|---|
| `MARKETING_CHAVE_CIFRA` | 32 bytes em hex (64 caracteres) ou base64 para cifrar o token. Gerar: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Sem ela, conectar a conta responde 503. **Não troque depois**: o token gravado deixa de abrir (aí é só conectar de novo). |
| `INSTAGRAM_GRAPH_URL` | Base da API (padrão `https://graph.instagram.com`; os testes apontam para o servidor falso). |
| `INSTAGRAM_API_VERSION` | Versão da API (padrão `v23.0`). |
| `MARKETING_JOBS` | `off` desliga a rotina de publicação/métricas (testes e ambiente local). |

### Ivy (assistente de voz)

Exclusiva do **super usuário** (`usuarios.super_usuario`, o dono do sistema): administradores comuns, técnicos e clientes não veem o botão e a API responde 403. A marca é conferida no banco a cada chamada.

- Fala e ouve no navegador (Web Speech), conversa com a OpenAI usando tools (`backend/services/assistente-tools*.js`): financeiro, cadastros, chamados, comercial, contratos, DRE, caixa, Instagram, alertas, licenças.
- **Sistema inteiro**: `estrutura_banco` (tabelas e colunas), `consultar_banco` (SELECT livre em transação só leitura, timeout 5 s, até 50 linhas, colunas de senha/token/hash mascaradas) e `documentacao_sistema` (este README e `docs/*.md`).
- Testes: `node testes/assistente-sistema.js` (acesso e tools de sistema; precisa do servidor local), `assistente-gestao.js`, `assistente-financeiro.js`.

| Variável | Para quê |
|---|---|
| `SUPER_USUARIO_EMAIL` | E-mail marcado como super usuário a cada subida do servidor (padrão `daniel.marsh.sap@gmail.com`). |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Conversa (padrão `gpt-4o-mini`). |
| `IVY_TTS_VOICE` / `IVY_TTS_MODEL` / `IVY_TTS_INSTRUCTIONS` | Voz (padrão `nova` + `gpt-4o-mini-tts`). |

### Portal do Cliente (`/portal.html`)

- Acesso isolado: cada cliente vê apenas seus próprios chamados
- Acompanhe status (aberto, em andamento, resolvido)
- Abrir novos chamados, **focados em SAP** (desde a v5.8): servidor (SID), tipo (erro, dúvida, melhoria, nova funcionalidade), módulo, transação e descrição. Os servidores oferecidos (`sap.sistemasDoCliente`, `GET /api/chamados/sistemas-sap`) vêm das **licenças ativas** do Conector do cliente (tela Licenças: `licencas.conexoes`/`sids`, ativa e dentro da validade; a chave da empresa primeiro, depois as licenças das pessoas) e, como complemento (desde a v6.1), dos sistemas do contrato vigente (`contratos_conector.conexoes`). Se a empresa tem algum, escolher o servidor é obrigatório e o servidor recusa SID fora dessa lista. Sem nenhum, o chamado sai sem servidor. Teste: `testes/chamados-sap.js`.
- Enviar comentários na timeline
- **Mesmo visual do sistema** (desde a v4.6): usa o `styles.css` (menu lateral, cabeçalho, páginas, temas, barra de baixo e gaveta no celular). O CSS próprio do `portal.html` ficou só para os componentes do portal.
- Telas (`TELAS_PORTAL` em `portal-script.js`): Início, Chamados, Treinamentos, Minha licença, Licenças da empresa, Conector SAP, Financeiro e Meus pedidos. Cada uma só aparece no menu se a pessoa tem aquilo (a seção `secao-*` deixa de estar `hidden`); quem só usa licença não vê Chamados. A barra de baixo do celular mostra as 4 primeiras + Menu. Teste: `testes/portal-tela.js`.

### Contratos num lugar só (Financeiro → Contratos e ficha do cliente)

- **+ Novo contrato** pergunta o tipo e abre o formulário certo: **Serviço** (contrato financeiro), **Licenças do Conector** (abaixo) ou **Cursos (por pessoas)**. A página Contratos e a ficha listam os três juntos. Plano e decisões em `docs/plano-contratos-unificados.md`.
- **Preço por contrato**: a tabela Preços Conector SAP é o preço de **lista** (Loja, simulador, propostas, sugestão). Cada contrato do Conector guarda o preço negociado por perfil (`contratos_conector.precos`, R$/licença/mês no plano anual); a cobrança anual = licenças × preço × 12. Contrato antigo sem preço guardado usa a tabela na proporção do valor cobrado. Novo contrato do mesmo cliente sugere o preço do último.
- **Licenças a mais** (`POST /api/contratos-conector/:id/vagas`, prévia em `GET /:id/licencas/previa`): anuidade nova e fatura proporcional (licenças × preço × meses até o fim) em rascunho, sem `contrato_id` para não ocupar a competência da anuidade. **A menos**: a próxima anuidade diminui, sem estorno. `PUT /:id/precos` muda o preço negociado.
- **Modalidade e ciclo** (`contratos_conector.modalidade` = `licenca` | `empresa`, `ciclo` = `anual` | `mensal`): no pacote Empresa o preço é fechado por faixa (`empresa_ate5`, `empresa_ate10`) mais `empresa_excedente` por usuário acima de 10; a cobrança é a mensalidade × 12 (anual) ou a mensalidade (mensal). Licença a mais no ciclo mensal só muda a mensalidade (sem proporcional). Conta única em `mensalidade()` (backend) e `mensalidadeConector()` (frontend).
- **Proposta → contrato**: a proposta criada pelo simulador guarda a simulação (`propostas.conector`: quantidades, modalidade, ciclo, preço cheio, desconto). Em "Gerar contrato", proposta assim cria o contrato do Conector (`criarContrato`) com licenças, preço, gestor (contato da oportunidade) e cobrança ligada à proposta (`contratos.proposta_id`).
- **Mudar perfil** de uma licença (`POST /api/contratos-conector/:id/vagas/:vid/perfil`, prévia em `GET .../perfil/previa?para=`): a pessoa continua na vaga, passa a ter os cursos do perfil novo e a licença dela (se já houver) muda de plano. Cobrança: a anuidade vai ao preço do perfil novo e, no ciclo anual, sai fatura proporcional só com a **diferença** de preço (`previaAlteracaoLicencas(..., { troca })`); perfil mais barato = sem estorno.
- **Contrato de cursos por pessoas** (`/api/contratos-cursos`, `services/contratos-cursos.js`; tabelas `contratos_cursos`, `contratos_cursos_itens`, `contratos_cursos_vagas`): o contrato tem os cursos e N vagas; cada vaga é uma pessoa (convite por e-mail, `convidada` até criar a senha, como no Conector). **Só quem ocupa uma vaga vê os cursos** (origem de acesso `contrato`), nada vale para a empresa inteira. A Marsh preenche as vagas no contrato (ou já informa as pessoas ao criar) e o gestor da empresa no portal (`/meus`, em "Licenças da empresa"). Serve para dar um curso a mais a quem tem licença do Conector (ex.: ABAP para Funcional). Cobrança: cortesia, pagamento único (fatura avulsa em rascunho), mensal ou anual (contrato financeiro com `contrato_cursos_id`). Encerrar tira os cursos de todas as vagas e para a cobrança. Contratos antigos (liberação para a empresa) foram convertidos na migração 40: viraram itens + vagas livres.

### Contratos do Conector por vagas (abertos pela lista de Contratos ou pela ficha)

- Quem compra (CPF ou CNPJ) é o **gestor** (`usuarios.portal_papel = 'gestor'`): no portal vê o contrato, passa cada vaga para uma pessoa (convite por e-mail), pode ocupar uma vaga ele mesmo e cadastra os sistemas SAP (até 10, como nas licenças; `max_sids` não limita mais). A licença nova da tela Licenças já vem com os sistemas do contrato do cliente.
- Vagas por perfil (`contratos_conector_vagas.perfil`): **abap** (IA no ABAP + Portal + Conector), **funcional** (IA para Funcionais + Portal + Conector), **ambos** (os quatro). Os cursos seguem `cursos.trilha` (abap | funcional | portal | conector), marcada no modal do curso.
- Quem ocupa uma vaga (`portal_papel = 'aluno'`) vê os próprios cursos; licenças da empresa e assistente respondem 403 (`middleware/bloquear-aluno.js`) e o financeiro mostra só as compras dele. **Chamados** (desde a v5.9): abre e acompanha só os próprios — os que abriu no portal e os que o Conector abriu pela licença dele (`middleware/chamados-do-aluno.js`); não aprova chamado do Conector (é do gestor). Teste: `testes/chamados-sap.js`. Liberar a vaga desativa o aluno sem outra vaga (o progresso fica guardado).
- Contrato suspenso, cancelado ou fora da validade corta os cursos das vagas. Regras em `backend/services/contratos-conector.js`; rotas em `/api/contratos-conector` (portal: `/eu`, `/meus/...`; admin: o resto).
- **Certificado e licença por pessoa** (`backend/services/certificacao.js`): ao concluir todas as aulas dos cursos publicados das trilhas do perfil, a pessoa ganha um certificado gravado (`certificados`, código `MC-XXXXXXXX`, validação pública em `/certificado.html?c=CODIGO`) e uma licença só dela (`licencas.vaga_id/usuario_id`): 1 máquina, plano Desenvolvimento (ABAP/Ambos) ou Leitura (Funcional), SIDs, fim e status copiados do contrato a cada mudança. Liberar a vaga cancela a licença; a mesma pessoa voltando reativa a mesma chave.
- A chave fica também cifrada (`licencas.chave_cifrada`, AES-256-GCM com `SISTEMA_CHAVE_CIFRA` ou, na falta, `MARKETING_CHAVE_CIFRA`): aparece só no portal da própria pessoa. Sem a variável, a licença funciona, mas a chave não aparece nem vai no instalador.
- **Instalador já configurado**: "Baixar instalador" no portal gera um link curto (`/api/publico/pacote/:token`, 10 min) que entrega o zip publicado com um `licenca.json` (chave da pessoa) acrescentado na raiz, em streaming (`backend/services/pacote-instalador.js`). O instalador (`SAP\Integration ECC\instalador\instalar.ps1`) lê esse arquivo, valida a chave sozinho e vai direto para usuário/senha do SAP.

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
- `POST /api/chamados/:id/aprovacao` — Gestor do cliente aprova/recusa chamado do Conector SAP
- `GET /api/chamados/:id/especificacao.md` — Especificação do chamado do conector (download)
- `GET /api/chamados/fila-conector` — Fila da fábrica ABAP (equipe)
- Chamados abertos pelo Conector SAP: `POST /api/licencas-conector/chamados` e `/chamados/listar` (ver `docs/licencas-conector.md`)

### Atendimentos (timeline)
- `GET /api/atendimentos?chamado_id=X` — Histórico do chamado
- `POST /api/atendimentos` — Adicionar comentário/ação

### Usuários
- `GET /api/usuarios` — Listar usuários da empresa
- `POST /api/usuarios` — Criar usuário
- `PUT /api/usuarios/:id` — Editar usuário
- `PUT /api/usuarios/:id/senha` — Redefinir senha
- `DELETE /api/usuarios/:id` — Desativar usuário
- `GET /api/usuarios/:id/ficha` — **Ficha do usuário** (v5.9, Usuários → olho ou clique no nome): dados, acesso no portal, licença do Conector e vagas de cursos, cursos liberados agora (`acessos.cursosDoUsuario`, a mesma conta do "Meus cursos" do portal) e os chamados (cliente: abertos por ele ou pelo Conector com a licença dele; equipe: abertos por ele ou atribuídos a ele).
- `POST /api/usuarios/:id/simular` — **Simulador de acesso** (v5.8): o administrador recebe um token de 1 h do usuário, marcado com `simulado_por`. O middleware `autenticar` só deixa ler (GET) com esse token e derruba a simulação se o administrador for desativado. Administrador comum não simula Admin Sistema; ninguém simula o super usuário. Fica na auditoria (`simular_acesso`). No navegador, `frontend/comum/simulacao.js` guarda o acesso do administrador, mostra a faixa "Voltar ao meu acesso" e o devolve no fim (ou quando o token vence). Teste: `testes/simulador-acesso.js`.

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
- **Variáveis de ambiente**: `DATABASE_URL`, `JWT_SECRET` (marketing: `MARKETING_CHAVE_CIFRA` e as `S3_*` do storage; veja a seção Marketing)

O banco PostgreSQL também é hospedado no Render (plano free).

---

Desenvolvido por Daniel Marsh
