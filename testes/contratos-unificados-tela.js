require('./_ambiente-local');
// Telas dos contratos unificados no Chrome headless: + Novo contrato com escolha do tipo, formulário do Conector com
// preço por perfil e conta na hora, ficha do cliente (contratos juntos, cursos), contrato de cursos e a lista de Contratos.
// Salva capturas (desktop e celular) na pasta temporária; apaga os dados de teste no fim.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTA = 9335;
const espera = ms => new Promise(r => setTimeout(r, ms));
let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };

(async () => {
  const u = (await pool.query(`SELECT id, nome, email, tipo, empresa_id FROM usuarios WHERE tipo IN ('admin_sistema','admin_empresa') ORDER BY id LIMIT 1`)).rows[0];
  const sufixo = Date.now();
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ('TESTE Tela Contratos', 'TESTE TELA CONTRATOS LTDA', 'tela@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const curso = (await pool.query(`INSERT INTO cursos (empresa_id, titulo, status, ordem) VALUES (1, $1, 'publicado', 999) RETURNING id`, [`TESTE tela curso ${sufixo}`])).rows[0].id;

  const token = jwt.sign({ id: u.id, tipo: u.tipo, empresa_id: u.empresa_id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
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
  const foto = async nome => {
    const r = await cmd('Page.captureScreenshot', { format: 'png' });
    const arq = path.join(os.tmpdir(), `contratos-${nome}.png`);
    fs.writeFileSync(arq, Buffer.from(r.data, 'base64'));
    console.log('     captura:', arq);
  };
  const visivel = id => js(`document.getElementById('${id}').classList.contains('show')`);
  let kid = null;

  try {
    await cmd('Runtime.enable');
    await cmd('Page.navigate', { url: 'http://localhost:3000/login.html' });
    await espera(1200);
    await js(`localStorage.clear(); localStorage.setItem('token', ${JSON.stringify(token)}); localStorage.setItem('usuario', ${JSON.stringify(JSON.stringify(u))});`);
    await cmd('Page.navigate', { url: 'http://localhost:3000/dashboard.html' });
    await espera(2500);
    await js(`window.alert = m => { window._ultimoAlerta = m; }; window.confirm = m => { window._ultimoConfirm = m; return true; };`);

    // Menu: "Contratos por vagas" saiu; Contratos tem um botão só
    ok(!(await js(`!!document.querySelector('.nav-link[data-page="contratos-conector"]')`)), 'menu sem "Contratos por vagas"');
    await js(`showPage('contratos')`); await espera(1200);
    ok((await js(`document.querySelector('#contratos-page .page-header button').textContent.trim()`)) === '+ Novo contrato', 'Contratos: botão "+ Novo contrato"');

    // Escolha do tipo
    await js(`novoContrato(${cli})`); await espera(300);
    ok(await visivel('modal-tipo-contrato'), 'abre a escolha do tipo');
    ok((await js(`document.querySelectorAll('.tipo-contrato-opcao').length`)) === 3, 'três tipos: serviço, Conector e cursos');
    await foto('1-tipo');

    // Conector: preço por perfil e conta na hora
    await js(`escolherTipoContrato('conector')`); await espera(1500);
    ok(await visivel('modal-novo-contrato-conector') && !(await visivel('modal-tipo-contrato')), 'tipo Conector abre o formulário de licenças');
    ok((await js(`document.getElementById('form-novo-contrato-conector').cliente_id.value`)) === String(cli), 'cliente já escolhido');
    ok(Number(await js(`document.getElementById('form-novo-contrato-conector').preco_abap.value`)) > 0, 'preço ABAP preenchido pela tabela');
    await js(`(() => { const f = document.getElementById('form-novo-contrato-conector');
      f.abap.value = 2; f.abap.dispatchEvent(new Event('input'));
      f.preco_abap.value = 650; f.preco_abap.dispatchEvent(new Event('input'));
      f.gestor_email.value = 'gestor-tela-${sufixo}@teste.com'; f.gestor_nome.value = 'Gestor Tela'; })()`);
    await espera(200);
    const totalAbap = await js(`document.getElementById('ncc-total-abap').textContent`);
    ok(/2 × R\$\s?650,00 × 12/.test(totalAbap) && /15\.600,00/.test(totalAbap), `total do perfil na hora (${totalAbap.replace(/\s+/g, ' ')})`);
    ok(/desconto|acima/.test(await js(`document.getElementById('ncc-lista-abap').textContent`)), 'mostra a diferença para o preço de lista');
    ok(/Valor anual: R\$\s?15\.600,00/.test(await js(`document.getElementById('ncc-preco-hint').textContent`)), 'valor anual explicado no fim');
    await foto('2-conector');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await espera(400);
    await foto('3-conector-celular');
    ok(await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'celular: sem rolagem para o lado');
    await cmd('Emulation.clearDeviceMetricsOverride'); await espera(300);

    await js(`salvarNovoContratoConector()`); await espera(2500);
    const k = (await pool.query('SELECT id, precos FROM contratos_conector WHERE cliente_id = $1', [cli])).rows[0];
    kid = k && k.id;
    ok(k && k.precos.abap === 650, 'salvou com o preço negociado');
    ok(!(await visivel('modal-novo-contrato-conector')), 'formulário fecha depois de salvar');

    // Lista de Contratos e tela do contrato
    await js(`showPage('contratos')`); await espera(1500);
    ok((await js(`document.getElementById('contratos-tbody').textContent`)).includes('Licenças do Conector'), 'Contratos lista o contrato de licenças');
    await js(`abrirContratoConector(${kid})`); await espera(1500);
    ok((await js(`document.querySelectorAll('#contrato-conector-precos input').length`)) === 3, 'contrato aberto: preço por perfil editável');
    await foto('4-contrato-aberto');
    await js(`closeModal(document.getElementById('modal-contrato-conector'))`);

    // Ficha do cliente
    await js(`abrirFichaCliente(${cli})`); await espera(2000);
    const ficha = await js(`document.getElementById('ficha-corpo').textContent`);
    ok(ficha.includes('Licenças do Conector') && ficha.includes('+ Novo contrato'), 'ficha: contrato de licenças na caixa Contratos');
    ok(ficha.includes('+ Liberar cursos para a empresa'), 'ficha: botão de liberar cursos');
    await foto('5-ficha');

    // Contrato de cursos a partir da ficha
    await js(`fichaNovoContratoCursos()`); await espera(1500);
    ok(await visivel('modal-contrato-cursos'), 'abre o contrato de cursos');
    ok(await js(`!!document.querySelector('#cc-cursos input[value="${curso}"]')`), 'lista o curso para marcar');
    await js(`document.querySelector('#cc-cursos input[value="${curso}"]').checked = true`);
    await foto('6-cursos');
    await js(`salvarContratoCursos()`); await espera(2500);
    ok((await pool.query('SELECT 1 FROM cursos_liberacoes WHERE cliente_id = $1 AND curso_id = $2 AND contrato_cursos_id IS NOT NULL', [cli, curso])).rows.length === 1,
      'cortesia salva: curso liberado para a empresa');
    await espera(500);
    ok(await visivel('modal-ficha-cliente'), 'ao salvar, a ficha volta');
    ok((await js(`document.getElementById('ficha-corpo').textContent`)).includes('Cursos para a empresa nº'), 'ficha mostra o contrato de cursos');

    ok(errosJs.length === 0, `sem erros de JavaScript${errosJs.length ? ': ' + errosJs.join(' | ') : ''}`);
  } finally {
    ws.close(); chrome.kill();
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(r => r.id);
    await pool.query('DELETE FROM direitos_acesso WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM matriculas WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_liberacoes WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM faturas WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos_cursos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id IN (SELECT id FROM contratos_conector WHERE cliente_id = $1)', [cli]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM clientes_admins WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM cursos WHERE id = $1', [curso]).catch(() => {});
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]).catch(err => console.log('(cliente de teste ficou:', err.message, ')'));
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
