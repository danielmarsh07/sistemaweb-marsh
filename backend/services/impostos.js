// Impostos da empresa (Lucro Presumido) estimados pelas notas, para a Visão mensal.
// Base = valor bruto das notas pela COMPETÊNCIA (faturas não canceladas + contratos ativos ainda sem fatura).
//  - ISS próprio (o não retido pelo cliente), PIS e COFINS: pagos no mês seguinte à competência.
//  - IRPJ e CSLL: trimestrais, pagos no mês seguinte ao fim do trimestre (jan, abr, jul, out).
//  - O que o cliente retém na nota (IRRF, CSLL, PIS, COFINS) é antecipação: sai do valor a pagar.
//  - Reserva: a parte do IRPJ/CSLL do trimestre que cabe a cada nota, no mês em que ela é recebida.
// A guia lançada de verdade em contas a pagar (categorias ISS, PIS e COFINS, IRPJ e CSLL) substitui a estimativa do mês.
const { somarMeses, mesDe } = require('./contas-pagar');

// Lucro Presumido para serviços. Alíquotas em %; limite do adicional de IRPJ em R$ de lucro presumido por trimestre.
const PADRAO = { pis: 0.65, cofins: 3, presuncao: 32, irpj: 15, irpj_adicional: 10, limite_adicional: 60000, csll: 9 };
const CAMPOS = Object.keys(PADRAO);

const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = v => `${String(r2(v)).replace('.', ',')}%`;
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesBr = m => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(0, 4)}`;
const proximoMes = (m, n = 1) => mesDe(somarMeses(`${m}-01`, n));

function parametros(config) {
  const p = { ...PADRAO };
  for (const c of CAMPOS) if (config.impostos && config.impostos[c] !== undefined && config.impostos[c] !== null) p[c] = Number(config.impostos[c]);
  return p;
}

// Valida o que vem da tela de configuração. Retorna { erro } ou { impostos }
function validarParametros(b) {
  if (!b) return { impostos: null };
  const saida = {};
  for (const c of CAMPOS) {
    const v = Number(b[c] ?? PADRAO[c]);
    const max = c === 'limite_adicional' ? 10000000 : 100;
    if (!Number.isFinite(v) || v < 0 || v > max) return { erro: 'Alíquotas de impostos inválidas.' };
    saida[c] = v;
  }
  return { impostos: saida };
}

function trimestre(comp) {
  const [a, m] = comp.split('-').map(Number);
  const q = Math.floor((m - 1) / 3);
  const fim = `${a}-${String(q * 3 + 3).padStart(2, '0')}`;
  return { chave: `${q + 1}º tri/${a}`, inicio: `${a}-${String(q * 3 + 1).padStart(2, '0')}`, fim, pagamento: proximoMes(fim) };
}

// Competências que a visão precisa para os meses `lista` (de pagamento): a anterior de cada mês, com os trimestres inteiros
function competenciasNecessarias(lista, deslocamento) {
  return { de: trimestre(proximoMes(lista[0], -Math.max(1, deslocamento))).inicio, ate: trimestre(lista[lista.length - 1]).fim };
}

/**
 * notas: [{ comp, cliente, bruto, iss, reter_iss, ret_ir, ret_csll, ret_pis, ret_cofins, estimado }] (percentuais)
 * lancados: Set de `${mes}|iss`, `${mes}|pis_cofins`, `${mes}|irpj_csll` (guia já lançada em contas a pagar)
 * Retorna { linhas: [{ chave, descricao, celulas: { m: { valor, detalhe, estimado, lancado } } }], reserva: { m: { valor, detalhe } } }
 */
function calcular({ notas, lista, deslocamento, config, lancados = new Set() }) {
  const p = parametros(config);
  const vazio = () => Object.fromEntries(lista.map(m => [m, { valor: 0, detalhe: [], estimado: false, lancado: false }]));
  const linhas = {
    iss: { chave: 'iss', descricao: 'ISS (prefeitura)', celulas: vazio() },
    pis: { chave: 'pis', descricao: `PIS (${pct(p.pis)})`, celulas: vazio() },
    cofins: { chave: 'cofins', descricao: `COFINS (${pct(p.cofins)})`, celulas: vazio() },
    irpj: { chave: 'irpj', descricao: 'IRPJ (trimestral)', celulas: vazio() },
    csll: { chave: 'csll', descricao: 'CSLL (trimestral)', celulas: vazio() }
  };
  const reserva = Object.fromEntries(lista.map(m => [m, { valor: 0, detalhe: [] }]));
  const somar = (linha, mes, valor, texto, estimado) => {
    const cel = linhas[linha].celulas[mes];
    if (!cel || !(r2(valor) > 0)) return;
    cel.valor += valor; cel.detalhe.push(texto); if (estimado) cel.estimado = true;
  };

  // Mensais: ISS, PIS e COFINS de cada nota, no mês seguinte à competência
  for (const n of notas) {
    const pago = proximoMes(n.comp);
    const rotulo = `${n.cliente} · nota de ${mesBr(n.comp)} ${moeda(n.bruto)}${n.estimado ? ' (estimada, contrato sem fatura)' : ''}`;
    if (!n.reter_iss && n.iss > 0) somar('iss', pago, n.bruto * n.iss / 100, `${rotulo} × ${pct(n.iss)} = ${moeda(n.bruto * n.iss / 100)}`, n.estimado);
    for (const [t, ret] of [['pis', 'ret_pis'], ['cofins', 'ret_cofins']]) {
      const devido = n.bruto * p[t] / 100, retido = n.bruto * (n[ret] || 0) / 100;
      somar(t, pago, devido - retido, `${rotulo} × ${pct(p[t])} = ${moeda(devido)}${retido ? ` − retido ${moeda(retido)}` : ''}`, n.estimado);
    }
  }

  // Trimestrais: IRPJ (com adicional) e CSLL sobre o lucro presumido do trimestre
  const tris = new Map();
  for (const n of notas) {
    const t = trimestre(n.comp);
    if (!tris.has(t.chave)) tris.set(t.chave, { ...t, notas: [] });
    tris.get(t.chave).notas.push(n);
  }
  for (const t of tris.values()) {
    const base = t.notas.reduce((s, n) => s + n.bruto, 0);
    if (!(base > 0)) continue;
    const presumido = base * p.presuncao / 100;
    const adicional = Math.max(0, presumido - p.limite_adicional) * p.irpj_adicional / 100;
    const retIr = t.notas.reduce((s, n) => s + n.bruto * (n.ret_ir || 0) / 100, 0);
    const retCsll = t.notas.reduce((s, n) => s + n.bruto * (n.ret_csll || 0) / 100, 0);
    const irpj = Math.max(0, presumido * p.irpj / 100 + adicional - retIr);
    const csll = Math.max(0, presumido * p.csll / 100 - retCsll);
    const estimado = t.notas.some(n => n.estimado);
    const cab = `${t.chave}: notas ${moeda(base)} × ${pct(p.presuncao)} = lucro presumido ${moeda(presumido)}`;
    somar('irpj', t.pagamento, irpj, `${cab} × ${pct(p.irpj)} = ${moeda(presumido * p.irpj / 100)}${adicional ? ` + adicional ${moeda(adicional)}` : ''}${retIr ? ` − IRRF retido ${moeda(retIr)}` : ''}`, estimado);
    somar('csll', t.pagamento, csll, `${cab} × ${pct(p.csll)} = ${moeda(presumido * p.csll / 100)}${retCsll ? ` − CSLL retida ${moeda(retCsll)}` : ''}`, estimado);
    // Reserva: cada nota guarda a sua parte do trimestre no mês em que é recebida
    for (const n of t.notas) {
      const m = proximoMes(n.comp, deslocamento);
      if (!reserva[m]) continue;
      const parte = (irpj + csll) * n.bruto / base;
      reserva[m].valor += parte;
      reserva[m].detalhe.push(`${n.cliente} · nota de ${mesBr(n.comp)}: ${moeda(parte)} para o IRPJ/CSLL do ${t.chave} (paga em ${mesBr(t.pagamento)})`);
    }
  }

  // Guia já lançada em contas a pagar: a estimativa do mês sai (não conta em dobro)
  const grupo = { iss: 'iss', pis: 'pis_cofins', cofins: 'pis_cofins', irpj: 'irpj_csll', csll: 'irpj_csll' };
  for (const l of Object.values(linhas)) {
    for (const [m, c] of Object.entries(l.celulas)) {
      c.valor = r2(c.valor);
      if (lancados.has(`${m}|${grupo[l.chave]}`) && c.valor) {
        c.detalhe.unshift(`Guia já lançada nas contas a pagar: a estimativa de ${moeda(c.valor)} não entra no total.`);
        c.valor = 0; c.lancado = true;
      }
    }
  }
  for (const c of Object.values(reserva)) c.valor = r2(c.valor);
  return { linhas: Object.values(linhas), reserva, parametros: p };
}

// Nome da categoria de despesa → guia que ela representa
function grupoDaCategoria(nome) {
  const n = String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\biss\b/.test(n)) return 'iss';
  if (/pis|cofins/.test(n)) return 'pis_cofins';
  if (/irpj|csll/.test(n)) return 'irpj_csll';
  return null;
}

module.exports = { PADRAO, parametros, validarParametros, trimestre, competenciasNecessarias, calcular, grupoDaCategoria };
