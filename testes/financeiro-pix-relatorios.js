require('./_ambiente-local');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';
const WEBHOOK_TOKEN = 'token-teste-local-123';

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, body, headers = { Authorization: `Bearer ${token}` }) => {
    const r = await fetch(BASE + p, { method: m, headers: { ...headers, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('json') ? await r.json() : { texto: await r.text() };
    if (!r.ok) console.log('  !', m, p, r.status, j.erro || j);
    return { status: r.status, headers: r.headers, ...j };
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const mes = new Date().toISOString().slice(0, 7);

  // Cliente e fatura de teste (sem NFS-e)
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, cpf_cnpj, email, empresa_id, ativo) VALUES ('TESTE PIX', 'TESTE PIX LTDA', '11.222.333/0001-81', 'pix@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const novaFatura = async valor => {
    const f = await api('POST', '/financeiro/faturas', { cliente_id: cli, competencia: mes, descricao: 'TESTE serviço', valor,
      data_vencimento: `${mes}-28`, emitir_nfse: false, ret_ir: 1.5, ret_csll: 1, ret_pis: 0, ret_cofins: 0, ret_inss: 0 });
    await api('POST', '/financeiro/faturas/aprovar', { ids: [f.id] });
    return f.id;
  };

  // 1. Webhook PIX recebido → baixa + tarifa
  const f1 = await novaFatura(1000);
  await pool.query(`UPDATE faturas SET pix_asaas_id = 'pay_teste_1', pix_status = 'pendente', pix_payload = '000201TESTE' WHERE id = $1`, [f1]);
  const semToken = await api('POST', '/asaas/webhook', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_teste_1' } }, {});
  ok(semToken.status === 401, 'webhook sem token recusado');
  const wh = await api('POST', '/asaas/webhook', {
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_teste_1', status: 'RECEIVED', value: 975, netValue: 973.01, paymentDate: `${mes}-10`, externalReference: `cobranca-fatura-${f1}` }
  }, { 'asaas-access-token': WEBHOOK_TOKEN });
  ok(wh.ok, 'webhook aceito');
  const fat1 = (await pool.query(`SELECT status, valor_pago::float, forma_pagamento, pix_status, pix_taxa::float, to_char(data_pagamento,'YYYY-MM-DD') dp FROM faturas WHERE id = $1`, [f1])).rows[0];
  ok(fat1.status === 'paga' && fat1.valor_pago === 975 && fat1.forma_pagamento === 'pix' && fat1.pix_taxa === 1.99 && fat1.dp === `${mes}-10`,
    `baixa automática ${JSON.stringify(fat1)}`);
  const tarifa = (await pool.query(`SELECT valor::float, status FROM contas_pagar WHERE documento = $1`, [`fatura-${f1}`])).rows;
  ok(tarifa.length === 1 && tarifa[0].valor === 1.99 && tarifa[0].status === 'paga', 'tarifa Asaas lançada como despesa paga');
  // Repetição do evento não duplica
  await api('POST', '/asaas/webhook', { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_teste_1', status: 'CONFIRMED', value: 975, netValue: 973.01 } },
    { 'asaas-access-token': WEBHOOK_TOKEN });
  const tarifa2 = (await pool.query(`SELECT COUNT(*)::int n FROM contas_pagar WHERE documento = $1`, [`fatura-${f1}`])).rows[0].n;
  ok(tarifa2 === 1, 'evento repetido não duplica tarifa');
  const est = await api('POST', `/financeiro/faturas/${f1}/estornar-baixa`);
  ok(est.status === 400, 'não desfaz baixa de PIX recebido');

  // 2. Baixa manual com PIX pendente → PIX cancelado
  const f2 = await novaFatura(500);
  await pool.query(`UPDATE faturas SET pix_asaas_id = 'pay_inexistente', pix_status = 'pendente' WHERE id = $1`, [f2]);
  await api('POST', `/financeiro/faturas/${f2}/baixa`, { data_pagamento: `${mes}-12`, valor_pago: 487.5, forma_pagamento: 'transferencia' });
  const fat2 = (await pool.query(`SELECT status, pix_status FROM faturas WHERE id = $1`, [f2])).rows[0];
  ok(fat2.status === 'paga' && fat2.pix_status === 'cancelado', 'baixa manual cancela o PIX pendente');

  // 3. PIX real no sandbox do Asaas
  const f3 = await novaFatura(100);
  const gp = await api('POST', `/financeiro/faturas/${f3}/pix`);
  const fat3 = (await pool.query(`SELECT pix_status, pix_asaas_id, LENGTH(pix_payload) lp, LENGTH(pix_qrcode) lq, pix_erro FROM faturas WHERE id = $1`, [f3])).rows[0];
  console.log('     sandbox:', gp.mensagem || gp.erro, JSON.stringify(fat3));
  if (fat3.pix_status === 'pendente') {
    const canc = await api('POST', `/financeiro/faturas/${f3}/cancelar`);
    const c3 = (await pool.query(`SELECT status, pix_status FROM faturas WHERE id = $1`, [f3])).rows[0];
    ok(c3.status === 'cancelada' && c3.pix_status === 'cancelado', `cancelar fatura cancela PIX no sandbox (${canc.mensagem || canc.erro})`);
  }

  // 4. Portal mostra PIX pendente
  await pool.query(`UPDATE faturas SET pix_status = 'pendente', pix_payload = '000201PORTAL', pix_qrcode = 'iVBORw0KGgo=', status = 'aberta' WHERE id = $1`, [f3]);
  const tokCli = jwt.sign({ id: u.id, tipo: 'cliente', cliente_id: cli, empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const portal = await api('GET', '/financeiro/minhas-faturas', null, { Authorization: `Bearer ${tokCli}` });
  const fp = portal.faturas.find(x => x.id === f3);
  ok(fp && fp.pix_payload === '000201PORTAL' && fp.pix_qrcode, 'portal recebe o PIX pendente');
  const fpPaga = portal.faturas.find(x => x.id === f1);
  ok(fpPaga && !fpPaga.pix_payload, 'fatura paga não expõe PIX');

  // 5. Relatórios e CSV
  const rel = await api('GET', '/financeiro/relatorios?meses=12');
  ok(rel.meses.length === 12 && rel.meses[11].mes === mes, `relatórios: 12 meses até ${rel.mes_atual}`);
  const mAtual = rel.meses[11];
  ok(mAtual.recebido >= 975 + 487.5, `recebido no mês inclui as baixas (${mAtual.recebido})`);
  ok(rel.clientes.some(c => c.cliente.startsWith('TESTE PIX')), 'cliente de teste no ranking');
  ok(rel.aging.length === 5 && rel.recebimento.pagas >= 2, `aging ${JSON.stringify(rel.aging.map(a => a.qtd))} · recebimento ${JSON.stringify(rel.recebimento)}`);
  const csv = await api('GET', `/financeiro/exportar/faturas.csv?inicio=${mes}&fim=${mes}`);
  const linhas = csv.texto.split('\r\n');
  ok(linhas[0].includes('Competência;Cliente') && linhas.some(l => l.includes('TESTE PIX LTDA') && l.includes('975')),
    `CSV faturas (${linhas.length - 1} linha(s))`);
  const csv2 = await api('GET', `/financeiro/exportar/contas-pagar.csv?inicio=${mes}&fim=${mes}`);
  ok(csv2.texto.includes('Tarifa Asaas'), 'CSV contas a pagar com a tarifa');
  const ruim = await api('GET', `/financeiro/exportar/faturas.csv?inicio=2026-13&fim=${mes}`);
  ok(ruim.status === 400, 'período inválido recusado');

  // limpeza
  const ids = [f1, f2, f3];
  await pool.query(`DELETE FROM contas_pagar WHERE documento = ANY($1)`, [ids.map(i => `fatura-${i}`)]);
  await pool.query(`DELETE FROM faturas WHERE id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM clientes WHERE id = $1`, [cli]);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
