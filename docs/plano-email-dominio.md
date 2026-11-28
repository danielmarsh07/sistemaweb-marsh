# E-mail do portal no domínio marshconsultoria.com.br (envio e recebimento)

Levantamento: 27/11/2026 (Daniel + Claude). Objetivo: todo e-mail que o portal **envia** e **recebe** passa a usar
caixas do domínio `marshconsultoria.com.br`, sem Gmail no meio, e as respostas dos clientes voltam para o
chamado no portal.

## 1. Como está hoje

| Ponto | Situação |
|---|---|
| Envio | `backend/services/email.js` via **Resend** (`RESEND_API_KEY`), remetente fixo no código `Marsh Consultoria <noreply@marshconsultoria.com.br>` (constante `FROM`). Todo envio passa por `enviar()` e é gravado em `emails_enviados`. |
| Quem chama | chamados, atendimentos, licenças do conector, agente ABAP, comercial (propostas), financeiro (faturas e lembretes), público (site), usuários (senha e boas-vindas), alertas, consumo de IA, loja, vigência. |
| Responder para | só na resposta ao solicitante (`enviarRespostaSolicitante`): `replyTo` = e-mail do consultor no cliente (`clientes.email_resposta_marsh`). Nos demais, a resposta vai para `noreply@` e se perde. |
| Recebimento | **não existe**: nenhuma rota/job lê e-mail; resposta de cliente não volta para o chamado. |
| Equipe | logins e avisos internos em e-mails pessoais (ex.: `SUPER_USUARIO_EMAIL` padrão `daniel.marsh.sap@gmail.com`); `abap_padrao_usuario_id` e o autor dos chamados internos (`MARSH_AUTOR_EMAIL` no conector) usam o login. |
| Endereços fixos no código | `email.js` linha ~149 (rodapé `daniel.marsh@marshconsultoria.com.br`), `services/comercial.js` (contato da proposta), site `index.html`. |
| Caixas do domínio | MX na **Locaweb** (`mx.core/a/b/jk.locaweb.com.br`). |
| DNS | DKIM do Resend publicado (`resend._domainkey`), subdomínio `send.` com MX do Amazon SES (retorno do Resend). **Dois registros SPF na raiz** (`include:_spf.locaweb.com.br -all` e `include:amazonses.com ~all`): SPF com dois registros é inválido (permerror) e prejudica a entrega. DMARC `p=none`. |

## 2. O que fazer

### 2.1 DNS (antes de tudo)
1. Unificar o SPF da raiz num registro só: `v=spf1 include:_spf.locaweb.com.br include:amazonses.com -all`
   (o Resend autentica pelo subdomínio `send.`; manter o `amazonses` só se algum envio sair com o domínio raiz).
2. Conferir/ativar o DKIM da Locaweb para as caixas pessoais.
3. DMARC: manter `p=none` com `rua=mailto:dmarc@marshconsultoria.com.br` por 2 semanas, depois `p=quarantine`.

### 2.2 Envio
1. Remetentes por assunto, configuráveis por variável de ambiente (nada fixo no código):
   `EMAIL_FROM_CHAMADOS` (ex.: `Marsh Consultoria <chamados@marshconsultoria.com.br>`), `EMAIL_FROM_FINANCEIRO`,
   `EMAIL_FROM_COMERCIAL`, `EMAIL_FROM_SISTEMA` (senha, alertas); padrão = `noreply@` como hoje.
2. `Reply-To` sempre numa caixa lida: chamados -> endereço de resposta do item 2.3; financeiro -> `financeiro@`;
   comercial -> `comercial@`. Mantém o `email_resposta_marsh` como opção por cliente.
3. Trocar os endereços fixos do código por variáveis (`EMAIL_CONTATO`).
4. Continuar registrando tudo em `emails_enviados` (já existe).

### 2.3 Recebimento (respostas voltam para o chamado)
Duas opções:
- **A (recomendada): Resend Inbound num subdomínio** (ex.: `resposta.marshconsultoria.com.br`, MX para o Resend),
  webhook `POST /api/email-entrada` (assinatura verificada). Não mexe no MX da Locaweb. `Reply-To` de cada chamado =
  `chamado+<id>@resposta.marshconsultoria.com.br` -> o id vem do endereço, sem depender do assunto.
- **B: ler a caixa da Locaweb por IMAP** (job a cada 5 min, conta `chamados@`, biblioteca `imapflow`), achando o chamado
  pelo `#<id>` no assunto. Uma caixa só, mas depende de senha IMAP e de polling.

Nos dois casos:
1. Tabela `emails_recebidos` (de, para, assunto, corpo texto/HTML limpo, message_id, in_reply_to, chamado_id, status,
   recebido_em) com chave única por `message_id` (não duplica).
2. Resposta reconhecida vira **atendimento** do chamado (autor = usuário do cliente pelo e-mail; senão "e-mail de <remetente>"),
   anexos para o storage do chamado (mesmos limites/tipos de `chamados_anexos`).
3. Remover a citação do e-mail anterior (`>` e "Em ... escreveu:") antes de gravar.
4. Remetente desconhecido ou sem chamado -> fila "E-mails não associados" na tela da equipe (associar ou descartar).
5. Aviso ao ABAP responsável (já existe `notificarNovoAtendimento`), sem e-mail ao próprio remetente.
6. Proteção: só domínios dos clientes cadastrados + equipe; limite por remetente; ignorar auto-resposta (`Auto-Submitted`).

### 2.4 Equipe
1. Logins da equipe no domínio (`daniel.marsh@marshconsultoria.com.br`): trocar o e-mail do usuário, `SUPER_USUARIO_EMAIL`
   no Render, `MARSH_AUTOR_EMAIL` no `.env` do conector, e conferir `abap_padrao_usuario_id`.
2. Avisos internos (alertas, análise do agente) para a caixa do domínio.

### 2.5 Tela, testes e versão
1. Sistema -> E-mails: abas Enviados (já existe a tabela) e Recebidos/Não associados.
2. Testes: envio com remetente por tipo; webhook/IMAP gravando atendimento; duplicado ignorado; remetente estranho
   na fila; anexo; citação removida.
3. Changelog + `testes/versoes.js`; variáveis novas no README (Render -> Environment).

## 3. Ordem sugerida
1. DNS (SPF/DMARC) e criação das caixas na Locaweb (`chamados@`, `financeiro@`, `comercial@`).
2. Remetentes e Reply-To por variável (rápido, sem risco).
3. Recebimento (opção A ou B) + tabela + atendimento + fila.
4. Migração dos logins da equipe.

## 3.1 Andamento (27/11/2026)
- **DNS:** conferido às 21h50 — a raiz já tem um SPF só (`include:_spf.locaweb.com.br -all`) e o `include:amazonses.com`
  ficou no subdomínio `send.` (retorno do Resend). Item 2.1.1 resolvido. DMARC continua `p=none`.
- **Escopo escolhido pelo Daniel:** só o envio dos e-mails de comunicação, com `noreply@` + uma caixa de contato.
  O recebimento no chamado (2.3) fica para depois.
- **Feito (v9.4):** `EMAIL_FROM`, `EMAIL_RESPOSTA` e `EMAIL_CONTATO`. Reply-To padrão em todo envio, e rodapé e proposta
  lidos da variável. Teste `testes/email-dominio.js`.
- **Origem do Gmail:** nenhum código do portal ou do agente envia pelo Gmail. O que sai do Gmail são os e-mails
  mandados à mão (ex.: retorno do chamado #111). Para esses: usar o portal (resposta ao solicitante/encerramento)
  ou configurar no Gmail o "Enviar e-mail como" com o SMTP da Locaweb.

## 4. Decisões pendentes
- Opção de recebimento: A (Resend Inbound em subdomínio) ou B (IMAP na Locaweb).
- Nomes das caixas.
- Ligação com o chamado #115 (agente de e-mail da Multiterminais): o mesmo serviço de entrada pode atender os dois.
