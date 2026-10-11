require('./_ambiente-local');
// Controle mensal (substitui a planilha): contas/cartões, parcelada a partir da parcela X, assinatura recorrente,
// fatura do cartão, natureza pessoal fora da DRE e a Visão mensal.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { estenderRecorrentes } = require('../backend/services/financeiro-jobs');
const BASE = 'http://localhost:3000/api/financeiro';

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) console.log('  !', m, p, r.status, j.erro || j);
    return { status: r.status, ...j };
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const hoje = new Date();
  const mes = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const m0 = mes(hoje), m1 = mes(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1)), m2 = mes(new Date(hoje.getFullYear(), hoje.getMonth() + 2, 1));
  const contas = sql => pool.query(`SELECT * FROM contas_pagar WHERE descricao LIKE 'TESTE %' ${sql || ''} ORDER BY data_vencimento, id`);

  const cats = (await (await fetch(BASE + '/categorias-despesa', { headers: { Authorization: `Bearer ${token}` } })).json());
  const cat = n => (cats.find(c => c.nome === n) || {}).id;
  ok(cat('Parcelamentos de impostos') && cat('Compras pessoais'), 'categorias novas (parcelamentos, pessoais) criadas');

  // Contas e cartões
  const cartao = await api('POST', '/contas-financeiras', { nome: 'TESTE Cartão', tipo: 'cartao', dia_vencimento: 31, dia_fechamento: 24 });
  const conta = await api('POST', '/contas-financeiras', { nome: 'TESTE Conta', tipo: 'conta' });
  ok(cartao.id && conta.id, 'cartão e conta cadastrados');
  const semDia = await api('POST', '/contas-financeiras', { nome: 'TESTE Sem dia', tipo: 'cartao' });
  ok(semDia.status === 400, 'cartão sem dia de vencimento recusado');

  // Parcelamento em andamento: parcela 4 de 6 → cria 4, 5, 6
  const p = await api('POST', '/contas-pagar', { descricao: 'TESTE Parcelamento ISS', categoria_id: cat('Parcelamentos de impostos'),
    valor: 500, competencia: m0, data_vencimento: `${m0}-20`, conta_financeira_id: conta.id, tipo: 'parcelada', parcela_inicial: 4, total_parcelas: 6 });
  const par = (await contas(`AND descricao = 'TESTE Parcelamento ISS'`)).rows;
  ok(par.length === 3 && par.map(x => x.parcela).join() === '4,5,6' && par.every(x => x.total_parcelas === 6), `parcelada 4..6 de 6 (${p.mensagem})`);

  // Cartão: vencimento = dia 31 da fatura, limitado ao fim do mês (fev → 28/29)
  await api('POST', '/contas-pagar', { descricao: 'TESTE Monitor', categoria_id: cat('Outras despesas'), valor: 279,
    competencia: m0, mes_fatura: m0, conta_financeira_id: cartao.id, tipo: 'parcelada', parcela_inicial: 1, total_parcelas: 3 });
  const mon = (await contas(`AND descricao = 'TESTE Monitor'`)).rows;
  const ultimoDia = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const esperado = [0, 1, 2].map(i => { const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1); return `${mes(d)}-${String(ultimoDia(d)).padStart(2, '0')}`; });
  const venc = mon.map(x => x.data_vencimento.toISOString().slice(0, 10));
  ok(JSON.stringify(venc) === JSON.stringify(esperado), `cartão: vence no dia da fatura (fim do mês) ${venc.join(', ')}`);

  // Assinatura pessoal recorrente no cartão: 12 meses
  await api('POST', '/contas-pagar', { descricao: 'TESTE Streaming', categoria_id: cat('Lazer e assinaturas pessoais'), valor: 46.82,
    competencia: m0, mes_fatura: m0, conta_financeira_id: cartao.id, tipo: 'recorrente', natureza: 'pessoal' });
  let rec = (await contas(`AND descricao = 'TESTE Streaming'`)).rows;
  ok(rec.length === 12 && rec.every(x => x.recorrente && x.natureza === 'pessoal'), 'assinatura: 12 meses, pessoal, recorrente');

  // A rotina recompõe os 12 meses se faltarem
  await pool.query(`DELETE FROM contas_pagar WHERE descricao = 'TESTE Streaming' AND parcela > 6`);
  await estenderRecorrentes();
  rec = (await contas(`AND descricao = 'TESTE Streaming'`)).rows;
  ok(rec.length >= 12 && rec[rec.length - 1].parcela === rec.length, `rotina renova a assinatura (${rec.length} meses)`);

  // Visão mensal
  const vm = await api('GET', `/visao-mensal?inicio=${m0}&meses=3`);
  const secCartao = vm.secoes.find(s => s.titulo === 'TESTE Cartão');
  const secConta = vm.secoes.find(s => s.titulo === 'TESTE Conta');
  const linhaMon = secCartao && secCartao.linhas.find(l => l.descricao === 'TESTE Monitor');
  ok(secCartao && secCartao.cartao && secConta && !secConta.cartao, 'visão: seções por conta e cartão');
  ok(linhaMon && vm.meses.every(m => linhaMon.celulas[m].valor === 279 && linhaMon.celulas[m].ids.length === 1), 'visão: série = uma linha com uma célula por mês');
  ok(secCartao.totais[m0] === 279 + 46.82 && secCartao.fatura_paga[m0] === false, `visão: total da fatura ${secCartao.totais[m0]}`);
  ok(Math.abs(vm.totais[m0].pagar_pessoal - 46.82) < 0.01, 'visão: total pessoal separado');
  const porCat = await api('GET', `/visao-mensal?inicio=${m0}&meses=3&agrupar=categoria`);
  ok(porCat.secoes.some(s => s.titulo === 'Parcelamentos de impostos'), 'visão: agrupar por categoria');

  // Pagar fatura do cartão
  const pf = await api('POST', `/contas-financeiras/${cartao.id}/pagar-fatura`, { mes: m0, data_pagamento: `${m0}-05` });
  ok(pf.qtd === 2, `pagar fatura: ${pf.mensagem}`);
  const vm2 = await api('GET', `/visao-mensal?inicio=${m0}&meses=3`);
  const sc2 = vm2.secoes.find(s => s.titulo === 'TESTE Cartão');
  ok(sc2.fatura_paga[m0] === true && sc2.fatura_paga[m1] === false, 'fatura do mês paga, a seguinte em aberto');
  const repete = await api('POST', `/contas-financeiras/${cartao.id}/pagar-fatura`, { mes: m0, data_pagamento: `${m0}-05` });
  ok(repete.status === 400, 'pagar a mesma fatura de novo é recusado');

  // DRE: pessoal fica fora do resultado
  const dre = await api('GET', `/dre?ano=${m0.slice(0, 4)}`);
  const fora = dre.fora_resultado.categorias.find(c => c.nome === 'Retiradas pessoais');
  ok(fora && fora.total > 0, `DRE: pessoal em "Retiradas pessoais" (${fora && fora.total})`);
  const mesIdx = Number(m0.slice(5)) - 1;
  const despAdm = dre.linhas.find(l => l.chave === 'despesa_administrativa');
  ok(despAdm.valores[mesIdx] <= -279, 'DRE: monitor (empresa) continua como despesa');

  // Edição com mudança para outro cartão aplicada às seguintes
  const primeiraMon = mon[0];
  const ed = await api('PUT', `/contas-pagar/${primeiraMon.id}`, { descricao: 'TESTE Monitor', categoria_id: cat('Outras despesas'), valor: 300,
    competencia: m0, mes_fatura: m0, conta_financeira_id: cartao.id, natureza: 'empresa', aplicar_seguintes: true });
  ok(/mais 2/.test(ed.mensagem || ''), ed.mensagem || 'edição');

  // Encerrar assinatura: excluir esta e as próximas → rotina não recria
  const futura = (await contas(`AND descricao = 'TESTE Streaming' AND status = 'aberta'`)).rows[0];
  const del = await api('DELETE', `/contas-pagar/${futura.id}?seguintes=1`);
  await estenderRecorrentes();
  const resto = (await contas(`AND descricao = 'TESTE Streaming' AND status = 'aberta'`)).rows;
  ok(/encerrada/.test(del.mensagem) && resto.length === 0, `assinatura encerrada e não renovada (${del.mensagem})`);

  // Formato antigo (repetir_meses) continua aceito
  await api('POST', '/contas-pagar', { descricao: 'TESTE Antigo', categoria_id: cat('Contabilidade'), valor: 100,
    competencia: m0, data_vencimento: `${m0}-15`, repetir_meses: 3 });
  ok((await contas(`AND descricao = 'TESTE Antigo'`)).rows.length === 3, 'repetir_meses antigo ainda funciona');

  // limpeza
  await pool.query(`DELETE FROM contas_pagar WHERE descricao LIKE 'TESTE %'`);
  await pool.query(`DELETE FROM contas_financeiras WHERE nome LIKE 'TESTE %'`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
