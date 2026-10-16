require('./_ambiente-local');
// Screenshot do dashboard logado (Chrome headless + CDP).
// Uso: node testes/screenshot-dashboard.js <pagina> <largura> <tema> <saida.png> [js-depois]
//      ex.: relatorios 390 sereno rel.png        |  clientes 1366 sereno ficha.png "abrirFichaCliente(2)"
// Portal do cliente: pagina = portal (entra como usuário cliente; SCREENSHOT_CLIENTE_ID escolhe a empresa,
//      senão o primeiro usuário cliente ativo; SCREENSHOT_USUARIO_ID escolhe o usuário). ex.: portal 390 sereno portal.png "abrirDetalhe(12)"
const { spawn } = require('child_process');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');

const [pagina, largura, tema, saida, depois] = process.argv.slice(2);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTA = 9333;
const espera = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const portal = pagina === 'portal';
  const u = portal
    ? (await pool.query(`SELECT id, nome, email, tipo, empresa_id, cliente_id FROM usuarios
                         WHERE tipo = 'cliente' AND ativo = TRUE AND ($1::int IS NULL OR cliente_id = $1)
                           AND ($2::int IS NULL OR id = $2) ORDER BY id LIMIT 1`,
                        [process.env.SCREENSHOT_CLIENTE_ID || null, process.env.SCREENSHOT_USUARIO_ID || null])).rows[0]
    : (await pool.query(`SELECT id, nome, email, tipo, empresa_id FROM usuarios WHERE tipo IN ('admin_sistema','admin_empresa') ORDER BY id LIMIT 1`)).rows[0];
  await pool.end();
  const token = jwt.sign({ id: u.id, tipo: u.tipo, empresa_id: u.empresa_id, ...(portal ? { cliente_id: u.cliente_id } : {}) },
    process.env.JWT_SECRET, { expiresIn: '10m' });
  const usuario = { ...u, tema };

  const perfil = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORTA}`, `--user-data-dir=${perfil}`,
    `--window-size=${largura},1000`, 'about:blank'], { stdio: 'ignore' });
  let alvo;
  for (let i = 0; i < 40 && !alvo; i++) {
    await espera(250);
    try { alvo = (await (await fetch(`http://127.0.0.1:${PORTA}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pend = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const cmd = (method, params = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const avaliar = expr => cmd('Runtime.evaluate', { expression: expr, awaitPromise: true });

  await cmd('Emulation.setDeviceMetricsOverride', { width: Number(largura), height: 1000, deviceScaleFactor: 1, mobile: Number(largura) < 600 });
  await cmd('Page.navigate', { url: 'http://localhost:3000/login.html' });
  await espera(1200);
  await avaliar(`localStorage.setItem('token', ${JSON.stringify(token)}); localStorage.setItem('usuario', ${JSON.stringify(JSON.stringify(usuario))}); localStorage.setItem('marsh.theme', ${JSON.stringify(tema)});`);
  await cmd('Page.navigate', { url: `http://localhost:3000/${portal ? 'portal' : 'dashboard'}.html` });
  await espera(2500);
  if (!portal) {
    await avaliar(`showPage(${JSON.stringify(pagina)})`);
    await espera(2500);
  }
  if (depois) { await avaliar(depois); await espera(2500); }
  const altura = (await avaliar(`Math.min(document.documentElement.scrollHeight, 4000)`)).result.value;
  await cmd('Emulation.setDeviceMetricsOverride', { width: Number(largura), height: altura, deviceScaleFactor: 1, mobile: Number(largura) < 600 });
  await espera(800);
  const erros = (await avaliar(`JSON.stringify([...document.querySelectorAll('.fin-muted')].map(e => e.textContent).filter(t => /erro/i.test(t)))`)).result.value;
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(saida, Buffer.from(shot.data, 'base64'));
  console.log('ok', saida, 'altura', altura, 'erros', erros);
  ws.close(); chrome.kill();
})().catch(e => { console.error(e); process.exit(1); });
