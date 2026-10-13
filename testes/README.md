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
   node testes/listagens-ordenacao.js             # ordenação por coluna e filtros das listagens e da visão mensal (Chrome headless)
   node testes/licencas-ativacao.js               # licenças do conector: ativação por máquina, limite, revogação, conexões, download
   ```

   O de licenças precisa do servidor com `LICENCA_CHAVE_PRIVADA` (senão `/validar` dá 503). No Git Bash:
   `LICENCA_CHAVE_PRIVADA="$(cat .licenca_chave_privada.txt)" npm run dev:local`.

   Cada linha sai como `OK` ou `FAIL`. Linhas com `!` são recusas esperadas pelo teste (ex.: 400 de validação).

## Observações

- `comercial-funil-propostas.js` usa o limite de 5 leads por 15 minutos: rodar duas vezes seguidas pode dar 429. Reinicie o servidor para zerar.
- `financeiro-pix-relatorios.js` tenta criar um PIX real no **sandbox** do Asaas. Sem chave PIX cadastrada no sandbox, o Asaas recusa e o teste apenas registra a mensagem.
- `screenshot-dashboard.js` abre o dashboard logado no Chrome headless e salva um PNG da página pedida, para conferir layout (desktop e celular, tema claro ou escuro).
