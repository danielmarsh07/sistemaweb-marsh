// Simulador de preço do Conector SAP Marsh — cálculo PURO (sem banco, sem rede).
// A rota /api/comercial/simulador-conector usa estas funções para o "ao vivo" e para gerar a proposta,
// assim a regra fica num lugar só. Os preços vêm da tabela editável (financeiro_config.prop_precos_conector)
// mesclada com PRECOS_PADRAO.
//
// Produto: Claude Code ligado ao SAP DEV/QAS do cliente, com skills por módulo, regras DEL/INS, controle de
// licenças/máquinas no portal e abertura de chamado para a fábrica ABAP da Marsh. A assinatura da IA (Claude)
// é do cliente e NÃO entra no preço.

const PRECOS_PADRAO = {
  // Licença por usuário (R$/mês). "anual" = valor mensal no plano anual
  leitura_mensal: 490, leitura_anual: 390,
  dev_mensal: 990, dev_anual: 790,
  // Pacote Empresa (R$/mês): até 5, até 10, e por usuário acima de 10
  empresa_ate5: 3500, empresa_ate10: 6000, empresa_excedente: 450,
  // O preço Empresa já é o do anual; no ciclo mensal pode ter acréscimo (%). 0 = mesmo preço
  empresa_acrescimo_mensal_pct: 0,
  // Implantação (único) por porte do legado Z, + por sistema SAP além do primeiro
  impl_pequeno: 8000, impl_medio: 15000, impl_grande: 25000, impl_sistema_adicional: 2000,
  // Chamados avulsos à fábrica ABAP (por chamado) e pacote de sustentação
  chamado_p: 1500, chamado_m: 4000, chamado_g: 9000,
  pacote_horas: 40, pacote_valor: 7500,
  // ROI: padrões das horas economizadas por mês e custo/hora
  roi_horas_funcional: 6, roi_custo_funcional: 150, roi_horas_abap: 10, roi_custo_abap: 160
};

const ROTULOS_PRECOS = {
  leitura_mensal: 'Leitura (funcional) — mensal', leitura_anual: 'Leitura (funcional) — anual, por mês',
  dev_mensal: 'Desenvolvimento (ABAP) — mensal', dev_anual: 'Desenvolvimento (ABAP) — anual, por mês',
  empresa_ate5: 'Empresa — até 5 usuários', empresa_ate10: 'Empresa — até 10 usuários',
  empresa_excedente: 'Empresa — por usuário acima de 10', empresa_acrescimo_mensal_pct: 'Empresa — acréscimo no ciclo mensal (%)',
  impl_pequeno: 'Implantação — legado Z pequeno', impl_medio: 'Implantação — legado Z médio',
  impl_grande: 'Implantação — legado Z grande', impl_sistema_adicional: 'Implantação — por sistema SAP adicional',
  chamado_p: 'Chamado avulso — porte P', chamado_m: 'Chamado avulso — porte M', chamado_g: 'Chamado avulso — porte G',
  pacote_horas: 'Pacote de sustentação — horas/mês', pacote_valor: 'Pacote de sustentação — valor/mês',
  roi_horas_funcional: 'ROI — horas economizadas/mês por funcional', roi_custo_funcional: 'ROI — custo/hora do funcional',
  roi_horas_abap: 'ROI — horas economizadas/mês por ABAP', roi_custo_abap: 'ROI — custo/hora do ABAP'
};

const PORTES = { pequeno: 'Pequeno', medio: 'Médio', grande: 'Grande', nenhum: 'Sem implantação' };
const MODALIDADES = { individual: 'Individual', empresa: 'Empresa', automatico: 'Automático (o mais barato)' };

const r2 = v => Math.round(v * 100) / 100;
const vazio = v => v === undefined || v === null || String(v).trim() === '';
const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = v => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

// Mescla a tabela salva com o padrão; valida quando vem do formulário (PUT). Devolve { precos } ou { erro }
function normalizarPrecos(entrada = {}, { validar = false } = {}) {
  const precos = { ...PRECOS_PADRAO };
  for (const k of Object.keys(PRECOS_PADRAO)) {
    if (vazio(entrada[k])) continue;
    const v = Number(entrada[k]);
    if (!Number.isFinite(v) || v < 0 || v > 10000000) {
      if (validar) return { erro: `Valor inválido em "${ROTULOS_PRECOS[k]}".` };
      continue;
    }
    if (k === 'empresa_acrescimo_mensal_pct' && v > 100) {
      if (validar) return { erro: 'Acréscimo do Empresa no mensal: 0 a 100%.' };
      continue;
    }
    if (k === 'pacote_horas' && v <= 0) {
      if (validar) return { erro: 'O pacote de sustentação precisa ter horas.' };
      continue;
    }
    precos[k] = v;
  }
  return { precos };
}

// Lê e valida as entradas do simulador. Devolve { entradas } ou { erro }
function validarEntradas(b = {}, precos = PRECOS_PADRAO) {
  const inteiro = (k, { min = 0, max = 100000, padrao = 0, nome }) => {
    if (vazio(b[k])) return padrao;
    const v = Number(b[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${nome}: número inteiro de ${min} a ${max}.`);
    return v;
  };
  const decimal = (k, { max = 1000000, padrao, nome }) => {
    if (vazio(b[k])) return padrao;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`${nome}: valor de 0 a ${num(max)}.`);
    return v;
  };
  const booleano = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  try {
    const e = {
      funcionais: inteiro('funcionais', { max: 1000, nome: 'Funcionais' }),
      abaps: inteiro('abaps', { max: 1000, nome: 'ABAPs' }),
      ciclo: vazio(b.ciclo) ? 'anual' : String(b.ciclo),
      modalidade: vazio(b.modalidade) ? 'automatico' : String(b.modalidade),
      sistemas: inteiro('sistemas', { min: 1, max: 50, padrao: 1, nome: 'Sistemas SAP' }),
      porte: vazio(b.porte) ? 'medio' : String(b.porte),
      chamados_p: inteiro('chamados_p', { max: 100, nome: 'Chamados P por mês' }),
      chamados_m: inteiro('chamados_m', { max: 100, nome: 'Chamados M por mês' }),
      chamados_g: inteiro('chamados_g', { max: 100, nome: 'Chamados G por mês' }),
      pacotes: inteiro('pacotes', { max: 50, nome: 'Pacotes de sustentação' }),
      desconto_pct: decimal('desconto_pct', { max: 100, padrao: 0, nome: 'Desconto (%)' }),
      desconto_meses: inteiro('desconto_meses', { max: 120, nome: 'Meses de desconto' }),
      desconto_implantacao: booleano(b.desconto_implantacao),
      validade_dias: inteiro('validade_dias', { min: 1, max: 180, padrao: 15, nome: 'Validade (dias)' }),
      roi_horas_funcional: decimal('roi_horas_funcional', { max: 744, padrao: precos.roi_horas_funcional, nome: 'Horas economizadas por funcional' }),
      roi_custo_funcional: decimal('roi_custo_funcional', { max: 100000, padrao: precos.roi_custo_funcional, nome: 'Custo/hora do funcional' }),
      roi_horas_abap: decimal('roi_horas_abap', { max: 744, padrao: precos.roi_horas_abap, nome: 'Horas economizadas por ABAP' }),
      roi_custo_abap: decimal('roi_custo_abap', { max: 100000, padrao: precos.roi_custo_abap, nome: 'Custo/hora do ABAP' })
    };
    if (!['mensal', 'anual'].includes(e.ciclo)) return { erro: 'Ciclo: mensal ou anual.' };
    if (!MODALIDADES[e.modalidade]) return { erro: 'Modalidade: individual, empresa ou automático.' };
    if (!PORTES[e.porte]) return { erro: 'Porte do legado Z: pequeno, médio, grande ou sem implantação.' };
    if (e.funcionais + e.abaps < 1) return { erro: 'Informe ao menos 1 usuário (funcional ou ABAP).' };
    if (e.pacotes > 0 && e.chamados_p + e.chamados_m + e.chamados_g > 0) {
      return { erro: 'Escolha chamados avulsos OU pacote de sustentação, não os dois.' };
    }
    if (e.desconto_pct > 0 && e.desconto_meses < 1) return { erro: 'Com desconto, informe por quantos meses ele vale (1 a 120).' };
    if (e.desconto_pct === 0) { e.desconto_meses = 0; e.desconto_implantacao = false; }
    return { entradas: e };
  } catch (err) {
    return { erro: err.message };
  }
}

// Preço mensal (cheio) de cada modalidade
function precoIndividual(e, p) {
  const leitura = e.ciclo === 'anual' ? p.leitura_anual : p.leitura_mensal;
  const dev = e.ciclo === 'anual' ? p.dev_anual : p.dev_mensal;
  return { leitura, dev, total: r2(e.funcionais * leitura + e.abaps * dev) };
}

function precoEmpresa(e, p) {
  const usuarios = e.funcionais + e.abaps;
  const fator = e.ciclo === 'mensal' ? 1 + p.empresa_acrescimo_mensal_pct / 100 : 1;
  const faixa = usuarios <= 5 ? 5 : 10;
  const base = r2((usuarios <= 5 ? p.empresa_ate5 : p.empresa_ate10) * fator);
  const excedentes = Math.max(0, usuarios - 10);
  const excedente = r2(p.empresa_excedente * fator);
  return { usuarios, faixa, base, excedentes, excedente, total: r2(base + excedentes * excedente) };
}

// Cálculo completo. Recebe entradas já validadas e a tabela de preços.
function calcular(e, p = PRECOS_PADRAO) {
  const ind = precoIndividual(e, p);
  const emp = precoEmpresa(e, p);
  // Automático: o menor; empate fica com Empresa (mesmo preço, com painel do gestor)
  const escolhida = e.modalidade === 'automatico' ? (ind.total < emp.total ? 'individual' : 'empresa') : e.modalidade;
  const pct = e.desconto_pct / 100;
  const comDesconto = v => r2(v * (1 - pct));
  const cicloTxt = e.ciclo === 'anual' ? 'ciclo anual' : 'ciclo mensal';
  const notaDesconto = e.desconto_pct > 0
    ? ` — ${num(e.desconto_pct)}% de desconto nos primeiros ${e.desconto_meses} ${e.desconto_meses === 1 ? 'mês' : 'meses'}` : '';

  // Itens no formato da proposta: { descricao, tipo: mensal|unico, quantidade, valor_unitario, total, grupo, valor_cheio }
  const itens = [];
  const add = (grupo, descricao, tipo, quantidade, cheio, desconto = false) => {
    if (!(quantidade > 0)) return;
    const unit = desconto ? comDesconto(cheio) : cheio;
    // Com desconto, a descrição mostra o preço cheio (é o valor depois do prazo do desconto)
    if (unit !== cheio) descricao += ` (preço cheio ${moeda(cheio)})`;
    itens.push({
      grupo, descricao, tipo, quantidade, valor_unitario: unit, total: r2(quantidade * unit),
      valor_cheio: cheio, total_cheio: r2(quantidade * cheio)
    });
  };
  const comDesc = e.desconto_pct > 0;

  if (escolhida === 'individual') {
    add('licenca', `Licença Conector SAP — plano Leitura (consultor funcional), ${cicloTxt}${notaDesconto}`, 'mensal', e.funcionais, ind.leitura, comDesc);
    add('licenca', `Licença Conector SAP — plano Desenvolvimento (ABAP), ${cicloTxt}${notaDesconto}`, 'mensal', e.abaps, ind.dev, comDesc);
  } else {
    const descUsuarios = `${emp.usuarios} usuário(s): ${e.funcionais} funcional(is) e ${e.abaps} ABAP(s)`;
    add('licenca', `Licença Conector SAP — plano Empresa, até ${emp.faixa} usuários (${descUsuarios}; vários sistemas e painel do gestor), ${cicloTxt}${notaDesconto}`,
      'mensal', 1, emp.base, comDesc);
    add('licenca', `Usuários adicionais ao plano Empresa (acima de 10)${notaDesconto}`, 'mensal', emp.excedentes, emp.excedente, comDesc);
  }

  if (e.porte !== 'nenhum') {
    const notaImpl = e.desconto_implantacao && comDesc ? ` — ${num(e.desconto_pct)}% de desconto` : '';
    add('implantacao', `Implantação — legado Z ${PORTES[e.porte].toLowerCase()} (inclui o 1º sistema SAP)${notaImpl}`, 'unico', 1,
      p[`impl_${e.porte}`], e.desconto_implantacao);
    add('implantacao', `Implantação — sistema SAP adicional${notaImpl}`, 'unico', e.sistemas - 1, p.impl_sistema_adicional, e.desconto_implantacao);
  }

  const estimativa = '(estimativa mensal; cobrado por chamado aprovado)';
  add('chamados', `Chamados à fábrica ABAP — porte P ${estimativa}`, 'mensal', e.chamados_p, p.chamado_p);
  add('chamados', `Chamados à fábrica ABAP — porte M ${estimativa}`, 'mensal', e.chamados_m, p.chamado_m);
  add('chamados', `Chamados à fábrica ABAP — porte G ${estimativa}`, 'mensal', e.chamados_g, p.chamado_g);
  add('sustentacao', `Pacote de sustentação ABAP — ${num(p.pacote_horas)} h/mês por pacote`, 'mensal', e.pacotes, p.pacote_valor);

  const soma = (filtro, campo) => r2(itens.filter(filtro).reduce((s, i) => s + i[campo], 0));
  const licencas_cheio = soma(i => i.grupo === 'licenca', 'total_cheio');
  const licencas_desconto = soma(i => i.grupo === 'licenca', 'total');
  const servicos_mensal = soma(i => i.tipo === 'mensal' && i.grupo !== 'licenca', 'total');
  const mensal_cheio = r2(licencas_cheio + servicos_mensal);
  const mensal_desconto = r2(licencas_desconto + servicos_mensal);
  const unico_cheio = soma(i => i.tipo === 'unico', 'total_cheio');
  const unico = soma(i => i.tipo === 'unico', 'total');
  const mesesDesc = Math.min(e.desconto_meses, 12);
  const primeiro_ano = r2(mensal_desconto * mesesDesc + mensal_cheio * (12 - mesesDesc) + unico);

  // ROI: economia estimada × custo mensal das licenças (preço cheio, conservador)
  const economia = r2(e.funcionais * e.roi_horas_funcional * e.roi_custo_funcional + e.abaps * e.roi_horas_abap * e.roi_custo_abap);
  let roi = null;
  if (economia > 0) {
    const ganho = r2(economia - licencas_cheio);
    const payback = unico > 0 && ganho > 0 ? Math.ceil(unico / ganho) : (unico === 0 && ganho > 0 ? 0 : null);
    roi = {
      economia_mensal: economia, custo_licencas_mensal: licencas_cheio, ganho_liquido_mensal: ganho,
      multiplo: licencas_cheio > 0 ? r2(economia / licencas_cheio) : null, payback_meses: payback
    };
    roi.resumo = textoRoi(e, roi, unico);
  }

  return {
    entradas: e,
    modalidade_escolhida: escolhida,
    comparacao: {
      individual: ind.total, empresa: emp.total, escolhida,
      mais_barata: ind.total < emp.total ? 'individual' : 'empresa',
      diferenca: r2(Math.abs(ind.total - emp.total)), usuarios: emp.usuarios
    },
    sustentacao: e.pacotes > 0
      ? { pacotes: e.pacotes, horas_por_pacote: p.pacote_horas, horas_total: e.pacotes * p.pacote_horas } : null,
    itens: itens.map(({ grupo, descricao, tipo, quantidade, valor_unitario, total, valor_cheio }) =>
      ({ grupo, descricao, tipo, quantidade, valor_unitario, total, valor_cheio })),
    totais: {
      licencas_cheio, licencas_desconto, servicos_mensal,
      mensal_cheio, mensal_desconto, unico_cheio, unico,
      primeiro_ano, meses_desconto_1o_ano: mesesDesc,
      // O que vai na proposta: o valor cobrado desde o 1º mês (com desconto, se houver)
      total_mensal: mensal_desconto, total_unico: unico
    },
    roi
  };
}

function textoRoi(e, roi, unico) {
  const partes = [];
  if (e.funcionais > 0 && e.roi_horas_funcional > 0) partes.push(`${e.funcionais} ${e.funcionais === 1 ? 'consultor funcional' : 'consultores funcionais'} economizando ${num(e.roi_horas_funcional)} h/mês cada (custo de ${moeda(e.roi_custo_funcional)}/h)`);
  if (e.abaps > 0 && e.roi_horas_abap > 0) partes.push(`${e.abaps} ${e.abaps === 1 ? 'desenvolvedor' : 'desenvolvedores'} ABAP economizando ${num(e.roi_horas_abap)} h/mês cada (custo de ${moeda(e.roi_custo_abap)}/h)`);
  let t = `Estimativa de retorno: com ${partes.join(' e ')}, a economia estimada é de ${moeda(roi.economia_mensal)}/mês, ` +
    `contra ${moeda(roi.custo_licencas_mensal)}/mês em licenças`;
  if (roi.multiplo) t += ` (${num(roi.multiplo)}× o investimento mensal)`;
  t += '.';
  if (roi.payback_meses === null) t += ' Com essas premissas, a economia não cobre o custo das licenças.';
  else if (unico > 0) t += ` A implantação se paga em cerca de ${roi.payback_meses} ${roi.payback_meses === 1 ? 'mês' : 'meses'}.`;
  return t + ' Valores estimados a partir das premissas informadas pelo cliente.';
}

// Textos padrão da proposta (introdução, escopo, condições). cfg = configProposta da empresa
function textosProposta(resultado, cfg = {}, { incluirRoi = true } = {}) {
  const e = resultado.entradas;
  const t = resultado.totais;
  const emp = resultado.modalidade_escolhida === 'empresa';

  const introducao = [
    cfg.prop_apresentacao,
    'O Conector SAP Marsh liga o Claude Code (assistente de IA da Anthropic) aos ambientes SAP de desenvolvimento e qualidade (DEV/QAS) da sua empresa. ' +
    'Consultores funcionais consultam programas, tabelas e configurações em linguagem natural; desenvolvedores ABAP analisam, ajustam e documentam objetos Z ' +
    'seguindo as regras da casa (código antigo comentado em bloco DEL, código novo em bloco INS). Tudo com skills por módulo (FI/CO, SD e fiscal, MM, integrações), ' +
    'controle de licenças e máquinas pelo portal Marsh e abertura de chamado para a fábrica ABAP da Marsh quando a demanda pede desenvolvimento.',
    incluirRoi && resultado.roi ? resultado.roi.resumo : null
  ].filter(Boolean).join('\n\n');

  const usuarios = [
    e.funcionais > 0 && `${e.funcionais} ${e.funcionais === 1 ? 'usuário' : 'usuários'} Leitura (consultor funcional)`,
    e.abaps > 0 && `${e.abaps} ${e.abaps === 1 ? 'usuário' : 'usuários'} Desenvolvimento (ABAP)`
  ].filter(Boolean).join(' e ');
  const escopo = [
    'O que está incluído',
    `• Licença do Conector SAP: ${emp ? `plano Empresa (${usuarios}, painel do gestor)` : usuarios}, ciclo ${e.ciclo}.`,
    `• Uso em ${e.sistemas === 1 ? '1 sistema SAP cadastrado' : `${e.sistemas} sistemas SAP cadastrados`} na licença (ambientes DEV/QAS).`,
    '• Skills por módulo, regras de alteração DEL/INS, Cérebro SAP do cliente e controle de licenças/máquinas no portal.',
    '• Abertura de chamado para a fábrica ABAP da Marsh direto do assistente.',
    ...(e.porte !== 'nenhum' ? [
      '',
      `Implantação (legado Z ${PORTES[e.porte].toLowerCase()})`,
      '• Cadastro dos sistemas SAP na licença e instalação nas máquinas dos usuários.',
      '• Orientação ao time de Basis: usuário técnico e autorização S_DEVELOP restrita a objetos Z*.',
      '• Treinamento dos consultores funcionais e dos desenvolvedores ABAP.',
      '• Cérebro inicial do cliente: documentação dos principais programas Z.'
    ] : []),
    ...(resultado.sustentacao ? ['', `Sustentação ABAP: ${resultado.sustentacao.pacotes} pacote(s) de ${num(resultado.sustentacao.horas_por_pacote)} h, ` +
      `total de ${num(resultado.sustentacao.horas_total)} h/mês para demandas aprovadas na fábrica ABAP da Marsh.`] : []),
    ...(e.chamados_p + e.chamados_m + e.chamados_g > 0 ? ['', 'Chamados à fábrica ABAP: os valores mensais de chamados são uma estimativa; cada chamado é cobrado pelo porte (P, M ou G) depois da demanda aprovada.'] : [])
  ].join('\n');

  const condicoesConector = [
    '• A assinatura e a chave da IA (Claude/Anthropic) são do cliente ou do consultor e não estão incluídas no preço.',
    '• O conector só funciona nos sistemas SAP cadastrados na licença e nunca em produção.',
    '• Licença por máquina: cada usuário ativa o conector no seu computador; troca de máquina libera a vaga pelo portal.',
    '• LGPD: os dados do SAP não saem do ambiente do cliente; apenas contadores de uso são enviados à Marsh.',
    '• Chamados à fábrica ABAP são cobrados por demanda aprovada, conforme o porte.',
    ...(e.desconto_pct > 0
      ? [`• Desconto de ${num(e.desconto_pct)}% nas licenças por ${e.desconto_meses} ${e.desconto_meses === 1 ? 'mês' : 'meses'}${e.desconto_implantacao ? ' (também aplicado à implantação)' : ''}. Depois disso, o total mensal passa a ${moeda(t.mensal_cheio)}.`]
      : []),
    `• Investimento estimado no 1º ano: ${moeda(t.primeiro_ano)}.`,
    '• Reajuste anual pelo IPCA.',
    ...(e.ciclo === 'anual' ? ['• Plano anual: vigência mínima de 12 meses.'] : [])
  ];
  // Condições de pagamento do modelo da proposta (sem repetir o reajuste)
  const pagamento = String(cfg.prop_condicoes_padrao || '').split('\n').filter(l => l.trim() && !/reajuste/i.test(l));
  const condicoes = [...condicoesConector, ...pagamento].join('\n');

  return { introducao, escopo, condicoes };
}

module.exports = { PRECOS_PADRAO, ROTULOS_PRECOS, PORTES, MODALIDADES, normalizarPrecos, validarEntradas, calcular, textosProposta };
