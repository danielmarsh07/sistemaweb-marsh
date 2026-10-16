require('./_ambiente-local');
// Fluxo novo — fase 4b (docs/plano-fluxo-novo.md): venda das licenças do Conector pela loja.
// O comprador escolhe as licenças por perfil (preço da tabela), paga, e nasce o contrato do Conector com ele como
// administrador da empresa; em produção, a cobrança anual com a 1ª anuidade já paga (o faturamento não cobra de novo).
// Usa o mesmo Asaas FALSO e o mesmo servidor do fluxo-fase4.js (ver o cabeçalho de lá).
const http = require('http');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const loja = require('../backend/services/loja');
const fat = require('../backend/services/faturamento');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1, nome: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const api = async (t, p, m = 'GET', body, headers = {}) => {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const cobrancas = new Map();
let seq = 0;
const servidor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', c => { corpo += c; });
  req.on('end', () => {
    const json = (st, d) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/customers') return json(200, { data: [] });
    if (req.method === 'POST' && u.pathname === '/customers') return json(200, { id: `cus_${++seq}` });
    if (req.method === 'POST' && u.pathname === '/payments') {
      const b = JSON.parse(corpo || '{}');
      const c = { id: `pay_4b_${++seq}`, status: 'PENDING', value: b.value, externalReference: b.externalReference, invoiceUrl: `https://asaas.falso/i/${seq}` };
      cobrancas.set(c.id, c);
      return json(200, c);
    }
    const m = /^\/payments\/([^/]+)/.exec(u.pathname);
    if (m && cobrancas.has(m[1])) { if (req.method === 'DELETE') cobrancas.get(m[1]).status = 'DELETED'; return json(200, cobrancas.get(m[1])); }
    json(404, { errors: [{ description: 'rota falsa' }] });
  });
});

const cnpj = () => {
  const b = [...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)), 0, 0, 0, 1];
  const dv = (n, p) => { const r = n.reduce((s, x, i) => s + x * p[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  b.push(dv(b, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])); b.push(dv(b, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  return b.join('');
};

(async () => {
  await new Promise(r => servidor.listen(3998, r));
  const sufixo = Date.now();
  const ofertas = [], emails = [];
  const pedidoPorToken = t => pool.query('SELECT * FROM pedidos WHERE token = $1', [t]).then(r => r.rows[0]);
  try {
    // --- Oferta de licenças (teste) ---
    const slug = `conector-4b-${sufixo}`;
    const of = await api(tokAdmin, '/loja/ofertas', 'POST', { tipo: 'conector', titulo: 'Conector SAP', slug, descricao: 'IA no seu SAP.', modo: 'teste' });
    ok(of.status === 201, `oferta de licenças criada sem curso (${of.body?.erro || ''})`);
    ofertas.push(of.body.id);
    const pub = (await api(null, `/publico/ofertas/${slug}`)).body;
    const preco = Object.fromEntries(pub.perfis.map(p => [p.id, p.preco_anual]));
    ok(pub.tipo === 'conector' && pub.perfis.length === 3 && preco.abap > 0 && preco.funcional > 0 && preco.ambos > 0, `página traz o preço anual por perfil (${JSON.stringify(preco)})`);

    // --- Pedido: 2 ABAP + 1 Funcional, comprador também usa uma ABAP ---
    const comprador = { nome: 'Carla Compradora', email: `carla-4b-${sufixo}@teste.com`, documento: cnpj(), vagas: { abap: 2, funcional: 1 }, eu_perfil: 'abap' };
    emails.push(comprador.email);
    ok((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { ...comprador, vagas: {} })).status === 400, '! sem licenças recusado');
    ok((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { ...comprador, eu_perfil: 'ambos' })).status === 400, '! usar licença de perfil não comprado recusado');
    const p1 = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', comprador);
    const esperado = 2 * preco.abap + preco.funcional;
    ok(p1.status === 201 && Math.abs(p1.body.valor - esperado) < 0.01, `valor = 2 ABAP + 1 Funcional da tabela (${p1.body?.valor} = ${esperado})`);
    const carla = (await pool.query('SELECT * FROM usuarios WHERE email = $1', [comprador.email])).rows[0];
    ok(carla.portal_papel === 'gestor', 'comprador nasce como administrador (gestor)');
    // Mudou a quantidade: o pedido anterior é substituído
    const p2 = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { ...comprador, vagas: { abap: 3, funcional: 1 } });
    const ant = await pedidoPorToken(p1.body.pedido);
    ok(p2.body.pedido !== p1.body.pedido && ant.status === 'cancelado' && cobrancas.get(ant.asaas_payment_id).status === 'DELETED',
      'mudou as licenças: pedido antigo cancelado (cobrança também) e sai um novo');
    // E-mail já ligado a outra empresa
    const outra = (await pool.query(`INSERT INTO clientes (nome, empresa_id, ativo) VALUES ($1, 1, TRUE) RETURNING id`, [`TESTE 4B outra ${sufixo}`])).rows[0].id;
    await pool.query(`INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo) VALUES ('Davi', $1, 'x', 1, 'cliente', $2, TRUE)`, [`davi-4b-${sufixo}@teste.com`, outra]);
    emails.push(`davi-4b-${sufixo}@teste.com`);
    const dav = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { nome: 'Davi', email: `davi-4b-${sufixo}@teste.com`, documento: cnpj(), vagas: { abap: 1 } });
    ok(dav.status === 400 && /outra empresa/.test(dav.body.erro), `! e-mail de outra empresa recusado (${dav.body?.erro})`);

    // --- Pagamento (teste): contrato do Conector, administrador e licença do comprador ---
    let p = await pedidoPorToken(p2.body.pedido);
    await api(null, '/asaas/webhook', 'POST', { id: `evt_4b_${sufixo}`, event: 'PAYMENT_RECEIVED',
      payment: { ...cobrancas.get(p.asaas_payment_id), status: 'RECEIVED', billingType: 'PIX' } }, { 'asaas-access-token': 'sbx-token-teste' });
    p = await pedidoPorToken(p2.body.pedido);
    ok(p.status === 'pago' && p.contrato_conector_id, 'pago: contrato do Conector criado');
    const k = (await pool.query(`SELECT *, to_char(data_fim, 'YYYY-MM-DD') AS fim FROM contratos_conector WHERE id = $1`, [p.contrato_conector_id])).rows[0];
    const vagas = (await pool.query(`SELECT perfil, usuario_id, estado FROM contratos_conector_vagas WHERE contrato_id = $1 ORDER BY id`, [k.id])).rows;
    const umAno = new Date(); umAno.setMonth(umAno.getMonth() + 12);
    ok(k.origem === 'loja' && k.cliente_id === p.cliente_id && k.fim.slice(0, 7) === umAno.toISOString().slice(0, 7), 'contrato da loja, do cliente do pedido, vigência de 12 meses');
    ok(vagas.filter(v => v.perfil === 'abap').length === 3 && vagas.filter(v => v.perfil === 'funcional').length === 1, '3 licenças ABAP + 1 Funcional');
    ok(vagas.some(v => v.perfil === 'abap' && v.usuario_id === carla.id && v.estado === 'ativa'), 'comprador já usa uma licença ABAP');
    ok((await pool.query('SELECT 1 FROM clientes_admins WHERE cliente_id = $1 AND usuario_id = $2', [p.cliente_id, carla.id])).rows.length === 1, 'comprador é administrador da empresa');
    ok(!(await pool.query('SELECT 1 FROM contratos WHERE contrato_conector_id = $1', [k.id])).rows.length, 'teste: sem cobrança no Financeiro');
    const tokCarla = jwt.sign({ id: carla.id, tipo: 'cliente', empresa_id: 1, cliente_id: carla.cliente_id }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const meus = (await api(tokCarla, '/contratos-conector/meus')).body;
    ok(meus.length === 1 && meus[0].vagas.filter(v => !v.usuario_id).length === 3, 'portal: administradora vê o contrato com 3 licenças para convidar');

    // --- Produção: cobrança anual com a 1ª anuidade paga, sem cobrar de novo ---
    const slugP = `conector-4b-prod-${sufixo}`;
    const ofp = await api(tokAdmin, '/loja/ofertas', 'POST', { tipo: 'conector', titulo: 'Conector SAP', slug: slugP, modo: 'producao' });
    ofertas.push(ofp.body.id);
    const edu = { nome: 'Edu', email: `edu-4b-${sufixo}@teste.com`, documento: cnpj(), vagas: { ambos: 2 } };
    emails.push(edu.email);
    const pp = await pedidoPorToken((await api(null, `/publico/ofertas/${slugP}/pedido`, 'POST', edu)).body.pedido);
    await loja.confirmarPagamento(pp.id, { forma: 'pix' });
    const ppago = (await pool.query('SELECT * FROM pedidos WHERE id = $1', [pp.id])).rows[0];
    const ct = (await pool.query('SELECT * FROM contratos WHERE contrato_conector_id = $1', [ppago.contrato_conector_id])).rows[0];
    const f1 = (await pool.query('SELECT * FROM faturas WHERE id = $1', [ppago.fatura_id])).rows[0];
    ok(ct && ct.periodicidade === 'anual' && ct.renovacao_automatica && Math.abs(Number(ct.valor) - 2 * preco.ambos) < 0.01, 'produção: cobrança anual criada com o valor da compra e renovação automática');
    ok(f1 && f1.status === 'paga' && f1.contrato_id === ct.id, '1ª anuidade registrada como paga no contrato');
    const comp = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
    await fat.gerarRascunhos({ empresa_id: 1, competencia: comp, automatico: true });
    ok((await pool.query('SELECT COUNT(*)::int AS n FROM faturas WHERE contrato_id = $1', [ct.id])).rows[0].n === 1, 'o faturamento do mês não cobra a anuidade de novo');

    // --- Estorno: licenças canceladas ---
    await loja.mudarStatus(pp.id, 'estornado', 'teste');
    const kEst = (await pool.query('SELECT status FROM contratos_conector WHERE id = $1', [ppago.contrato_conector_id])).rows[0];
    const ctEst = (await pool.query('SELECT status FROM contratos WHERE id = $1', [ct.id])).rows[0];
    ok(kEst.status === 'cancelado' && ctEst.status === 'encerrado', 'estorno cancela as licenças e encerra a cobrança');
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    const peds = (await pool.query('SELECT id, cliente_id, fatura_id, contrato_conector_id FROM pedidos WHERE oferta_id = ANY($1)', [ofertas])).rows;
    const ks = peds.map(p => p.contrato_conector_id).filter(Boolean);
    const users = (await pool.query('SELECT id, cliente_id FROM usuarios WHERE email = ANY($1)', [emails])).rows;
    const clientes = [...new Set([...peds.map(p => p.cliente_id), ...users.map(u => u.cliente_id)].filter(Boolean))];
    const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks])).rows.map(r => r.id);
    const cts = (await pool.query('SELECT id FROM contratos WHERE contrato_conector_id = ANY($1)', [ks])).rows.map(r => r.id);
    await pool.query(`DELETE FROM auditoria WHERE (entidade = 'pedido' AND entidade_id = ANY($1)) OR (entidade = 'oferta' AND entidade_id = ANY($2))
      OR (entidade = 'vaga_conector' AND entidade_id = ANY($3)) OR (entidade = 'contrato' AND entidade_id = ANY($4))
      OR (entidade = 'direito_acesso' AND entidade_id IN (SELECT id FROM direitos_acesso WHERE usuario_id = ANY($5)))`,
      [peds.map(p => p.id), ofertas, vagas, cts, users.map(u => u.id)]);
    await pool.query('UPDATE pedidos SET fatura_id = NULL WHERE oferta_id = ANY($1)', [ofertas]);
    await pool.query('DELETE FROM faturas WHERE contrato_id = ANY($1) OR id = ANY($2)', [cts, peds.map(p => p.fatura_id).filter(Boolean)]);
    await pool.query('DELETE FROM contratos WHERE id = ANY($1)', [cts]);
    await pool.query('DELETE FROM pedidos WHERE oferta_id = ANY($1)', [ofertas]);
    await pool.query('DELETE FROM ofertas WHERE id = ANY($1)', [ofertas]);
    await pool.query('DELETE FROM licencas WHERE vaga_id = ANY($1)', [vagas]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks]);
    await pool.query('DELETE FROM contratos_conector WHERE id = ANY($1)', [ks]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users.map(u => u.id)]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users.map(u => u.id)]);
    await pool.query(`DELETE FROM clientes WHERE id = ANY($1) OR nome LIKE 'TESTE 4B %'`, [clientes]);
    await pool.query(`DELETE FROM asaas_eventos WHERE id LIKE 'sbx:evt_4b_%'`);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    servidor.close();
    process.exit(falhas ? 1 : 0);
  }
})();
