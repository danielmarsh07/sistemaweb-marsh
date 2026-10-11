# Sistema Marsh — avaliação e próximos passos

Atualizado em 11/10/2026. Marque `[x]` conforme for concluindo.

## Avaliação

O sistema cobre o ciclo inteiro da Marsh num lugar só: venda (funil e propostas), contrato, faturamento com NFS-e e PIX, contas a pagar, visão mensal, DRE, atendimento, licenças, cursos, portal do cliente e o site captando lead. Os fluxos de dinheiro têm testes automáticos (96 verificações em `testes/`), funcionam no celular e nos temas claro e escuro, e os dados de teste ficam isolados da produção.

## Infraestrutura e segurança (por ordem de risco)

| # | Feito | Item | Por quê | Esforço |
|---|---|---|---|---|
| 1 | [ ] | **Backup do banco** | Conferido em 11/10/2026: `marsh-db` está no plano pago **Basic-256mb** (não expira), PostgreSQL 18, Oregon, 8,5% de 1 GB usado. Recovery: volta a qualquer momento dos **últimos 3 dias**; exportação completa só **manual** (botão "Create export", guardada 7 dias). Lacuna: problema notado depois de 3 dias não tem volta. Fazer: (a) exportar agora e guardar fora do Render; (b) cópia semanal automática fora do Render, guardada por meses (~meio dia). Ligar o autoscaling ou aumentar o disco quando passar de ~70%. | baixo |
| 2 | [x] | **Alerta quando algo falha** — feito: Sistema → Alertas + e-mail (máx. 1 a cada 6 h por problema); falta só cadastrar o monitor externo em `/api/saude` | Falha de e-mail de fatura, do webhook do Asaas ou da rotina horária só aparece no log. Monitor de disponibilidade + e-mail de alerta para erros críticos. | baixo |
| 3 | [x] | **Senhas e acesso** — feito: convite por e-mail, esqueci minha senha, alterar minha senha (sistema e portal), mínimo 8 com letras e números | Sem "esqueci minha senha" nem convite por e-mail; senha mínima de 6 caracteres. Convite com link para criar a senha, recuperação de senha e senha mais forte. | médio |
| 4 | [ ] | **Migrações do banco** | As tabelas são criadas por um bloco de ~700 linhas no `server.js` a cada deploy; se uma alteração falha, o servidor sobe mesmo assim (foi o caso do `nome_fantasia` do fornecedor). Migrações numeradas + alerta de falha. | médio |
| 5 | [ ] | **Testes automáticos no GitHub** | Os testes só rodam quando alguém roda. Rodar a cada push, antes do deploy, para barrar erro antes de ir ao ar. | baixo |
| 6 | [ ] | **LGPD** | Página de privacidade e termos de uso no site e no portal. | baixo |

## Produto

| # | Feito | Item | Situação |
|---|---|---|---|
| 7 | [ ] | **Assistente de voz no financeiro novo** | ainda consulta o livro-caixa antigo: "qual meu saldo?" responde com dados vazios |
| 8 | [ ] | **Reajuste anual dos contratos** | IPCA/IGP-M fica gravado, mas o valor nunca muda sozinho |
| 9 | [ ] | **Tabela de impostos** | aguardando o contador confirmar regime, alíquotas, retenções por cliente e INSS do pró-labore |
| 10 | [ ] | **Importar a planilha de custos** | aguardando: itens pessoais, vencimento das faturas dos cartões, parcela atual de cada item, valores em branco |
| 11 | [ ] | **Cursos — etapa 1: conteúdo no ar** | decidir hospedagem de vídeo, formato das aulas e material de apoio |
| 12 | [ ] | **Cursos — etapa 2: aluno e turma** | matrícula por pessoa, prazo de acesso (junto com o item 3) |
| 13 | [ ] | **Cursos — etapa 3: venda** | página pública, checkout Asaas, matrícula automática |
| 14 | [ ] | **Cursos — etapa 4: avaliação e certificado** | prova, certificado com código de verificação |
| 15 | [ ] | **Cursos — etapa 5: engajamento e números** | quanto do vídeo foi assistido, lembretes, relatório |
| 16 | [ ] | **Conciliação bancária** | importar extrato OFX do Bradesco e dar baixa automática nas transferências |
| 17 | [ ] | **Pontas soltas** | cliente suspenso bloquear portal e licença; tier SLA mudar os prazos; fim do contrato avisar sobre a licença |
| 18 | [ ] | **Retirar o livro-caixa antigo** | telas e tabelas sem uso (depois do item 7) |

## Ordem sugerida

1. Itens **1 e 2** — baratos e evitam perda de dados ou falha silenciosa.
2. Item **3** junto com a **etapa 2 dos cursos** (as duas precisam de convite e recuperação de senha).
3. **Cursos**, etapas 1 a 5.
4. Itens **7 e 8**, depois o restante.

## Pendências com terceiros

- **Contador:** regime tributário (Lucro Presumido?), alíquotas, retenções de cada cliente (Multi-Terminais, Elite Laudos), PIS/COFINS retidos ou via DARF, INSS sobre o pró-labore.
- **Cadastro dos clientes:** conferir CEP, rua, número e bairro de Multi-Terminais e Elite Laudos antes da primeira NFS-e real.
