require('./_ambiente-local');
// Ordenação por coluna e filtros das listagens (tabela-ordenavel.js) e da visão mensal, no Chrome headless.
// Cria dados de teste no banco local, clica nos cabeçalhos/filtros e confere a ordem das linhas; apaga tudo no fim.
const { spawn } = require('child_process');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTA = 9334;
const espera = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const u = (await pool.query(`SELECT id, nome, email, tipo, empresa_id FROM usuarios WHERE tipo IN ('admin_sistema','admin_empresa') ORDER BY id LIMIT 1`)).rows[0];
  const cli = (await pool.query(`SELECT id FROM clientes WHERE empresa_id = 1 AND ativo ORDER BY id LIMIT 1`)).rows[0];
  const cat = (await pool.query(`SELECT id FROM categorias_transacao WHERE empresa_id = 1 AND tipo = 'saída' AND ativo ORDER BY id LIMIT 2`)).rows;

  // Dados de teste
  const tecs = [['TESTE ORD Beta', 'ERP', 'Zeta'], ['TESTE ORD Alfa', 'BI', 'Yota'], ['TESTE ORD Gama', 'ERP', 'Xis']];
  for (const [nome, categoria, fabricante] of tecs) {
    await pool.query(`INSERT INTO tecnologias (empresa_id, nome, categoria, fabricante, status, ativo) VALUES (1, $1, $2, $3, 'ativo', TRUE)`, [nome, categoria, fabricante]);
  }
  for (const [titulo, prioridade] of [['TESTE ORD baixa', 'baixa'], ['TESTE ORD critica', 'critica'], ['TESTE ORD media', 'media']]) {
    await pool.query(`INSERT INTO chamados (empresa_id, cliente_id, titulo, prioridade, status, ativo) VALUES (1, $1, $2, $3, 'aberto', TRUE)`, [cli.id, titulo, prioridade]);
  }
  const mes = new Date().toISOString().slice(0, 7);
  for (const [descricao, valor, c] of [['TESTE ORD Luz', 300, cat[0].id], ['TESTE ORD Agua', 80, cat[1].id], ['TESTE ORD Net', 150, cat[0].id]]) {
    await pool.query(`INSERT INTO contas_pagar (empresa_id, categoria_id, descricao, valor, competencia, data_vencimento, status)
                      VALUES (1, $1, $2, $3, $4::date, $4::date + 9, 'aberta')`, [c, descricao, valor, `${mes}-01`]);
  }

  const token = jwt.sign({ id: u.id, tipo: u.tipo, empresa_id: u.empresa_id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const perfil = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORTA}`, `--user-data-dir=${perfil}`,
    '--window-size=1366,1000', 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 40 && !alvo; i++) {
    await espera(250);
    try { alvo = (await (await fetch(`http://127.0.0.1:${PORTA}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pend = new Map(); const errosJs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errosJs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  });
  const cmd = (method, params = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const js = async expr => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

  try {
    await cmd('Runtime.enable');
    await cmd('Page.navigate', { url: 'http://localhost:3000/login.html' });
    await espera(1200);
    await js(`localStorage.clear(); localStorage.setItem('token', ${JSON.stringify(token)}); localStorage.setItem('usuario', ${JSON.stringify(JSON.stringify(u))});`);
    await cmd('Page.navigate', { url: 'http://localhost:3000/dashboard.html' });
    await espera(2500);

    const nomes = (tbody, col = 0) => js(`[...document.querySelectorAll('#${tbody} tr:not(.linha-oculta)')].map(tr => tr.cells[${col}].textContent.trim().split('\\n')[0].trim()).filter(t => t.startsWith('TESTE ORD'))`);
    const clicar = (pagina, col) => js(`document.querySelectorAll('#${pagina}-page th .th-ordenar')[${col}].click()`);

    // ----- Tecnologias: cabeçalho, filtro por coluna e busca -----
    await js(`showPage('tecnologias')`); await espera(1500);
    await clicar('tecnologias', 0); await espera(200);
    ok(igual(await nomes('tecnologias-tbody'), ['TESTE ORD Alfa', 'TESTE ORD Beta', 'TESTE ORD Gama']), 'tecnologias: Nome ↑');
    await clicar('tecnologias', 0); await espera(200);
    ok(igual(await nomes('tecnologias-tbody'), ['TESTE ORD Gama', 'TESTE ORD Beta', 'TESTE ORD Alfa']), 'tecnologias: Nome ↓');
    ok(await js(`document.querySelector('#tecnologias-page th[aria-sort]').getAttribute('aria-sort') === 'descending'`), 'aria-sort no cabeçalho');
    await js(`(() => { const s = [...document.querySelectorAll('#tecnologias-page .filtros-bar select')].find(s => s.getAttribute('aria-label') === 'Filtrar por Categoria');
      s.value = 'erp'; s.dispatchEvent(new Event('change')); })()`); await espera(200);
    ok(igual(await nomes('tecnologias-tbody'), ['TESTE ORD Gama', 'TESTE ORD Beta']), 'tecnologias: filtro Categoria = ERP');
    await js(`(() => { const b = document.querySelector('#tecnologias-page .filtro-busca'); b.value = 'yota'; b.dispatchEvent(new Event('input')); })()`);
    await espera(400);
    ok((await nomes('tecnologias-tbody')).length === 0 && await js(`!!document.querySelector('#tecnologias-tbody .linha-sem-resultado')`), 'busca + filtro sem resultado mostra aviso');
    await js(`(() => { const s = [...document.querySelectorAll('#tecnologias-page .filtros-bar select')].find(s => s.getAttribute('aria-label') === 'Filtrar por Categoria');
      s.value = ''; s.dispatchEvent(new Event('change')); })()`); await espera(200);
    ok(igual(await nomes('tecnologias-tbody'), ['TESTE ORD Alfa']), 'busca "yota" acha pelo fabricante');
    // Recarregar a página mantém a ordem (o tbody é redesenhado e a ordem é reaplicada)
    await js(`document.querySelector('#tecnologias-page .filtro-busca').value = ''; loadTecnologias()`); await espera(1200);
    ok(igual(await nomes('tecnologias-tbody'), ['TESTE ORD Gama', 'TESTE ORD Beta', 'TESTE ORD Alfa']), 'ordem reaplicada depois de recarregar');
    await clicar('tecnologias', 0); await espera(200); // volta à ordem padrão

    // ----- Chamados: ordenação feita pela API (lista paginada) -----
    await js(`showPage('chamados')`); await espera(1500);
    await clicar('chamados', 5); await espera(1500); // Prioridade ↑ = crítica primeiro
    ok(igual(await nomes('chamados-tbody', 1), ['TESTE ORD critica', 'TESTE ORD media', 'TESTE ORD baixa']), 'chamados: Prioridade pela API');
    await clicar('chamados', 5); await espera(1500);
    ok(igual(await nomes('chamados-tbody', 1), ['TESTE ORD baixa', 'TESTE ORD media', 'TESTE ORD critica']), 'chamados: Prioridade invertida');
    await clicar('chamados', 5); await espera(1200);

    // ----- Contas a pagar: Valor -----
    await js(`showPage('contas-pagar')`); await espera(1800);
    const colValor = await js(`[...document.querySelectorAll('#contas-pagar-page thead th')].findIndex(th => /valor/i.test(th.textContent))`);
    await clicar('contas-pagar', colValor); await espera(200);
    ok(igual(await nomes('contas-pagar-tbody'), ['TESTE ORD Agua', 'TESTE ORD Net', 'TESTE ORD Luz']), 'contas a pagar: Valor ↑ (R$ reconhecido)');
    await clicar('contas-pagar', colValor); await clicar('contas-pagar', colValor); await espera(200);

    // ----- Visão mensal: busca, ordenação por total e por mês -----
    await js(`showPage('visao-mensal')`); await espera(2000);
    const linhasVm = () => js(`[...document.querySelectorAll('#vm-tabela .vm-item-nome')].map(e => e.textContent.trim()).filter(t => t.startsWith('TESTE ORD'))`);
    await js(`(() => { const b = document.getElementById('vm-busca'); b.value = 'teste ord'; b.dispatchEvent(new Event('input')); })()`); await espera(400);
    ok((await linhasVm()).length === 3 && await js(`document.querySelectorAll('#vm-tabela .vm-secao-receita').length === 0`), 'visão mensal: busca filtra lançamentos e receitas');
    await js(`document.getElementById('vm-ordem').value = 'total_desc'; vmMudarOrdem()`);
    ok(igual(await linhasVm(), ['TESTE ORD Luz', 'TESTE ORD Net', 'TESTE ORD Agua']), 'visão mensal: maior total');
    await js(`vmOrdenarMes(_vm.meses[0]); vmOrdenarMes(_vm.meses[0])`); // mês: maior → menor
    ok(igual(await linhasVm(), ['TESTE ORD Agua', 'TESTE ORD Net', 'TESTE ORD Luz']), 'visão mensal: clique no mês (menor primeiro)');
    // O clique na célula abre o lançamento certo mesmo com a ordem trocada
    const aberto = await js(`(async () => { let id = null; const orig = editarConta; editarConta = x => { id = x; };
      document.querySelector('#vm-tabela tbody tr:not(.vm-secao) td.vm-cel button').click(); editarConta = orig; return id; })()`);
    const idAgua = (await pool.query(`SELECT id FROM contas_pagar WHERE descricao = 'TESTE ORD Agua'`)).rows[0].id;
    ok(aberto === idAgua, `visão mensal: clique na célula abre a conta certa (${aberto} = ${idAgua})`);
    await js(`document.getElementById('vm-categoria').value = document.getElementById('vm-categoria').options[1].value; renderVisaoMensal()`);
    ok((await linhasVm()).length < 3, 'visão mensal: filtro por categoria');

    // Seções recolhíveis: as linhas somem, o total da seção fica; a escolha sobrevive ao recarregar
    await js(`document.getElementById('vm-categoria').value = ''; renderVisaoMensal()`);
    await js(`document.querySelector('#vm-tabela .vm-secao .vm-secao-toggle').click()`);
    ok((await linhasVm()).length === 0 && await js(`document.querySelector('#vm-tabela .vm-secao .vm-secao-toggle').getAttribute('aria-expanded') === 'false'`),
      'visão mensal: seção recolhida esconde as linhas');
    ok(await js(`/R\\$/.test(document.querySelector('#vm-tabela .vm-secao').textContent)`), 'visão mensal: total da seção recolhida continua');
    await js(`loadVisaoMensal()`); await espera(1500);
    ok((await linhasVm()).length === 0, 'visão mensal: seção continua recolhida depois de recarregar');
    await js(`document.querySelector('#vm-tabela .vm-secao .vm-secao-toggle').click()`);
    ok((await linhasVm()).length === 3, 'visão mensal: expandir mostra as linhas de novo');
    await js(`vmAlternarTudo()`);
    ok((await linhasVm()).length === 0 && await js(`document.getElementById('vm-btn-tudo').textContent === 'Expandir tudo'`), 'visão mensal: recolher tudo');
    await js(`vmAlternarTudo()`);
    ok((await linhasVm()).length === 3, 'visão mensal: expandir tudo');

    ok(!errosJs.length, `sem erros de JavaScript${errosJs.length ? ': ' + errosJs.join(' | ') : ''}`);
  } finally {
    ws.close(); chrome.kill();
    await pool.query(`DELETE FROM tecnologias WHERE nome LIKE 'TESTE ORD%'`);
    await pool.query(`DELETE FROM chamados WHERE titulo LIKE 'TESTE ORD%'`);
    await pool.query(`DELETE FROM contas_pagar WHERE descricao LIKE 'TESTE ORD%'`);
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
