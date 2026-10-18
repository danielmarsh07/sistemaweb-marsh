// ─────────────────────────────────────────────────────────────────────
// Histórico de versões do Sistema Marsh
// ─────────────────────────────────────────────────────────────────────
//
// TODA atualização publicada (commit enviado ao GitHub → deploy no Render) DEVE
// adicionar uma nova entrada no TOPO deste array, no mesmo commit. A versão que
// aparece no menu, no login, em /api/saude e na página Sistema → Versões vem
// daqui: este é o único lugar para mexer. O teste testes/versoes.js confere as regras.
//
// Linguagem dos destaques: de usuário. O que MUDOU para quem usa, não como foi feito
// (evite rota, tabela, endpoint, refactor...).
//
// REGRA DE NUMERAÇÃO: o número depois do ponto vai de .0 a .9. NUNCA .10 ou mais:
// depois de v2.9 vem v3.0. Assim a ordem nunca fica ambígua (v2.10 < v2.2 como texto).
// Mudança grande (módulo novo, visual novo) pode pular para o próximo número inteiro.
//
// REGRA DE DATA: `data` é a data da publicação NO HORÁRIO DE BRASÍLIA. Entre 21h e
// 23h59 em Brasília o UTC já virou o dia seguinte; confira com
//   new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })
//
// Este arquivo roda no navegador (window.MARSH_CHANGELOG) e no servidor (require).

(function (raiz) {
  const CHANGELOG = [
    { versao: 'v4.9', data: '2026-10-18', destaques: [
      'Visão mensal mostra os impostos de cada mês, calculados sozinhos pelas notas emitidas: ISS, PIS e COFINS no mês seguinte à nota; IRPJ e CSLL no mês seguinte ao fim do trimestre',
      'Nova linha "Guardar para o IRPJ/CSLL trimestral": quanto separar a cada mês para os impostos do trimestre',
      'Clique no valor do imposto para ver o cálculo, nota por nota; ao lançar a guia em Contas a pagar, a estimativa daquele mês sai do total',
      'Alíquotas do Lucro Presumido editáveis em Configuração do faturamento'
    ] },
    { versao: 'v4.8', data: '2026-10-18', destaques: [
      'Botão "Excluir" na tela da conta a pagar: dá para excluir direto da Visão mensal, sem ir em Contas a pagar',
      'Na Visão mensal, lançar um mês vazio de uma série ou assinatura (o "+") fica na mesma linha, sem abrir outra com o mesmo nome',
      'Exclusões de contas a pagar passam a ficar registradas no histórico de auditoria (quem excluiu, quando e o quê)'
    ] },
    { versao: 'v4.7', data: '2026-10-16', destaques: [
      'Site: página nova dos Conectores, com ECC, S/4HANA, Fiori e BTP, a situação de cada um, os perfis (ABAP/Fiori, Funcional, Apps Fiori e Basis) e o roteiro',
      'Página inicial do site com o link para os Conectores no menu e no cartão do Conector SAP'
    ] },
    { versao: 'v4.6', data: '2026-10-16', destaques: [
      'Portal do cliente com a cara do sistema: menu lateral, cabeçalho, mesmos cartões, cores e temas (claro e escuro)',
      'Cada assunto numa tela própria: Início, Chamados, Treinamentos, Minha licença, Licenças da empresa, Conector SAP, Financeiro e Meus pedidos. Só aparece o que a pessoa tem',
      'Início com os números dos chamados e atalhos para cada área',
      'No celular: barra de baixo com os atalhos principais e o Menu com todas as telas, igual ao sistema; o voltar do celular volta para a tela anterior',
      'Corrigido: o botão "Material de apoio" aparecia em aulas sem material'
    ] },
    { versao: 'v4.5', data: '2026-10-16', destaques: [
      'Proposta aceita vira contrato do Conector: em "Gerar contrato", a proposta feita pelo simulador já traz as licenças por perfil, o preço, o gestor e a cobrança; é só conferir e gerar',
      'Contrato do Conector por pacote Empresa: preço fechado até 5 ou até 10 usuários e um valor por usuário acima de 10, igual à proposta',
      'Cobrança das licenças anual ou mensal: no mensal, licenças a mais entram na próxima fatura; no anual, sai a fatura proporcional',
      'No pacote Empresa, ao passar de faixa (ex.: de 5 para 6 usuários) a conta mostra a diferença e a fatura proporcional'
    ] },
    { versao: 'v4.4', data: '2026-10-16', destaques: [
      'Um botão só para contratar: "+ Novo contrato" (na ficha do cliente e em Contratos) pergunta o tipo (Serviço, Licenças do Conector ou Cursos) e abre o formulário certo',
      'Preço especial por cliente sem mexer na tabela: cada contrato de licenças guarda o seu preço por perfil, com o preço de lista e o desconto ao lado. O próximo contrato do mesmo cliente já vem com esse preço',
      'Licenças a mais no meio do contrato geram a fatura proporcional aos meses que faltam e atualizam a anuidade; licenças a menos reduzem a próxima anuidade. A conta aparece antes de confirmar',
      'Novo contrato de Cursos para a empresa: escolha os cursos e a validade; cortesia (gratuito), pagamento único, mensal ou anual. Vale para todas as pessoas da empresa no portal',
      'Ficha do cliente: todos os contratos numa caixa só (licenças do Conector dentro do contrato), botão "+ Liberar cursos para a empresa" e a origem de cada curso',
      'Visão mensal: contrato anual aparece só no mês em que é cobrado (antes era estimado todo mês)'
    ] },
    { versao: 'v4.3', data: '2026-10-16', destaques: [
      'Contratos mais claros: os botões agora dizem "+ Contrato de serviço" e "+ Licenças do Conector (com cobrança)", na ficha do cliente e em Contratos',
      'Licenças do Conector se criam num lugar só: o formulário define as licenças e já monta a cobrança anual. Escolher "Produto" no contrato de serviço leva direto para lá',
      'No contrato do Conector, cada perfil (ABAP, Funcional, ABAP + Funcional) mostra o preço da tabela e quanto soma no ano enquanto você escolhe as quantidades; no fim aparece o total explicado'
    ] },
    { versao: 'v4.2', data: '2026-10-16', destaques: [
      'Venda das licenças do Conector pelo site: na Loja, crie uma oferta "Licenças do Conector SAP" e divulgue o link',
      'O comprador escolhe quantas licenças de cada perfil (ABAP, Funcional, ABAP + Funcional) e vê o total na hora, com o preço da tabela Preços Conector SAP',
      'Pago: nasce o contrato do Conector por 12 meses, quem comprou vira administrador da empresa no portal (e pode usar uma licença) e recebe o acesso por e-mail',
      'Em produção a cobrança anual entra no Financeiro já com a 1ª anuidade paga e renovação automática; estorno cancela as licenças',
      'Tabela de preços ganhou o preço próprio do perfil ABAP + Funcional (começa igual ao de Desenvolvimento)'
    ] },
    { versao: 'v4.1', data: '2026-10-16', destaques: [
      'Fatura vencida gera um alerta para você no dia seguinte (além do lembrete ao cliente)',
      'Licenças do Conector com 30 dias de atraso (ajustável em Configuração) ficam suspensas sozinhas, com os cursos inclusos; pagou, voltam na hora',
      'O motivo da suspensão aparece na ficha do cliente e no portal da empresa',
      'Contrato com "Renovar automaticamente": no fim da vigência ganha mais 12 meses (o contrato do Conector acompanha); sem a opção, é encerrado',
      'Avisos 30, 7 e 1 dia antes do fim da vigência, para você e, nas licenças do Conector, para os administradores da empresa',
      'Todo e-mail que o sistema envia fica registrado (para quem, assunto e se saiu)',
      'Roteiro de uso reescrito com o fluxo novo: cliente, contratos, licenças por convite, cursos, loja, faturamento, atraso e renovação'
    ] },
    { versao: 'v4.0', data: '2026-10-16', destaques: [
      'Nova Loja de cursos (Comercial → Loja de cursos): ofertas com página própria para divulgar (WhatsApp, anúncio, site), preço promocional com prazo, período de venda e duração do acesso (padrão 12 meses)',
      'A pessoa se cadastra com nome, e-mail e CPF/CNPJ e paga com PIX, boleto ou cartão no Asaas; confirmado o pagamento, o curso é liberado na hora e ela recebe o acesso por e-mail',
      'Modo teste (homologação): a oferta usa o ambiente de testes do Asaas, nada é cobrado, não gera fatura, e o botão "Simular pagamento" libera o curso para conferir o fluxo inteiro',
      'Cupons de desconto (percentual ou em reais), por oferta ou geral, com validade e limite de usos',
      'Estorno ou contestação tiram o curso comprado (o progresso fica); pedido não pago expira sozinho e devolve o cupom; clique duplo não cria dois pedidos',
      'Quem já tem conta (inclusive de uma empresa) compra com a mesma conta; o portal mostra "Meus pedidos"',
      'Venda em produção paga vira receita no Financeiro (fatura paga, sem nota automática)',
      'Corrigido: a ficha do cliente não rola mais para o lado e os textos não saem das caixas'
    ] },
    { versao: 'v3.9', data: '2026-10-16', destaques: [
      'Ficha do cliente virou o painel de controle da empresa: contratos, faturas, licenças do Conector, administradores, usuários, cursos e atividade recente num lugar só',
      'Clique num contrato, contrato do Conector ou usuário dentro da ficha para abrir e editar; ao salvar ou fechar, a ficha volta sozinha já atualizada',
      'Botões na ficha: "+ Novo contrato", "+ Contrato de licenças" e "+ Administrador", já com o cliente escolhido',
      'Ficha mostra o valor recorrente por mês e o anual das licenças, o tipo e a cobrança de cada contrato, convites pendentes e quem ainda não criou a senha',
      'Usuários aparecem com o papel: administrador da empresa, licença ABAP/Funcional (ou convite) e acesso amplo',
      'Cursos da empresa com quantas pessoas têm cada um e por qual caminho (licença, empresa ou individual)'
    ] },
    { versao: 'v3.8', data: '2026-10-16', destaques: [
      'Nova página Cadastros → Benefícios do Conector: escolha quais cursos gratuitos vêm com cada licença (ABAP, Funcional, ABAP + Funcional); já vem com a regra atual',
      'Curso gratuito vale só enquanto a licença estiver ativa: revogada, suspensa ou com o contrato vencido, o curso sai na hora; renovou, volta — com o progresso de onde parou',
      'O sistema registra por que cada pessoa tem cada curso (licença do Conector, compra, empresa ou liberação individual), até quando e por que acabou',
      'Quem tem o mesmo curso por dois caminhos (ex.: licença e compra) não perde o curso quando um deles acaba',
      'Portal: cada curso mostra de onde vem o acesso ("Incluso na licença do Conector", "Liberado pela empresa", "Seu até...")',
      'Painel: o progresso do curso mostra também quem já perdeu o acesso (o histórico fica), a origem de cada acesso e o botão "Liberar para uma pessoa"',
      'O certificado do Conector passa a seguir os cursos marcados no benefício do perfil'
    ] },
    { versao: 'v3.7', data: '2026-10-16', destaques: [
      'Portal: nova área "Licenças do Conector SAP da empresa" com o resumo de cada contrato (contratadas, em uso, convites pendentes e disponíveis)',
      'Convidar pessoa escolhendo só o tipo de licença: o sistema reserva a próxima disponível e nunca passa do total contratado, mesmo com vários convites ao mesmo tempo',
      'Convite pendente reserva a licença até a pessoa criar a senha; dá para reenviar ou cancelar, e o convite que expira sem aceite libera a licença sozinho',
      'A empresa pode ter vários administradores no portal (nunca fica sem nenhum); ser administrador não ocupa licença',
      'Revogar a licença tira o Conector e os cursos dela na hora, mas a pessoa continua com a conta, o progresso e o certificado',
      'Histórico das licenças de cada contrato: convites, aceites, revogações e expirações, com quem fez e quando (no portal e no painel)',
      'Painel: administradores da empresa do cliente direto no contrato do Conector'
    ] },
    { versao: 'v3.6', data: '2026-10-16', destaques: [
      'Contratos agora têm tipo (serviço ou produto) e cobrança mensal ou anual: o contrato anual gera uma fatura por ano, no mês escolhido, com o período coberto na descrição',
      'As faturas do mês são geradas como rascunho automaticamente (a partir do dia escolhido em Configuração) e você recebe um e-mail para revisar; aprovada, a nota fiscal e o e-mail ao cliente seguem sozinhos',
      'Fatura cancelada de propósito não é recriada pela geração automática',
      'Cada contrato tem histórico: quem mudou o quê e quando (valor, vencimento, vigência, status…)',
      'Botão "Aplicar reajuste" no contrato (percentual ou novo valor) e aviso de "reajuste pendente" no mês do índice',
      'Contrato do Conector pode nascer com a cobrança anual no Financeiro, com o valor sugerido pela tabela de Preços Conector SAP; contratos antigos ganham o botão "Criar cobrança anual"',
      'Gerar contrato a partir da oportunidade copia os itens da proposta aceita, e o valor único vira uma fatura avulsa em rascunho',
      'Aprovar a mesma fatura duas vezes seguidas não emite nota nem envia e-mail em dobro'
    ] },
    { versao: 'v3.5', data: '2026-10-16', destaques: [
      'Usuário desativado, com senha redefinida ou que mudou de empresa sai do sistema na hora (antes podia continuar logado por até 8 horas)',
      'Corrigido: usuário do portal sem empresa vinculada não vê mais chamados de outros clientes',
      'Corrigido: reativar um usuário do portal não apaga mais a empresa dele',
      'A mesma pessoa não ocupa duas vagas do mesmo contrato do Conector, mesmo com cliques simultâneos',
      'Gerar contrato da oportunidade com dois cliques não cria mais dois contratos',
      'Cliente com o mesmo CPF/CNPJ é recusado mesmo digitado com ou sem pontuação',
      'Notas fiscais e pagamentos do Asaas: aviso repetido não é processado de novo, a nota não é emitida em dobro após uma falha de conexão e o cliente recebe a fatura por e-mail uma vez só',
      'Mudanças em usuários e nas vagas do Conector ficam registradas (quem fez, quando, antes e depois)'
    ] },
    {
      versao: 'v3.4',
      data: '2026-10-16',
      destaques: [
        'Quem conclui os cursos do perfil ganha na hora o certificado, com código que qualquer pessoa pode conferir no site',
        'Junto com o certificado sai a licença do Conector só da pessoa (1 computador), com a chave visível no portal dela',
        'O instalador baixado pelo portal já vem com a chave: na instalação a pessoa só informa usuário e senha do SAP',
        'Gestor e Marsh acompanham certificado e licença de cada vaga',
      ],
    },
    {
      versao: 'v3.3',
      data: '2026-10-15',
      destaques: [
        'Novo: contratos do Conector SAP por vagas (Produtos SAP → Contratos por vagas), com vagas ABAP, Funcional ou Ambos',
        'O gestor do contrato passa cada vaga para uma pessoa pelo portal, acompanha o progresso e cadastra os sistemas SAP',
        'Quem ocupa uma vaga vê no portal só os cursos do seu perfil',
        'Cursos ganharam o campo Trilha, que define quais vagas veem cada curso',
      ],
    },
    {
      versao: 'v3.2',
      data: '2026-10-15',
      destaques: [
        'Nova página Cadastros → Preços Conector SAP: a tabela de preços do simulador agora também pode ser aberta e editada pelo menu',
      ],
    },
    {
      versao: 'v3.1',
      data: '2026-10-15',
      destaques: [
        'Removida a voz robótica da Ivy: ela fala sempre com a voz natural',
      ],
    },
    {
      versao: 'v3.0',
      data: '2026-10-14',
      destaques: [
        'Cursos com videoaulas: IA no Desenvolvimento ABAP (12 aulas), IA para Consultores Funcionais (10), Portal do Cliente (6) e Conector SAP (6) cadastrados com duração e descrição de cada aula.',
        'Na lista de aulas do curso: resumo de quantas aulas têm vídeo, numeração a partir de 1 (igual aos arquivos de vídeo), aulas sem vídeo destacadas e lista mais alta, com aviso para rolar.',
      ],
    },
    {
      versao: 'v2.9',
      data: '2026-10-14',
      destaques: [
        'A Ivy agora executa ações por voz no comercial: cria oportunidades (de cliente ou prospect), muda a etapa no funil (inclusive marcar como perdida, com o motivo) e anota no histórico.',
        'Também agenda, reagenda e cancela posts do Instagram que já estão no calendário, sempre no horário de Brasília.',
        'Toda ação por voz mostra um resumo e só grava depois que você confirma.',
        'A Ivy responde sobre os cursos: quantas aulas cada um tem, quais ainda estão sem vídeo e o progresso de cada aluno.',
      ],
    },
    {
      versao: 'v2.8',
      data: '2026-10-14',
      destaques: [
        'No celular, a barra de baixo agora tem 5 botões fixos (Início, Chamados, Clientes, Faturas e Menu) que cabem na tela inteira, sem precisar arrastar para o lado.',
        'O botão Menu abre uma gaveta com todas as telas do sistema, agrupadas como no computador — inclusive Marketing, DRE, Fluxo de caixa, Alertas e Versões, que antes não tinham acesso pelo celular.',
        'O gesto de voltar do iPhone (arrastar da borda) e o voltar do Android agora voltam para a tela anterior do sistema, em vez de sair do aplicativo.',
        'A barra de baixo e o topo respeitam a área da barrinha de gestos e do recorte da tela do iPhone, sem cortar os botões.',
      ],
    },
    {
      versao: 'v2.7',
      data: '2026-10-14',
      destaques: [
        'Nova página Sistema → Versões com o histórico de todas as atualizações do sistema; o número da versão atual aparece no rodapé do menu e na tela de login.',
        'A Ivy passou a ser de uso exclusivo do super usuário (o dono do sistema). Administradores, técnicos e clientes não veem mais o botão, e ela saiu do portal do cliente.',
        'A Ivy responde qualquer pergunta sobre o sistema: mostra a estrutura do banco de dados, faz consultas livres (só leitura, com senhas e tokens ocultos) e explica como cada módulo funciona a partir da documentação.',
      ],
    },
    {
      versao: 'v2.6',
      data: '2026-10-14',
      destaques: [
        'O assistente de voz agora se chama Ivy: novo visual em tela cheia com o robô da Marsh, que pisca, segue o mouse e mexe a boca enquanto fala.',
        'Voz feminina e natural (o efeito robótico ficou opcional, num botão no topo da Ivy).',
        'A Ivy passou a responder sobre o comercial (funil, propostas e preço do Conector), contratos, DRE, projeção de caixa, Instagram, alertas e licenças, com os mesmos números das telas.',
        'Ela também lista os chamados abertos pelo Conector SAP e os que aguardam aprovação do cliente.',
      ],
    },
    {
      versao: 'v2.5',
      data: '2026-10-13',
      destaques: [
        'Novo site institucional "SAP + IA" com a mesma identidade visual da tela de login.',
        'Novo menu Marketing: calendário de posts do Instagram com prévia do feed e do carrossel, agendamento e publicação automática no horário marcado.',
        'Importação de uma agenda inteira de posts (arquivo de agenda + imagens) e páginas de métricas (seguidores, alcance e interações) e de conexão da conta do Instagram.',
      ],
    },
    {
      versao: 'v2.4',
      data: '2026-10-13',
      destaques: [
        'Licenças do Conector SAP com ativação por máquina, conexões com os sistemas SAP do cliente e download do instalador; o instalador novo é publicado pelo próprio painel.',
        'Simulador de preço do Conector SAP no Comercial, com tabela de preços editável e geração da proposta em PDF.',
        'Chamados abertos direto pelo Conector SAP, com aprovação do gestor do cliente antes de entrar na fila da fábrica.',
      ],
    },
    {
      versao: 'v2.3',
      data: '2026-10-12',
      destaques: [
        'O assistente de voz passou a lançar e consultar despesas, contas, faturas e saldo do financeiro novo (só administradores).',
        'Listagens com ordenação por coluna e filtros.',
        'Visão geral e visão mensal com blocos que recolhem e expandem.',
        'Usuário novo recebe e-mail de boas-vindas; aparece um alerta quando o envio de e-mails está desligado.',
      ],
    },
    {
      versao: 'v2.2',
      data: '2026-10-10',
      destaques: [
        'Controle mensal do financeiro: visão mês a mês, cartões de crédito, assinaturas e separação entre gastos pessoais e da empresa.',
        'Menu Cadastros reorganizado e ficha 360 do cliente (contratos, faturas, chamados e licenças num lugar só).',
        'Alertas de falha do sistema (Sistema → Alertas) e convite/recuperação de senha por e-mail.',
        'A NFS-e recusada mostra o motivo; exclusão definitiva de usuários; mais segurança no portal do cliente.',
        'Itens do menu lateral em ordem alfabética.',
      ],
    },
    {
      versao: 'v2.1',
      data: '2026-10-10',
      destaques: [
        'Financeiro completo: contas a pagar (com recorrência), fluxo de caixa realizado e previsto e DRE gerencial.',
        'Novo módulo Comercial: funil de vendas e propostas com link para o cliente aceitar online.',
        'Relatórios, receita recorrente (MRR) e cobrança por PIX pelo Asaas.',
        'Página Sistema → Roteiro de uso explicando a jornada do cliente no sistema.',
      ],
    },
    {
      versao: 'v2.0',
      data: '2026-10-09',
      destaques: [
        'Visual novo "Marsh Sereno": logo novo, menu azul-céu recolhível e nova tela de login.',
        'Faturamento mensal dos contratos com emissão de NFS-e pelo Asaas.',
        'Novos módulos de Licenças do Conector SAP e Treinamentos.',
      ],
    },
    {
      versao: 'v1.6',
      data: '2026-05-22',
      destaques: [
        'Modo HUD em tela cheia no assistente de voz, que passou a se apresentar como JARVIS.',
        'Chamados abertos e atendimentos registrados por voz também disparam os e-mails de aviso.',
      ],
    },
    {
      versao: 'v1.5',
      data: '2026-05-21',
      destaques: [
        'Assistente de voz: lança transações, cadastra clientes e fornecedores e abre chamados falando.',
        'Visual animado do assistente (holograma e nebulosa em tela cheia) que reage à voz.',
        'Clientes podem abrir chamados de telemedicina por voz no portal.',
        'Tecnologias contratadas no cadastro do cliente, com formulário de chamado adequado a cada uma.',
      ],
    },
    {
      versao: 'v1.4',
      data: '2026-05-14',
      destaques: [
        'Categorias de transação, cartões de saldo em caixa e filtro por mês e ano.',
        'Repetir um lançamento em várias datas de uma vez.',
      ],
    },
    {
      versao: 'v1.3',
      data: '2026-05-13',
      destaques: [
        'No celular, as tabelas viram cartões e todas as ações ficam acessíveis.',
        'Novo visual escuro, filtros e totalizador no financeiro, carregamento mais rápido.',
        'Configurações com 3 temas (escuro, claro e enterprise) salvos por usuário.',
      ],
    },
    {
      versao: 'v1.2',
      data: '2026-04-29',
      destaques: [
        'Cadastros completos com validação de CPF e CNPJ e registro de quem criou e editou cada item.',
        'Chamados com SLA, pesquisa de satisfação, reabertura, busca, paginação e aviso de não lido.',
        'Anexos nos chamados, já na abertura, com pré-visualização de imagens.',
        'Reforço de segurança no portal do cliente.',
      ],
    },
    {
      versao: 'v1.1',
      data: '2026-04-08',
      destaques: [
        'Várias empresas no mesmo sistema, portal do cliente e gestão de usuários.',
        'Avisos por e-mail.',
        'Site atualizado com CPI, IA e agentes e apps integradas ao SAP.',
      ],
    },
    {
      versao: 'v1.0',
      data: '2026-03-27',
      destaques: [
        'Primeira versão do Sistema Marsh: painel com clientes, fornecedores, chamados e financeiro, com login.',
        'Site institucional com acesso ao sistema.',
        'Instalável como aplicativo no celular e com layout adaptado para telas pequenas.',
      ],
    },
  ];

  const api = { CHANGELOG, VERSAO_ATUAL: CHANGELOG[0].versao };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { raiz.MARSH_CHANGELOG = CHANGELOG; raiz.MARSH_VERSAO = api.VERSAO_ATUAL; }
})(typeof window !== 'undefined' ? window : globalThis);
