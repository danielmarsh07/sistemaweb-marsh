require('./_ambiente-local');
// Impostos estimados pelas notas (Lucro Presumido) na Visão mensal: cálculo puro + a API.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const imp = require('../backend/services/impostos');
const BASE = 'http://localhost:3000/api/financeiro';
const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
const perto = (a, b) => Math.abs(a - b) < 0.011;

(async () => {
  // Out–dez: Multi R$ 21.000 + Elite R$ 1.500 por mês, ISS 3% sem retenção
  const notas = ['2026-10', '2026-11', '2026-12'].flatMap(comp => [
    { comp, cliente: 'Multi', bruto: 21000, iss: 3, reter_iss: false },
    { comp, cliente: 'Elite', bruto: 1500, iss: 3, reter_iss: false }
  ]);
  const lista = ['2026-11', '2026-12', '2027-01'];
  const r = imp.calcular({ notas, lista, deslocamento: 1, config: {} });
  const cel = (k, m) => r.linhas.find(l => l.chave === k).celulas[m];
  ok(perto(cel('iss', '2026-11').valor, 675), `ISS de nov (notas de out × 3%) = ${cel('iss', '2026-11').valor}`);
  ok(perto(cel('pis', '2026-11').valor, 146.25) && perto(cel('cofins', '2026-11').valor, 675), 'PIS 0,65% e COFINS 3% no mês seguinte');
  ok(cel('irpj', '2026-12').valor === 0 && perto(cel('irpj', '2027-01').valor, 3240) && perto(cel('csll', '2027-01').valor, 1944),
    `IRPJ/CSLL do 4º tri em jan: ${cel('irpj', '2027-01').valor} + ${cel('csll', '2027-01').valor}`);
  ok(perto(r.reserva['2026-11'].valor, 1728), `reserva mensal para o trimestral = ${r.reserva['2026-11'].valor}`);

  // Adicional de IRPJ: lucro presumido acima de R$ 60 mil no trimestre
  const grande = imp.calcular({ notas: [{ comp: '2026-10', cliente: 'X', bruto: 300000, iss: 0 }], lista: ['2027-01'], deslocamento: 1, config: {} });
  // presumido 96.000 → 15% = 14.400 + 10% de 36.000 = 3.600
  ok(perto(grande.linhas.find(l => l.chave === 'irpj').celulas['2027-01'].valor, 18000), 'adicional de 10% acima de R$ 60 mil');

  // Retenções do cliente descontam; ISS retido não se paga
  const ret = imp.calcular({ notas: [{ comp: '2026-10', cliente: 'X', bruto: 10000, iss: 2, reter_iss: true, ret_ir: 1.5, ret_csll: 1, ret_pis: 0.65, ret_cofins: 3 }],
    lista: ['2026-11', '2027-01'], deslocamento: 1, config: {} });
  const c2 = (k, m) => ret.linhas.find(l => l.chave === k).celulas[m].valor;
  ok(c2('iss', '2026-11') === 0 && c2('pis', '2026-11') === 0 && c2('cofins', '2026-11') === 0, 'ISS retido e PIS/COFINS retidos: nada a pagar');
  ok(perto(c2('irpj', '2027-01'), 480 - 150) && perto(c2('csll', '2027-01'), 288 - 100), 'IRRF e CSLL retidos descontados do trimestral');

  // Guia lançada de verdade substitui a estimativa
  const lan = imp.calcular({ notas, lista, deslocamento: 1, config: {}, lancados: new Set(['2026-11|iss']) });
  const iss = lan.linhas.find(l => l.chave === 'iss').celulas['2026-11'];
  ok(iss.valor === 0 && iss.lancado, 'ISS já lançado em contas a pagar não conta em dobro');
  ok(imp.grupoDaCategoria('PIS e COFINS') === 'pis_cofins' && imp.grupoDaCategoria('Parcelamentos de impostos') === null, 'categoria → guia');

  // Alíquotas da configuração
  const cfg = imp.calcular({ notas, lista, deslocamento: 1, config: { impostos: { cofins: 7.6 } } });
  ok(perto(cfg.linhas.find(l => l.chave === 'cofins').celulas['2026-11'].valor, 1710), 'COFINS da configuração (7,6%)');

  // API: a visão traz a seção e os totais com impostos
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const hoje = new Date();
  const m0 = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  const vm = await (await fetch(`${BASE}/visao-mensal?inicio=${m0}&meses=6`, { headers: { Authorization: `Bearer ${token}` } })).json();
  ok(vm.impostos && vm.impostos.linhas.length === 5 && vm.meses.every(m => typeof vm.totais[m].impostos === 'number' && vm.impostos.reserva[m]),
    'visão mensal: seção de impostos, total e reserva por mês');
  const cfgApi = await (await fetch(`${BASE}/config`, { headers: { Authorization: `Bearer ${token}` } })).json();
  ok(cfgApi.impostos && cfgApi.impostos.pis === 0.65, 'configuração mostra os padrões do Lucro Presumido');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
