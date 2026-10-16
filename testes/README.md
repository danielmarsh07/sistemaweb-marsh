# Testes

Roteiros que exercitam a API de ponta a ponta contra o **banco local (Docker)**. Eles criam registros, conferem o resultado e apagam o que criaram.

> Trava de segurança: todos carregam `.env.local` e abortam se o `DATABASE_URL` não for `localhost`. O `.env` aponta para produção e nunca é usado aqui.

## Como rodar

1. Suba o banco e o servidor local (o token de webhook é o que o teste de PIX usa):

   ```bash
   docker compose up -d
   ASAAS_WEBHOOK_TOKEN=token-teste-local-123 npm run dev:local
   ```

2. Em outro terminal, na raiz do projeto:

   ```bash
   node testes/financeiro-contas-fluxo-dre.js     # contas a pagar, fluxo de caixa, DRE
   node testes/comercial-funil-propostas.js       # lead do site, propostas, aceite, contrato
   node testes/financeiro-pix-relatorios.js       # webhook PIX, baixa, relatórios, CSV
   node testes/assistente-financeiro.js           # tools do assistente de voz no financeiro (sem chamar a OpenAI)
   node testes/versoes.js                         # histórico de versões (frontend/comum/changelog.js): numeração e datas; sem banco, rode antes de cada commit
   node testes/assistente-sistema.js              # Ivy só do super usuário (API) + estrutura do banco, SELECT só leitura e documentação
   node testes/assistente-acoes.js                # ações por voz da Ivy (oportunidades, posts) com confirmação + consultas de treinamentos
   node testes/assistente-gestao.js               # tools de gestão da Ivy (comercial, DRE, caixa, marketing, alertas, licenças): permissões e números iguais aos das telas
   node testes/listagens-ordenacao.js             # ordenação por coluna e filtros das listagens e da visão mensal (Chrome headless)
   node testes/licencas-ativacao.js               # licenças do conector: ativação por máquina, limite, revogação, conexões, download
   node testes/contratos-conector.js              # contratos por vagas: gestor, perfis/trilhas, aluno restrito, SIDs, liberar/suspender
   node testes/certificacao-conector.js           # certificado + licença por pessoa + instalador com licenca.json (cifra, chave de licença e s3mock)
   node testes/chamados-conector.js               # chamados abertos pelo conector: abrir/listar, recusas, limite/h, aprovação do gestor, .md, fila
   node testes/fluxo-fase0.js                     # fluxo novo fase 0: isolamento, sessão revogada na hora, webhook repetido, NFS-e sem regredir, vagas/contrato sem corrida, CPF/CNPJ único, auditoria
   node testes/fluxo-fase1.js                     # fluxo novo fase 1: vários contratos por cliente, mensal × anual, rascunhos manuais/automáticos sem duplicar, histórico, reajuste, cobrança do Conector, proposta → contrato
   node testes/fluxo-fase2.js                     # fluxo novo fase 2: 100 licenças e a 101ª bloqueada (convites simultâneos), convite → senha → ativa, cancelar/expirar, revogar sem apagar a conta, vários administradores, isolamento
   node testes/simulador-conector.js [saida.pdf]  # simulador de preço do Conector SAP: cálculo, validações, tabela de preços, gerar proposta + PDF A4 (Chrome headless)
   node testes/marketing.js                       # Instagram: conta cifrada, upload PNG→JPEG, posts, importar agenda, publicação num Graph falso, retentativa, limite, métricas, token
   ```

   O de licenças precisa do servidor com `LICENCA_CHAVE_PRIVADA` (senão `/validar` dá 503). No Git Bash:
   `LICENCA_CHAVE_PRIVADA="$(cat .licenca_chave_privada.txt)" npm run dev:local`.

   O de marketing sobe um servidor falso do Graph na porta 3999 e precisa do servidor local apontando para ele, com storage S3 local
   (`docker run -d --name marsh-s3mock -p 9090:9090 -e initialBuckets=marsh-teste adobe/s3mock`):
   `INSTAGRAM_GRAPH_URL=http://localhost:3999 MARKETING_CHAVE_CIFRA=abababababababababababababababababababababababababababababababab MARKETING_JOBS=off S3_BUCKET=marsh-teste S3_ENDPOINT=http://localhost:9090 S3_REGION=us-east-1 S3_ACCESS_KEY_ID=teste S3_SECRET_ACCESS_KEY=teste npm run dev:local`.

   Cada linha sai como `OK` ou `FAIL`. Linhas com `!` são recusas esperadas pelo teste (ex.: 400 de validação).

## Observações

- `comercial-funil-propostas.js` usa o limite de 5 leads por 15 minutos: rodar duas vezes seguidas pode dar 429. Reinicie o servidor para zerar.
- `financeiro-pix-relatorios.js` tenta criar um PIX real no **sandbox** do Asaas. Sem chave PIX cadastrada no sandbox, o Asaas recusa e o teste apenas registra a mensagem.
- As rotas do conector (`/api/licencas-conector`) aceitam 60 requisições/minuto por IP: `licencas-ativacao.js` e `chamados-conector.js` juntos passam disso; rode um, espere 1 minuto (ou reinicie o servidor) e rode o outro.
- `screenshot-dashboard.js` com página `portal` entra como usuário cliente (`SCREENSHOT_CLIENTE_ID` escolhe a empresa).
- `screenshot-dashboard.js` abre o dashboard logado no Chrome headless e salva um PNG da página pedida, para conferir layout (desktop e celular, tema claro ou escuro).
