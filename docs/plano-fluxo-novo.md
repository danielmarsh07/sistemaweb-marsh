# Plano do fluxo novo (clientes → contratos → licenças → cursos → cobrança)

Origem: [Fluxo Novo Marsh](Fluxo%20Novo%20Marsh/Fluxo%20Novo%20Marsh.txt). Análise feita e aprovada em 2026-10-16.

## Decisões do dono (2026-10-16)

1. **Inadimplência:** fatura vencida gera alerta; a suspensão das licenças e dos cursos-benefício acontece **automaticamente após 30 dias** de atraso.
2. **Faturas automáticas:** o sistema gera o **rascunho** sozinho; o admin aprova e, aprovado, o envio (NFS-e + e-mail) segue automático.
3. **Benefícios:** cadastro editável (produto/perfil → cursos), criado já com a regra atual (ABAP → IA no ABAP + Portal + Conector; Funcional → IA Funcional + Portal + Conector; Ambos → os 4).
4. **Preços da venda online:** vêm da tabela atual de Cadastros → Preços Conector SAP.
5. **Ao final:** atualizar o **Roteiro de uso** (página do dashboard) com o fluxo novo.

## Fases

| Fase | Versão | Conteúdo | Situação |
|---|---|---|---|
| 0. Segurança e base | v3.5 | Chamados fail-closed; login revalidado no banco (revogação imediata); auditoria geral; eventos do webhook sem repetição; NFS-e sem duplicar; tipo de pessoa no cliente; mesma pessoa não ocupa 2 vagas do mesmo contrato; conversão oportunidade→contrato sem corrida | feita (testes/fluxo-fase0.js) |
| 1. Contratos unificados | v3.6 | Tipo (serviço/produto) e periodicidade (mensal/anual); histórico e reajuste; contrato do Conector ligado ao financeiro (fatura anual); rascunho automático de faturas; proposta aceita → contrato com itens | feita (testes/fluxo-fase1.js) |
| 2. Licenças e admin corporativo | v3.7 | Vários administradores por empresa; atribuição livre → convidado → ativo → revogado; cancelar/reenviar convite; histórico; expiração automática; quem perde a vaga mantém o login | feita (testes/fluxo-fase2.js) |
| 3. Direitos de acesso e benefícios | v3.8 | Matrículas + direitos de acesso com origem; cadastro de benefícios; migração das regras atuais; "Meus cursos" com origem | feita (testes/fluxo-fase3.js) |
| — Ficha do cliente (pedido do dono) | v3.9 | Ficha virou o painel de controle da empresa | feita |
| 4. Venda de cursos | v4.0 | Ofertas, cupons, pedidos, checkout Asaas, webhook → matrícula; pendente/recusado/estorno/contestação; modo teste (homologação) | feita (testes/fluxo-fase4.js) |
| 4b. Venda do Conector pelo site | — | Compra de licenças por perfil (preços da tabela) reaproveitando pedidos/checkout | a fazer |
| 5. Automações | v4.1 | Renovação (avisos 30/7/1), inadimplência (alerta + suspensão em 30 dias), log de e-mails; **Roteiro de uso atualizado** (relatórios dedicados ficaram de fora — a ficha cobre) | feita (testes/fluxo-fase5.js) |

## Notas de implementação

- Preço sugerido da cobrança do Conector: plano anual da tabela × 12 por vaga. **Perfil Ambos usa o preço de Desenvolvimento** até a tabela ganhar um preço próprio (pendência da venda online).
- Contrato anual que vence no próprio mês de cobrança não gera nova anuidade: isso é renovação (fase 5).
- Histórico de contratos usa a tabela `auditoria` (entidade `contrato`); começa na v3.6.
- Administrador corporativo = tabela `clientes_admins` (o "gestor" do portal). `contratos_conector.gestor_usuario_id` fica só como o comprador/contato.
- Estado da licença (`contratos_conector_vagas.estado`): livre → convidada → ativa. Cursos e licença só valem com `ativa`. O convite expira quando não há link válido (72 h; reenviar renova) — a rotina horária libera a licença.
- Histórico das licenças = `auditoria` (entidade `vaga_conector`), sem tabela nova.
- Acesso a curso (fase 3) é decidido **ao vivo** por `contratos-conector.sqlCursoLiberado`: liberação da empresa OU benefício (licença ativa + contrato vigente + curso marcado em `beneficios`) OU direito próprio (`direitos_acesso` compra/manual, com validade). `direitos_acesso` também rastreia benefício/liberação (sincronizado por `services/acessos.js` a cada mudança e na rotina horária). `matriculas` guarda o histórico acadêmico e nunca é apagada.
- Fase 4 grava a compra com `acessos.conceder({ origem: 'compra', origemId: pedido })` e o estorno com `acessos.revogarDireito`.
- Certificado = concluir todos os cursos publicados marcados no benefício do perfil (antes: um curso por trilha). Em produção os 4 cursos já existiam, então a regra ficou igual.

## Homologação da loja (modo teste)

Decisões (2026-10-16): PIX, boleto e cartão (o comprador escolhe na página do Asaas); acesso configurável por oferta, padrão 12 meses; à vista (parcelamento a decidir). O dono quer homologar antes de cobrar/emitir de verdade.

Para homologar em produção sem cobrar nada:
1. No **sandbox** do Asaas (conta de testes): copiar a chave de API e criar um webhook apontando para `https://marshconsultoria.com.br/api/asaas/webhook` com um token próprio (eventos de cobrança).
2. No Render: `ASAAS_SANDBOX_API_KEY` = chave do sandbox e `ASAAS_SANDBOX_WEBHOOK_TOKEN` = token do webhook do sandbox.
3. Criar a oferta em **modo Teste**, abrir o link, comprar com dados fictícios (CPF válido) e pagar no sandbox (ou usar "Simular pagamento" no painel).
4. Para vender de verdade: editar a oferta e mudar para **Produção** (o sistema pede confirmação).

Pedido de teste não gera fatura; evento da conta de testes nunca mexe em pedido de produção (e vice-versa).

## Cenários de teste (seção 12 do documento)

- Fase 0: 16 (isolamento), 17 (webhook repetido), 18 (revogação durante acesso).
- Fases 1–2: 1–6 (inclui bloqueio da 101ª licença em concorrência).
- Fase 3: 10–15, 19.
- Fase 4: 7–9, 20.
