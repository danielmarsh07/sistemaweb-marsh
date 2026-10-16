# Plano: contratos num lugar só, preço por contrato, cursos para empresas e portal novo

Origem: revisão com `/revisar-fluxo` em 2026-10-16, depois da v4.3. O fluxo de negócio está certo; o que confunde
são as telas: três lugares com nomes diferentes para "contratar", preço especial que vaza pela tabela global e
nenhuma forma de liberar cursos pela ficha do cliente.

## Decisões do dono (2026-10-16)

| Tema | Decisão |
|---|---|
| Preço especial | **Por contrato.** A tabela Preços Conector SAP é o preço de lista; cada contrato guarda o preço negociado por perfil (vem da tabela, editável). Contrato novo do mesmo cliente sugere o preço do último. |
| Licenças a mais no meio da vigência | **Proporcional agora:** fatura avulsa pelos meses que faltam; a anuidade seguinte já vem com o total novo. Licença removida reduz a próxima anuidade (sem estorno). |
| Contrato de cursos | **Empresa inteira:** cursos escolhidos para todos da empresa, com validade e valor. R$ 0 = cortesia (sem fatura). |
| Pacote Empresa (até 5/10 usuários) | **Entra no contrato na fase 3**, igual à proposta. |

## Problemas encontrados (causa)

1. Três portas para contratar: Financeiro → Contratos, Produtos SAP → Contratos por vagas, Treinamentos → Liberar.
2. Tabela de preços única: mudar para um cliente muda a Loja do site, o simulador e as propostas de todos.
   `contratos_conector` não guarda preço; o contrato financeiro guarda só o total (`contratos.valor`).
3. Adicionar/remover licenças (`POST/DELETE /contratos-conector/:id/vagas`) não mexe na cobrança.
4. Liberação de curso para empresa (`cursos_liberacoes`) não tem validade usada, valor nem aparece como ação na ficha.
5. Proposta aceita cria contrato mensal genérico; não cria o contrato do Conector nem as licenças.

## Fase 1 — Um "+ Novo contrato" e preço por contrato

- Ficha do cliente e Financeiro → Contratos: um botão **+ Novo contrato** que pergunta o tipo:
  **Serviço** (formulário atual) · **Licenças do Conector** (tela própria) · **Cursos** (fase 2).
- Página Contratos lista todos os tipos (coluna Tipo); contrato do Conector abre com as licenças dentro.
  Menu "Contratos por vagas" sai do menu (a tela continua acessível pelo contrato).
- Ficha: caixa única **Contratos** com os três tipos; licenças do Conector mostradas dentro do contrato.
- Preço negociado por perfil guardado no contrato (`contratos.itens` com `valor_unitario` + preço de lista),
  tela mostra "lista R$ 790 → negociado R$ 650 (−18%)".
- Licenças a mais: fatura proporcional + valor anual atualizado; a menos: valor anual reduzido. Sempre com confirmação na tela.
- Tabela de preços com aviso: "é o preço de lista (Loja, simulador, propostas). Preço especial se dá no contrato."

## Fase 2 — Contrato de cursos para a empresa

- Tipo **Cursos** no + Novo contrato: cursos escolhidos, validade, valor (R$ 0 = cortesia).
- Grava a liberação da empresa com `data_fim` (vencido = sem acesso) e, se tiver valor, o contrato financeiro.
- Ficha do cliente mostra os cursos liberados com validade e origem (contrato, cortesia, licença do Conector, compra na Loja).
- Página Treinamentos → Liberar continua, mas passa a mostrar a validade e leva ao contrato.

## Fase 3 — Proposta vira contrato + pacote Empresa

- Proposta aceita do Conector gera o contrato do Conector com licenças e preços negociados (e a cobrança).
- Contrato do Conector pode ser por licença ou por pacote Empresa (preço fechado até 5/10 usuários + excedente).

## Fase 4 — Portal com a cara do sistema interno

- Mesmo visual do painel (menu lateral, cabeçalho, cartões, tabelas, cores e ícones), mantendo o padrão mobile aprovado.
- Áreas por papel: aluno (meus cursos), administrador da empresa (licenças, pessoas, cursos da empresa, faturas), chamados.

## Compra pelo site (como funciona hoje — mantido)

1. A pessoa preenche nome, e-mail e CPF/CNPJ na página da oferta (Loja).
2. O sistema acha ou cria o **cliente** pelo CPF/CNPJ e o **usuário do portal** pelo e-mail (papel aluno; no Conector, administrador da empresa).
3. Pago (Asaas): libera o curso com a validade da oferta, lança a receita no Financeiro e manda e-mail —
   quem é novo recebe o link para criar a senha; quem já tem conta recebe o aviso de curso liberado.
4. Tudo aparece em Comercial → Loja de cursos → Pedidos e na ficha do cliente.
Melhoria prevista (fase 2): a ficha mostrar "comprou pela Loja" com o pedido e a validade.

## Status

- [x] Fase 1 (v4.4) — o menu "Contratos por vagas" saiu; a lista de Contratos e a ficha mostram as licenças.
- [x] Fase 2 (v4.4) — contrato de cursos; liberação de contrato vale também para quem só usa licença.
- [ ] Fase 3
- [ ] Fase 4
