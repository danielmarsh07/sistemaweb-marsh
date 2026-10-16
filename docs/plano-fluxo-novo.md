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
| 3. Direitos de acesso e benefícios | v4.0 | Matrículas + direitos de acesso com origem; cadastro de benefícios; migração das regras atuais; "Meus cursos" com origem | |
| 4. Venda de cursos e Conector | v4.1–4.2 | Ofertas, cupons, pedidos, checkout Asaas, webhook → matrícula; pendente/recusado/estorno/contestação | |
| 5. Automações | v4.3 | Renovação (avisos 30/7/1), inadimplência (alerta + suspensão em 30 dias), relatórios, log de e-mails; **Roteiro de uso atualizado** | |

## Notas de implementação

- Preço sugerido da cobrança do Conector: plano anual da tabela × 12 por vaga. **Perfil Ambos usa o preço de Desenvolvimento** até a tabela ganhar um preço próprio (pendência da venda online).
- Contrato anual que vence no próprio mês de cobrança não gera nova anuidade: isso é renovação (fase 5).
- Histórico de contratos usa a tabela `auditoria` (entidade `contrato`); começa na v3.6.
- Administrador corporativo = tabela `clientes_admins` (o "gestor" do portal). `contratos_conector.gestor_usuario_id` fica só como o comprador/contato.
- Estado da licença (`contratos_conector_vagas.estado`): livre → convidada → ativa. Cursos e licença só valem com `ativa`. O convite expira quando não há link válido (72 h; reenviar renova) — a rotina horária libera a licença.
- Histórico das licenças = `auditoria` (entidade `vaga_conector`), sem tabela nova.

## Cenários de teste (seção 12 do documento)

- Fase 0: 16 (isolamento), 17 (webhook repetido), 18 (revogação durante acesso).
- Fases 1–2: 1–6 (inclui bloqueio da 101ª licença em concorrência).
- Fase 3: 10–15, 19.
- Fase 4: 7–9, 20.
