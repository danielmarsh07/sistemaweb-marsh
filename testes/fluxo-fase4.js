require('./_ambiente-local');
// Fluxo novo — fase 4 (docs/plano-fluxo-novo.md): loja de cursos.
// Cenários 7, 8, 9, 17 e 20 do documento: compra individual, confirmação do pagamento, matrícula automática,
// webhook repetido, falha e reprocessamento da cobrança. Mais: promoção, cupom (limite em concorrência), clique duplo,
// oferta gratuita, estorno tira o acesso, teste × produção isolados, expiração, aluno corporativo comprando.
// Usa um Asaas FALSO nesta máquina. Servidor local com:
//   ASAAS_URL_TESTES=http://localhost:3998 ASAAS_SANDBOX_WEBHOOK_TOKEN=sbx-token-teste ASAAS_WEBHOOK_TOKEN=token-teste-local-123 \
//   LOJA_LIMITE_PEDIDOS=100 npm run dev:local
const http = require('http');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const loja = require('../backend/services/loja');
const BASE = 'http://localhost:3000/api';
const PORTA = 3998;

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1, nome: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const api = async (t, p, m = 'GET', body, headers = {}) => {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const webhook = (evento, payment, token = 'sbx-token-teste') =>
  api(null, '/asaas/webhook', 'POST', { id: `evt_f4_${Date.now()}_${Math.random().toString(36).slice(2)}`, event: evento, payment }, { 'asaas-access-token': token });

// ----- Asaas falso -----
const cobrancas = new Map();
let seq = 0, falharCobranca = false;
const servidor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', c => { corpo += c; });
  req.on('end', () => {
    const json = (st, d) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/customers') return json(200, { data: [] });
    if (req.method === 'POST' && u.pathname === '/customers') return json(200, { id: `cus_${++seq}` });
    if (req.method === 'POST' && u.pathname === '/payments') {
      if (falharCobranca) return json(500, { errors: [{ description: 'instabilidade simulada' }] });
      const b = JSON.parse(corpo || '{}');
      const id = `pay_f4_${++seq}`;
      const c = { id, status: 'PENDING', value: b.value, externalReference: b.externalReference, billingType: 'UNDEFINED', invoiceUrl: `https://asaas.falso/i/${id}` };
      cobrancas.set(id, c);
      return json(200, c);
    }
    const m = /^\/payments\/([^/]+)(\/receiveInCash)?$/.exec(u.pathname);
    if (m && cobrancas.has(m[1])) {
      const c = cobrancas.get(m[1]);
      if (req.method === 'DELETE') { c.status = 'DELETED'; return json(200, { deleted: true, id: c.id }); }
      if (m[2]) { c.status = 'RECEIVED_IN_CASH'; return json(200, c); }
      return json(200, c);
    }
    json(404, { errors: [{ description: `rota falsa: ${req.method} ${u.pathname}` }] });
  });
});

(async () => {
  await new Promise(r => servidor.listen(PORTA, r));
  const sufixo = Date.now();
  const limpar = { cursos: [], ofertas: [], cupons: [], emails: [] };
  const cpf = () => { const b = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
    const dv = n => { const r = n.reduce((s, x, i) => s + x * (n.length + 1 - i), 0) % 11; return r < 2 ? 0 : 11 - r; };
    b.push(dv(b)); b.push(dv(b)); return b.join(''); };
  const pedidoPorToken = t => pool.query('SELECT * FROM pedidos WHERE token = $1', [t]).then(r => r.rows[0]);
  const futuro = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  try {
    const curso = (await pool.query(`INSERT INTO cursos (empresa_id, titulo, status, ordem) VALUES (1, $1, 'publicado', 996) RETURNING id`, [`TESTE F4 ABAP Avançado ${sufixo}`])).rows[0].id;
    limpar.cursos.push(curso);
    await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, 'Aula 1', 0)`, [curso]);

    // --- Oferta de teste com promoção e cupom ---
    const slug = `teste-f4-${sufixo}`;
    const of = await api(tokAdmin, '/loja/ofertas', 'POST', { curso_id: curso, titulo: 'ABAP Avançado', slug, descricao: 'Curso completo.',
      preco: 497, preco_promocional: 397, promo_fim: futuro, duracao_meses: 12, modo: 'teste' });
    ok(of.status === 201, `oferta de teste criada (${of.body?.erro || ''})`);
    limpar.ofertas.push(of.body.id);
    ok((await api(tokAdmin, '/loja/ofertas', 'POST', { curso_id: curso, titulo: 'x', slug, preco: 1 })).status === 400, '! endereço repetido recusado');
    const pub = (await api(null, `/publico/ofertas/${slug}`)).body;
    ok(pub.preco === 397 && pub.preco_cheio === 497 && pub.promocional && pub.teste && pub.duracao_meses === 12, 'página pública: preço promocional, modo teste e 12 meses');
    const cup = await api(tokAdmin, '/loja/cupons', 'POST', { codigo: `F4${sufixo}`.slice(0, 40), tipo: 'percentual', valor: 10, usos_max: 1 });
    limpar.cupons.push(cup.body.id);
    const codigo = `F4${sufixo}`.slice(0, 40);
    const conf = await api(null, `/publico/ofertas/${slug}/cupom`, 'POST', { cupom: codigo.toLowerCase() });
    ok(conf.status === 200 && conf.body.desconto === 39.7 && conf.body.total === 357.3, `cupom confere 10% (${JSON.stringify(conf.body)})`);

    // --- Cenário 7: compra individual (cadastro na hora) ---
    const ana = { nome: 'Ana Compradora', email: `ana-f4-${sufixo}@teste.com`, documento: cpf(), cupom: codigo, origem: 'whatsapp' };
    limpar.emails.push(ana.email);
    const ped = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', ana);
    ok(ped.status === 201 && /asaas\.falso/.test(ped.body.link) && ped.body.valor === 357.3, `pedido criado com o link de pagamento (${ped.body?.erro || ped.body?.valor})`);
    let p = await pedidoPorToken(ped.body.pedido);
    const anaU = (await pool.query('SELECT * FROM usuarios WHERE email = $1', [ana.email])).rows[0];
    ok(p.status === 'pendente' && p.origem === 'whatsapp' && anaU.portal_papel === 'aluno', 'pedido pendente, origem registrada, conta de aluno criada');
    ok((await pool.query('SELECT tipo_pessoa FROM clientes WHERE id = $1', [p.cliente_id])).rows[0].tipo_pessoa === 'PF', 'comprador cadastrado como cliente pessoa física');
    // Clique duplo: mesmo pedido, sem gastar o cupom de novo
    const dup = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', ana);
    ok(dup.status === 200 && dup.body.pedido === ped.body.pedido && dup.body.existente, 'segundo clique devolve o mesmo pedido');
    ok((await pool.query('SELECT usos FROM cupons WHERE id = $1', [cup.body.id])).rows[0].usos === 1, 'cupom usado uma vez só');
    const bia = { nome: 'Bia', email: `bia-f4-${sufixo}@teste.com`, documento: cpf(), cupom: codigo };
    limpar.emails.push(bia.email);
    const esg = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', bia);
    ok(esg.status === 400 && /cupom/i.test(esg.body.erro), `! cupom de 1 uso esgotado para a próxima pessoa (${esg.body?.erro})`);
    ok((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { ...bia, documento: '123' })).status === 400, '! CPF inválido recusado');
    ok((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { ...bia, cupom: '', email: (await pool.query('SELECT email FROM usuarios WHERE id = 1')).rows[0].email })).status === 400,
      '! e-mail de usuário da equipe recusado');

    // --- Cenários 8, 9 e 17: confirmação pelo webhook, matrícula e webhook repetido ---
    ok(!(await pool.query(`SELECT 1 FROM direitos_acesso WHERE usuario_id = $1 AND curso_id = $2`, [anaU.id, curso])).rows.length, 'antes de pagar: sem acesso');
    const pagto = { ...cobrancas.get(p.asaas_payment_id), status: 'RECEIVED', billingType: 'PIX' };
    const w1 = await webhook('PAYMENT_RECEIVED', pagto);
    const w2 = await webhook('PAYMENT_CONFIRMED', { ...pagto, status: 'CONFIRMED' });
    p = await pedidoPorToken(ped.body.pedido);
    const dir = (await pool.query(`SELECT * FROM direitos_acesso WHERE usuario_id = $1 AND curso_id = $2 AND origem = 'compra'`, [anaU.id, curso])).rows;
    ok(w1.body.resultado === 'pago' && p.status === 'pago' && p.forma_pagamento === 'pix', 'webhook confirma o pagamento');
    ok(w2.body.resultado === 'sem_mudanca' && dir.length === 1, 'aviso repetido não libera duas vezes');
    const fimEsperado = new Date(); fimEsperado.setMonth(fimEsperado.getMonth() + 12);
    ok(dir[0].status === 'ativo' && String(p.acesso_fim instanceof Date ? p.acesso_fim.toISOString() : p.acesso_fim).slice(0, 7) === fimEsperado.toISOString().slice(0, 7), 'acesso de compra por 12 meses');
    ok((await pool.query('SELECT 1 FROM matriculas WHERE usuario_id = $1 AND curso_id = $2', [anaU.id, curso])).rows.length === 1, 'matrícula automática');
    ok(!p.fatura_id, 'pedido de teste não gera fatura');
    ok((await pool.query(`SELECT COUNT(*)::int AS n FROM auditoria WHERE entidade = 'pedido' AND entidade_id = $1 AND acao = 'pedido.pago'`, [p.id])).rows[0].n === 1, 'um registro de pagamento só');
    const tokAna = jwt.sign({ id: anaU.id, tipo: 'cliente', empresa_id: 1, cliente_id: anaU.cliente_id }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const meus = (await api(tokAna, '/treinamentos/meus')).body.find(c => c.id === curso);
    ok(meus && meus.via_compra, 'aluna vê o curso como próprio no portal');
    const pedidosAna = (await api(tokAna, '/loja/meus-pedidos')).body;
    ok(pedidosAna.length === 1 && pedidosAna[0].status === 'pago', 'portal: "Meus pedidos" mostra o pedido pago');
    const st = (await api(null, `/publico/pedidos/${ped.body.pedido}`)).body;
    ok(st.status === 'pago' && !('email' in st), 'página de retorno mostra o status sem dados pessoais');

    // --- Estorno tira o acesso comprado; o progresso fica ---
    const aula = (await pool.query('SELECT id FROM cursos_aulas WHERE curso_id = $1', [curso])).rows[0].id;
    await api(tokAna, `/treinamentos/aulas/${aula}/concluir`, 'POST', {});
    await webhook('PAYMENT_REFUNDED', { ...pagto, status: 'REFUNDED' });
    p = await pedidoPorToken(ped.body.pedido);
    ok(p.status === 'estornado' && !(await api(tokAna, '/treinamentos/meus')).body.find(c => c.id === curso), 'estorno: pedido estornado e curso retirado');
    ok((await pool.query('SELECT 1 FROM cursos_progresso WHERE usuario_id = $1 AND aula_id = $2', [anaU.id, aula])).rows.length === 1, 'progresso guardado');

    // --- Teste e produção não se misturam ---
    const slugProd = `teste-f4-prod-${sufixo}`;
    const ofp = await api(tokAdmin, '/loja/ofertas', 'POST', { curso_id: curso, titulo: 'ABAP Avançado (real)', slug: slugProd, preco: 100, modo: 'producao' });
    limpar.ofertas.push(ofp.body.id);
    const carlos = { nome: 'Carlos', email: `carlos-f4-${sufixo}@teste.com`, documento: cpf() };
    limpar.emails.push(carlos.email);
    const pedProd = await api(null, `/publico/ofertas/${slugProd}/pedido`, 'POST', carlos);
    let pp = await pedidoPorToken(pedProd.body.pedido);
    const wx = await webhook('PAYMENT_RECEIVED', { ...cobrancas.get(pp.asaas_payment_id), status: 'RECEIVED' }, 'sbx-token-teste');
    pp = await pedidoPorToken(pedProd.body.pedido);
    ok(wx.body.resultado === 'modo_diferente' && pp.status === 'pendente', 'aviso da conta de TESTE não paga pedido de produção');
    ok((await api(tokAdmin, `/loja/pedidos/${pp.id}/confirmar-teste`, 'POST')).status === 400, '! "simular pagamento" recusado em pedido de produção');
    await loja.confirmarPagamento(pp.id, { forma: 'pix' });
    pp = await pedidoPorToken(pedProd.body.pedido);
    const fat = (await pool.query('SELECT status, emitir_nfse, valor::float AS valor FROM faturas WHERE id = $1', [pp.fatura_id])).rows[0];
    ok(fat && fat.status === 'paga' && fat.emitir_nfse === false && fat.valor === 100, 'pedido de produção pago vira receita (fatura paga, sem nota automática)');

    // --- Cenário 20: falha ao gerar a cobrança e nova tentativa ---
    falharCobranca = true;
    const dani = { nome: 'Dani', email: `dani-f4-${sufixo}@teste.com`, documento: cpf() };
    limpar.emails.push(dani.email);
    const f1 = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', dani);
    const pDani = (await pool.query(`SELECT p.* FROM pedidos p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = $1`, [dani.email])).rows[0];
    ok(f1.status === 400 && pDani.erro && !pDani.link_pagamento, `instabilidade no Asaas: mensagem amigável e erro guardado (${f1.body?.erro})`);
    falharCobranca = false;
    const f2 = await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', dani);
    const pDani2 = await pedidoPorToken(f2.body.pedido);
    ok(f2.status === 200 && pDani2.id === pDani.id && pDani2.link_pagamento && !pDani2.erro, 'nova tentativa reaproveita o mesmo pedido e gera a cobrança');
    // Homologação pelo painel
    const sim = await api(tokAdmin, `/loja/pedidos/${pDani.id}/confirmar-teste`, 'POST');
    ok(sim.status === 200 && (await pedidoPorToken(f2.body.pedido)).status === 'pago', 'botão "Simular pagamento" libera o pedido de teste');

    // --- Oferta gratuita, cancelamento, expiração ---
    const slugGratis = `teste-f4-gratis-${sufixo}`;
    const ofg = await api(tokAdmin, '/loja/ofertas', 'POST', { curso_id: curso, titulo: 'Aula grátis', slug: slugGratis, preco: 0, duracao_meses: '', modo: 'teste' });
    limpar.ofertas.push(ofg.body.id);
    const eva = { nome: 'Eva', email: `eva-f4-${sufixo}@teste.com`, documento: cpf() };
    limpar.emails.push(eva.email);
    const pg = await api(null, `/publico/ofertas/${slugGratis}/pedido`, 'POST', eva);
    const pgp = await pedidoPorToken(pg.body.pedido);
    ok(pgp.status === 'pago' && !pgp.asaas_payment_id && !pgp.acesso_fim, 'oferta gratuita libera sem cobrança e sem prazo');
    const fabio = { nome: 'Fabio', email: `fabio-f4-${sufixo}@teste.com`, documento: cpf() };
    limpar.emails.push(fabio.email);
    const pf = await pedidoPorToken((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', fabio)).body.pedido);
    ok((await api(tokAdmin, `/loja/pedidos/${pf.id}/cancelar`, 'POST')).status === 200 && cobrancas.get(pf.asaas_payment_id).status === 'DELETED',
      'admin cancela o pedido e a cobrança no Asaas');
    const gil = { nome: 'Gil', email: `gil-f4-${sufixo}@teste.com`, documento: cpf() };
    limpar.emails.push(gil.email);
    const pgil = await pedidoPorToken((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', gil)).body.pedido);
    await pool.query(`UPDATE pedidos SET vencimento = CURRENT_DATE - 10 WHERE id = $1`, [pgil.id]);
    await loja.expirarPedidos();
    ok((await pedidoPorToken(pgil.token)).status === 'expirado', 'pedido não pago expira depois do prazo');

    // --- Usuário corporativo comprando com o próprio CPF: mesma conta, empresa mantida ---
    const corp = (await pool.query(`INSERT INTO clientes (nome, empresa_id, ativo) VALUES ($1, 1, TRUE) RETURNING id`, [`TESTE F4 Empresa ${sufixo}`])).rows[0].id;
    const joao = (await pool.query(`INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo) VALUES ('João', $1, 'x', 1, 'cliente', $2, TRUE) RETURNING id`,
      [`joao-f4-${sufixo}@teste.com`, corp])).rows[0].id;
    limpar.emails.push(`joao-f4-${sufixo}@teste.com`);
    const pj = await pedidoPorToken((await api(null, `/publico/ofertas/${slug}/pedido`, 'POST', { nome: 'João', email: `joao-f4-${sufixo}@teste.com`, documento: cpf() })).body.pedido);
    const joaoDepois = (await pool.query('SELECT cliente_id FROM usuarios WHERE id = $1', [joao])).rows[0];
    ok(pj.usuario_id === joao && joaoDepois.cliente_id === corp && pj.cliente_id !== corp, 'mesma conta; continua na empresa; a compra fica no CPF dele');
    await pool.query('UPDATE pedidos SET status = $2 WHERE id = $1', [pj.id, 'cancelado']);
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    const users = (await pool.query('SELECT id, cliente_id FROM usuarios WHERE email = ANY($1)', [limpar.emails])).rows;
    const uids = users.map(u => u.id);
    const peds = (await pool.query('SELECT id, cliente_id, fatura_id FROM pedidos WHERE oferta_id = ANY($1)', [limpar.ofertas])).rows;
    const clientes = [...new Set([...peds.map(p => p.cliente_id), ...users.map(u => u.cliente_id)].filter(Boolean))];
    await pool.query(`DELETE FROM auditoria WHERE (entidade = 'pedido' AND entidade_id = ANY($1)) OR (entidade = 'oferta' AND entidade_id = ANY($2))`, [peds.map(p => p.id), limpar.ofertas]);
    await pool.query(`DELETE FROM auditoria WHERE entidade = 'direito_acesso' AND entidade_id IN (SELECT id FROM direitos_acesso WHERE usuario_id = ANY($1))`, [uids]);
    await pool.query('UPDATE pedidos SET fatura_id = NULL WHERE oferta_id = ANY($1)', [limpar.ofertas]);
    await pool.query('DELETE FROM faturas WHERE id = ANY($1)', [peds.map(p => p.fatura_id).filter(Boolean)]);
    await pool.query('DELETE FROM pedidos WHERE oferta_id = ANY($1)', [limpar.ofertas]);
    await pool.query('DELETE FROM cupons WHERE id = ANY($1)', [limpar.cupons]);
    await pool.query('DELETE FROM ofertas WHERE id = ANY($1)', [limpar.ofertas]);
    await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = ANY($1)', [uids]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [uids]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [uids]);
    await pool.query(`DELETE FROM clientes WHERE id = ANY($1) OR nome LIKE 'TESTE F4 %'`, [clientes]);
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = ANY($1)', [limpar.cursos]);
    await pool.query('DELETE FROM cursos WHERE id = ANY($1)', [limpar.cursos]);
    await pool.query(`DELETE FROM asaas_eventos WHERE id LIKE 'sbx:evt_f4_%' OR id LIKE 'evt_f4_%'`);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    servidor.close();
    process.exit(falhas ? 1 : 0);
  }
})();
