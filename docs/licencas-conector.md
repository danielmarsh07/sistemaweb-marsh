# Licenças do conector Claude ↔ SAP

Módulo do Sistema Marsh que controla o contrato de cada cliente do conector (projeto
`SAP\Integration ECC`). Painel: **Produtos SAP → Licenças**.

## Como funciona

```
Portal do cliente   --(Baixar instalador)-------------> GET /api/licencas/download
Instalador          --(chave + hash da máquina)-------> /api/licencas-conector/ativar
                    <--(titular, plano, SIDs, conexões SAP pré-preenchidas)--
Conector no cliente --(chave + SID + hash do usuário [+ hash da máquina])--> /api/licencas-conector/validar
                    <--(licença assinada Ed25519, vale até 7 dias)--
Conector            --(só contadores por ferramenta)---> /api/licencas-conector/uso
```

- **Chave** `MRSH-XXXX-XXXX-XXXX`: aparece uma única vez (criar / gerar nova). No banco fica só o hash SHA-256.
- **Titular**: nome e e-mail do funcional/consultor do cliente responsável pela licença.
- **Planos**: `leitura` (sem gravação), `desenvolvimento` e `empresa` (com gravação).
- **Recusas na hora**: chave inválida, licença suspensa/cancelada/vencida, SID fora da licença,
  limite de usuários (usuários distintos nos últimos 30 dias), máquina revogada, limite de máquinas.
- **Servidor fora do ar**: o conector usa a licença em cache até expirar (7 dias), depois mais
  7 dias só leitura, depois bloqueia.
- **Privacidade**: o servidor nunca recebe código nem dados do SAP; o usuário SAP chega como hash.
  As conexões guardam só SID, descrição, URL, mandante e idioma — **nunca usuário/senha do SAP**
  (campos extras enviados ao painel são descartados).

## Entrega ao cliente (instalador)

1. Marsh cria a licença no painel: titular, plano, SIDs, limites e as **conexões SAP**.
2. Envia a chave ao titular.
3. O titular entra no portal → seção **Conector SAP** → **Baixar instalador**, executa e informa a chave.
4. O instalador chama `/ativar`: a máquina fica registrada e as conexões (só dos SIDs da licença)
   chegam pré-preenchidas. Usuário e senha do SAP o titular digita na máquina dele.

## Máquinas

- Cada computador é identificado por `maquina_hash` (SHA-256 gerado no cliente, 64 hex minúsculos).
  Tabela `licencas_ativacoes` (uma linha por licença + máquina).
- **Máx. de máquinas** (`max_maquinas`, vazio = ilimitado) conta só as ativações **não revogadas**.
  Máquina já ativada continua ativando/validando mesmo com o limite cheio.
- Painel → Licenças → ícone **Máquinas**: nome, usuário Windows, versão, primeira ativação, última
  validação. A coluna "Máquinas" mostra ativas/limite e quantas falaram com o servidor nas últimas 24h.
- **Revogar**: a máquina passa a receber `maquina_revogada` em `/ativar` e `/validar` e libera a vaga.
  **Reativar** só se couber no limite (senão 409).
- Gerar **nova chave** não mexe nas máquinas ativadas.

## Contrato das rotas públicas (`/api/licencas-conector`)

Todas com limite de 60 requisições/minuto por IP. Recusa = **403** `{ erro, motivo }`; corpo inválido = **400** `{ erro }`.

**POST `/ativar`** — `{ chave, maquina_hash, nome_maquina, usuario_windows?, versao? }`
- `maquina_hash` 64 hex (obrigatório); `nome_maquina` obrigatório, até 100; `usuario_windows` até 100; `versao` até 30.
- `motivo`: `chave`, `suspensa`, `cancelada`, `vencida`, `maquina_revogada`, `maquinas`.
  (Licença cancelada pelo painel sai da busca e responde `chave`.)
- 200:
  ```json
  { "cliente": "...", "titular_nome": "...", "titular_email": "...", "plano": "leitura",
    "permite_escrita": false, "data_fim": "AAAA-MM-DD", "sids": ["DEV","QAS"],
    "conexoes": [{ "sid": "DEV", "descricao": "Desenvolvimento", "url": "https://idce07.multi.dom:8011",
                   "mandante": "200", "idioma": "PT" }],
    "max_maquinas": 2 }
  ```
  `conexoes` vem filtrado pelos `sids` da licença. Não é assinado (o que vale para uso é o `/validar`).

**POST `/validar`** — `{ chave, sid, usuario_hash, versao?, maquina_hash?, nome_maquina? }`
- Sem `maquina_hash`: comportamento antigo (conectores anteriores seguem funcionando).
- Com `maquina_hash`: mesma regra de máquina do `/ativar` (`maquina_revogada` / `maquinas`; senão
  registra/atualiza a última validação) e o payload assinado ganha `"maquina_hash"` — o conector
  deve conferir que é o da própria máquina.
- O payload assinado sempre traz `"conexoes": [{ "sid", "url", "mandante" }]` — as conexões da licença
  filtradas pelos `sids` (sem descrição/idioma; lista vazia se não houver cadastro). **O produto só pode
  ser usado nos sistemas SAP do próprio cliente**: o conector recusa conectar em URL/mandante fora dessa lista.
- `motivo` extra: `sid`, `usuarios`.

## Chamados pelo conector (ferramenta `abrir_chamado`)

O consultor funcional do cliente pede no Claude; o Claude analisa o Z, escreve a especificação em
markdown e, com o OK do consultor, o conector abre o chamado no portal. Vira um chamado normal
(mesma tabela `chamados`, timeline, SLA, e-mail de chamado novo) com `origem = 'conector'`,
`categoria = 'Conector SAP'`, `aberto_por_usuario_id` NULL e os dados extras em colunas próprias
(`licenca_id, sid, modulo, tipo_demanda, pedido_original, especificacao, objetos_sap, solicitante_nome,
solicitante_email, usuario_hash, maquina_hash, aprovacao_cliente, aprovado_por_usuario_id, data_aprovacao`).

- **Aprovação do gestor**: `licencas.chamados_exigem_aprovacao` (padrão `true`, checkbox no modal da licença).
  Exige → o chamado nasce `aprovacao_cliente = 'pendente'`; não exige → nasce `'aprovado'`.
  Chamados antigos (portal/painel) ficam com `origem` e `aprovacao_cliente` NULL e funcionam como antes.
- **SLA**: pendente não conta prazo (`sla = null`); aprovado conta a partir de `data_aprovacao`.
- **Fila da fábrica ABAP**: aprovados com status aberto/em andamento, mais antigos primeiro.

**POST `/chamados`** — `{ chave, sid, usuario_hash, maquina_hash, nome_maquina?, versao?, titulo, tipo, modulo,
prioridade?, pedido, especificacao, objetos?, solicitante_nome, solicitante_email? }`
- Autenticação: chave válida, licença `ativa` e não vencida, `sid` da licença, `usuario_hash`/`maquina_hash` 64 hex,
  e a máquina **já ativada** (pelo instalador) e não revogada. Aqui nunca se ativa máquina nova.
  `motivo`: `chave`, `suspensa`, `cancelada`, `vencida`, `sid`, `maquina` ("Máquina não ativada nesta licença.
  Rode o instalador."), `maquina_revogada`.
- Campos (400 `{ erro }` em português): `titulo` 5–200; `tipo` ∈ melhoria | erro | nova_funcionalidade | duvida;
  `modulo` ∈ FI | CO | SD | MM | PP | PM | QM | HR | BASIS | ABAP | CPI | FISCAL | OUTRO (aceita minúsculas);
  `prioridade` ∈ baixa | media | alta | critica (padrão media); `pedido` obrigatório até 20.000;
  `especificacao` (markdown) até 200.000, obrigatória salvo `duvida`; `objetos` até 100 `{ tipo, nome }`
  (tipo até 10, nome até 60, `[A-Z0-9_/]`, convertidos para maiúsculas); `solicitante_nome` obrigatório até 150;
  `solicitante_email` opcional válido; `nome_maquina` até 100 (sem ele, usa o nome da ativação).
  Corpo até 2 MB nesta rota (o resto da API segue com 100 KB).
- Limite: 20 chamados por licença por hora → **429** `{ erro, motivo: 'limite_chamados' }`
  (o limite geral de 60 req/min por IP das rotas do conector também vale; ajuste fino: `CONECTOR_CHAMADOS_POR_HORA`).
- `descricao` do chamado = pedido (até 2.000 caracteres) + "Especificação anexa ao chamado (Conector SAP, sistema <SID>)."
  Status log: "Chamado aberto pelo Conector SAP (<máquina>, <SID>) por <solicitante>".
- **201**: `{ "id": 123, "numero": "#123", "status": "aberto", "aprovacao_cliente": "pendente" | "aprovado", "mensagem": "..." }`
  (a mensagem diz se aguarda a aprovação do gestor no portal).

**POST `/chamados/listar`** — `{ chave, usuario_hash, maquina_hash, todos? }` (mesma autenticação, sem `sid`)
- **200**: lista (array) de até 30 chamados `origem = 'conector'` da licença, mais recentes primeiro — só os do
  `usuario_hash`, salvo `todos: true`:
  `{ id, numero, titulo, status, aprovacao_cliente, prioridade, modulo, sid, data_abertura, ultima_atualizacao, ultimo_comentario }`.
  `ultimo_comentario` = texto (até 2.000 caracteres) do último item da timeline, ou `null`. A timeline é toda
  visível ao cliente no portal (não existe comentário interno); o histórico de status (interno) não sai.

**Painel / portal** (`/api/chamados`, com login)
- `GET /?origem=conector|manual&aprovacao=pendente|aprovado|recusado` — filtros novos. A lista não traz
  `pedido_original`, `especificacao` nem os hashes (só o detalhe).
- `GET /:id` — traz os campos do conector; para a equipe, também `maquina_nome` e `usuario_hash`;
  para o cliente, sem hashes nem `licenca_id`.
- `POST /:id/aprovacao` `{ decisao: 'aprovado' | 'recusado', comentario }` — usuário `cliente` da mesma empresa
  (outra empresa: 403) ou admin (registra "pela Marsh em nome do cliente"); técnico 403. Só com
  `aprovacao_cliente = 'pendente'` (senão 409). Recusa exige comentário e fecha o chamado. Registra na timeline
  (tipos `aprovacao`/`recusa`) e no status log; avisa o outro lado por e-mail.
- `GET /:id/especificacao.md` — equipe ou cliente dono: download `chamado-<id>-<slug>.md` com cabeçalho
  (título, cliente, SID, módulo, tipo, prioridade, solicitante, data, status, aprovação), objetos SAP,
  pedido original e especificação.
- `GET /fila-conector` — equipe (admin/técnico): fila da fábrica ABAP, com a especificação.
- Telas: selos "Conector SAP" e "Aguardando aprovação do cliente"/"Aprovado"/"Recusado" na lista; filtro de
  origem no painel; no detalhe, bloco com SID, módulo, tipo, solicitante, objetos, pedido e a especificação
  renderizada com segurança (texto escapado, só títulos/listas/tabelas/código/negrito/itálico; sem links nem HTML),
  botões "Baixar especificação (.md)", "Copiar especificação" e, se pendente, "Aprovar em nome do cliente"
  (painel, só admin) ou "Aprovar"/"Recusar" (portal). Portal: faixa "N chamados aguardando sua aprovação".
  Código compartilhado: `frontend/comum/chamado-conector.js` e `.css`.

Teste: `node testes/chamados-conector.js` (87 verificações; usa ~40 das 60 requisições/minuto do conector).

## Rotas do painel / portal (`/api/licencas`, com login)

- `GET /download` — admin sempre; cliente só com licença ativa (status ativa e dentro da validade).
  Responde `{ url, versao }` de `CONECTOR_DOWNLOAD_URL` / `CONECTOR_VERSAO` (null se não configurado;
  o portal mostra "Instalador em preparação").
- `GET /minhas` (cliente) — inclui `titular_nome`, `max_maquinas`, `maquinas_ativas`, `conexoes`.
- Admin: `GET /` (com `titular_*`, `max_maquinas`, `conexoes`, `maquinas_ativas`, `maquinas_online_24h`),
  `POST /`, `PUT /:id` (aceitam `titular_nome`, `titular_email`, `max_maquinas`, `chamados_exigem_aprovacao` (booleano, padrão true), `conexoes` — até 10,
  uma por SID, SID 3 alfanuméricos, URL http(s), mandante 3 dígitos, idioma 2 letras), `GET /:id/maquinas`,
  `POST /:id/maquinas/:mid/revogar`, `POST /:id/maquinas/:mid/reativar`.

## Colocar em produção (uma vez)

1. Gerar o par de chaves, localmente:
   ```
   node backend/scripts/gerar-chaves-licenca.js
   ```
2. Render → serviço → **Environment** → `LICENCA_CHAVE_PRIVADA` = a linha da chave privada.
   Nunca no git. Sem ela, `/validar` responde 503.
3. A chave pública vai para `SAP\Integration ECC\src\mcp_sap_adt\chave_publica_licenca.pem`
   (fixa no conector: ele não aceita chave pública vinda do servidor).
4. Render → **Environment** → instalador do conector:
   ```
   CONECTOR_DOWNLOAD_URL=https://<onde o .exe está publicado>
   CONECTOR_VERSAO=1.0.0
   ```
   Sem `CONECTOR_DOWNLOAD_URL` o portal mostra "Instalador em preparação — fale com a Marsh".
5. O instalador grava a chave no conector do cliente (antes era manual no `.env`:
   `SAP_LICENSE_KEY=MRSH-....` e `SAP_LICENSE_SERVER=https://<portal-marsh>/api/licencas-conector`).
   Sem `SAP_LICENSE_KEY` o conector roda em **modo interno Marsh** (uso próprio).

Trocar o par de chaves invalida as licenças em cache dos clientes — só se a privada vazar.

## Testes feitos (2026-10-09, banco descartável em Docker)

- Portal: 22/22 (criação, hash, perfis, assinatura, SID, limite de usuários, uso, suspensão,
  nova chave, vencimento, cancelamento, migração de tema única).
- Conector: 8/8 (validação, bloqueio de escrita no plano leitura, envio de uso, cache offline,
  cache adulterado recusado, SID recusado, modo interno).

## Testes da ativação por máquina (2026-10-13, Docker local)

`node testes/licencas-ativacao.js` — 63/63: validações do painel (conexões, SID repetido, e-mail, máx. de máquinas),
`/ativar` (400/403, sucesso, reativação idempotente, limite), conexões filtradas por SID e sem
usuário/senha, revogar/reativar (409 no limite), `/validar` com e sem `maquina_hash` (assinatura
conferida, `conexoes` no payload assinado, lista vazia sem cadastro), `/minhas`, `/download` (cliente com/sem licença, admin, técnico), suspensa/vencida/cancelada.
O servidor precisa de `LICENCA_CHAVE_PRIVADA` no ambiente (ex.: exportar o conteúdo de
`.licenca_chave_privada.txt` antes do `npm run dev:local`).
