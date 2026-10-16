# Próximas tarefas — venda do Conector SAP por vagas

Atualizado em 16/10/2026. Modelo aprovado: quem compra (CPF ou CNPJ) é o **gestor**, compra **vagas por perfil**
(ABAP, Funcional ou Ambos), passa cada vaga para uma pessoa; a pessoa faz os cursos do perfil, ganha
**certificado** e uma **licença só dela** (1 máquina, 1 ano), e baixa o instalador já configurado.

## Feito

| Versão | O que entrou |
|---|---|
| v3.2 | Cadastros → Preços Conector SAP (tabela de preços fora do simulador) |
| v3.3 | Contratos por vagas: gestor, perfis, aluno vê só os próprios cursos, SIDs pelo portal, trilha nos cursos |
| v3.4 | Certificado gravado com validação pública, licença por pessoa (chave no portal, cifrada), instalador com `licenca.json` |

## Para fazer agora (sem programação)

- [ ] **Conferir a trilha dos 4 cursos** em Produtos SAP → Treinamentos (preenchida pelo título; corrigir se precisar).
- [ ] **Confirmar `MARKETING_CHAVE_CIFRA` no Render** (Environment). Sem ela a licença funciona, mas a chave não aparece no portal e o instalador continua pedindo a chave. Se preferir uma chave só para isso: criar `SISTEMA_CHAVE_CIFRA` (32 bytes em hex) **antes** de emitir as primeiras licenças por pessoa (trocar depois invalida as chaves guardadas).
- [ ] **Remontar o instalador** (`SAP\Integration ECC\instalador\montar_pacote.ps1`) e publicar em Licenças → Publicar instalador, para valer a leitura do `licenca.json`.
- [ ] **Testar o instalador novo numa máquina**: baixar pelo portal com uma vaga certificada, rodar `Instalar.cmd` e confirmar que abre direto em usuário/senha do SAP.
- [ ] **Teste ponta a ponta em produção** com e-mails seus: contrato com 1 vaga, convite, cursos, certificado, licença, download, ativação.

## Etapa 3 — cadastro pelo site e pagamento (Asaas)

Decisões pendentes antes de começar:

- [ ] Preço de cada perfil (ABAP, Funcional, Ambos) para a compra pelo site. Hoje a tabela tem Leitura e Desenvolvimento (mensal e anual por mês); falta definir o **Ambos** (sugestão: igual a Desenvolvimento).
- [ ] Parcelamento no cartão: aceita? até quantas vezes?
- [ ] O ano de uso conta a partir do **pagamento** ou do **certificado**? (recomendado: certificado)
- [ ] Conta Asaas de produção aprovada para cobrança (PIX, cartão, boleto)?

O que será construído:

- [ ] Cadastro pelo próprio comprador: CPF ou CNPJ, nome, e-mail, telefone, aceite dos termos; cria o cliente e o login do gestor.
- [ ] Escolha das vagas por perfil com o total calculado pela tabela de preços.
- [ ] Cobrança no link de pagamento do Asaas (PIX, cartão, boleto) e pedido guardado no sistema.
- [ ] Webhook: pagamento confirmado → contrato criado como "compra pelo site" (origem `loja`), vagas liberadas, fatura paga lançada (aparece no Financeiro, pode gerar NFS-e), e-mail de boas-vindas.
- [ ] Estorno/chargeback (inclui os 7 dias de arrependimento do CDC) → contrato cancelado, acessos e licenças cortados.
- [ ] Portal do gestor: "Minha compra" com pagamento, recibo e nota fiscal.

## Etapa 4 — renovação anual

- [ ] Definir o valor da renovação por perfil.
- [ ] Avisos por e-mail 30, 7 e 1 dia antes de vencer (gestor) e alerta no painel.
- [ ] Botão **Renovar** no portal do gestor → cobrança Asaas → pago: validade do contrato +1 ano (a partir do vencimento atual ou de hoje, o que for maior); as licenças acompanham sozinhas.
- [ ] Vencido sem renovar: cursos e conector param (já funciona assim); dados e progresso guardados.

## Etapa 5 — landing page do Conector

- [ ] Página própria do Conector no site: o que é, para quem (ABAP / Funcional), como funciona (comprar → assistir → certificar → usar), preços por perfil, perguntas frequentes, segurança/LGPD.
- [ ] Botão de compra levando ao cadastro da etapa 3.
- [ ] Ligar com o post de lançamento da turma piloto no Instagram.

## Melhorias anotadas (sem data)

- [ ] Gestor pedir troca de máquina pelo portal (hoje só a Marsh revoga em Licenças → Máquinas).
- [ ] Certificado com assinatura/QR Code apontando para a página de validação.
- [ ] Relatório no painel: vagas ocupadas, certificados emitidos e licenças ativas por contrato.
- [ ] Assinatura de código do instalador (sem ela o SmartScreen/antivírus pode bloquear).
