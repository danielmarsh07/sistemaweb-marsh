require('./_ambiente-local');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api/financeiro';

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) console.log('  !', m, p, r.status, j);
    return j;
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);

  const cats = await api('GET', '/categorias-despesa');
  ok(cats.length >= 12, `categorias padrão: ${cats.length}`);
  const cat = n => cats.find(c => c.nome === n).id;

  const mes = new Date().toISOString().slice(0, 7);
  const r1 = await api('POST', '/contas-pagar', { descricao: 'TESTE Contador', categoria_id: cat('Contabilidade'), valor: 500,
    competencia: mes, data_vencimento: `${mes}-15`, repetir_meses: 3 });
  ok(/3 (contas|parcela)/.test(r1.mensagem), r1.mensagem);
  await api('POST', '/contas-pagar', { descricao: 'TESTE ISS', categoria_id: cat('ISS'), valor: 300, competencia: mes,
    data_vencimento: `${mes}-05`, ja_paga: true, data_pagamento: `${mes}-05` });
  await api('POST', '/contas-pagar', { descricao: 'TESTE Lucros', categoria_id: cat('Distribuição de lucros'), valor: 1000, competencia: mes,
    data_vencimento: `${mes}-20` });

  const lista = await api('GET', `/contas-pagar?mes=${mes}`);
  const testes = lista.filter(c => c.descricao.startsWith('TESTE'));
  ok(testes.length === 3, `listadas no mês: ${testes.length}`);
  const contador = testes.find(c => c.descricao === 'TESTE Contador');
  ok(contador.parcela === 1 && contador.total_parcelas === 3, 'parcela 1/3');

  const ed = await api('PUT', `/contas-pagar/${contador.id}`, { ...contador, competencia: mes, valor: 550, aplicar_seguintes: true });
  ok(/mais 2/.test(ed.mensagem), ed.mensagem);
  const bx = await api('POST', `/contas-pagar/${contador.id}/baixa`, { data_pagamento: `${mes}-15`, valor_pago: 550 });
  ok(bx.mensagem, 'baixa');
  const resumo = await api('GET', `/contas-pagar/resumo?mes=${mes}`);
  console.log('     resumo', resumo);

  const fc = await api('GET', `/fluxo-caixa?inicio=${mes}&meses=4`);
  console.log('     fluxo', fc.meses.map(m => `${m.mes} ab=${m.saldo_abertura} +r${m.entradas_realizadas} +p${m.entradas_previstas} +c${m.contratos_estimados} -r${m.saidas_realizadas} -p${m.saidas_previstas} fim=${m.saldo_final}`));
  ok(fc.meses[1].saidas_previstas >= 550, 'parcela 2 prevista no mês seguinte');

  const dre = await api('GET', `/dre?ano=${mes.slice(0, 4)}`);
  const linha = k => dre.linhas.find(l => l.chave === k);
  const m = Number(mes.slice(5)) - 1;
  console.log('     dre mês', ['receita_bruta', 'impostos_receita', 'despesa_administrativa', 'resultado_liquido'].map(k => `${k}=${linha(k).valores[m]}`).join(' '));
  ok(dre.fora_resultado.valores[m] === 1000, 'lucros fora da DRE');

  await api('PUT', '/saldo-inicial', { saldo_inicial: 10000, saldo_inicial_data: `${mes}-01` });
  const fc2 = await api('GET', `/fluxo-caixa?inicio=${mes}&meses=2`);
  ok(fc2.meses[0].saldo_abertura === 10000, `saldo abertura com saldo inicial: ${fc2.meses[0].saldo_abertura}`);

  const es = await api('POST', `/contas-pagar/${contador.id}/estornar-baixa`);
  ok(es.mensagem, 'estorno');
  const del = await api('DELETE', `/contas-pagar/${contador.id}?seguintes=1`);
  ok(/3 contas/.test(del.mensagem), del.mensagem);

  // limpeza
  await pool.query(`DELETE FROM contas_pagar WHERE descricao LIKE 'TESTE %'`);
  await pool.query(`UPDATE financeiro_config SET saldo_inicial = 0, saldo_inicial_data = NULL WHERE empresa_id = 1`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
