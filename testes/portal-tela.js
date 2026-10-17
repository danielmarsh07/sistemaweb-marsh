require('./_ambiente-local');
// Portal do cliente no Chrome headless: cria uma empresa de exemplo (contrato do Conector, administrador, pessoa com
// licença, curso, chamado e fatura), entra como administrador e como pessoa com licença, percorre as telas do menu
// no computador e no celular (440px, iPhone), confere que não há erro de JavaScript nem rolagem para o lado e salva
// capturas na pasta temporária. Apaga tudo no fim.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { ativarConvites } = require('../backend/services/contratos-conector');
const { incluirNoBeneficioPelaTrilha } = require('../backend/services/acessos');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTA = 9336;
const BASE = 'http://localhost:3000';
const espera = ms => new Promise(r => setTimeout(r, ms));
let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '15m' });
const SO_FOTOS = process.argv.includes('--antes'); // só fotografa (portal antigo, antes da troca de layout)

(async () => {
  const sufixo = Date.now();
  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
  const api = async (t, p, m = 'GET', body) => {
    const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ('TESTE Portal', 'TESTE PORTAL LTDA', 'portal@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const curso = (await pool.query(`INSERT INTO cursos (empresa_id, titulo, status, trilha, ordem, descricao) VALUES (1, $1, 'publicado', 'abap', 990, 'Curso de exemplo do portal') RETURNING id`,
    [`TESTE portal curso ${sufixo}`])).rows[0].id;
  await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, 'Aula 1', 0), ($1, 'Aula 2', 1)`, [curso]);
  await incluirNoBeneficioPelaTrilha(curso, 'abap');
  const fimAno = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const k = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'Gestora Portal', gestor_email: `gestora-portal-${sufixo}@teste.com`,
    vagas: { abap: 2, funcional: 1 }, data_fim: fimAno, cobranca: { gerar: true } });
  const gestor = (await pool.query('SELECT id, nome, email FROM usuarios WHERE email = $1', [`gestora-portal-${sufixo}@teste.com`])).rows[0];
  const vaga = (await api(tokAdmin, `/contratos-conector/${k.body.id}`)).body.vagas.find(v => v.perfil === 'abap');
  await api(tokAdmin, `/contratos-conector/${k.body.id}/vagas/${vaga.id}/ocupar`, 'POST', { nome: 'Pedro Licença', email: `pedro-portal-${sufixo}@teste.com` });
  const aluno = (await pool.query('SELECT id, nome, email FROM usuarios WHERE email = $1', [`pedro-portal-${sufixo}@teste.com`])).rows[0];
  await ativarConvites(aluno.id);
  const tokGestor = tok({ id: gestor.id, tipo: 'cliente', cliente_id: cli });
  await api(tokGestor, '/chamados', 'POST', { titulo: 'Erro ao ativar o Conector na máquina nova', prioridade: 'alta', descricao: 'Aparece erro de chave.' });
  await pool.query(`INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, status)
    VALUES (1, $1, date_trunc('month', CURRENT_DATE), 'Licenciamento anual do Conector SAP Marsh', 1200, CURRENT_DATE + 10, 'aberta')`, [cli]);

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORTA}`, `--user-data-dir=${perfil}`,
    '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' });
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
  const foto = async (nome, inteira = false) => {
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: inteira });
    const arq = path.join(os.tmpdir(), `portal-${nome}.png`);
    fs.writeFileSync(arq, Buffer.from(r.data, 'base64'));
    console.log('     captura:', arq);
  };
  const celular = on => on
    ? cmd('Emulation.setDeviceMetricsOverride', { width: 440, height: 956, deviceScaleFactor: 1, mobile: true })
    : cmd('Emulation.clearDeviceMetricsOverride');
  const semRolagemLateral = () => js(`document.documentElement.scrollWidth <= window.innerWidth + 1`);

  const entrar = async (u, papelNome) => {
    await cmd('Page.navigate', { url: `${BASE}/login.html` }); await espera(800);
    const usuario = { id: u.id, nome: u.nome, email: u.email, tipo: 'cliente', cliente_id: cli, empresa_id: 1, empresa_nome: 'TESTE PORTAL LTDA' };
    await js(`localStorage.clear(); localStorage.setItem('token', ${JSON.stringify(tok({ id: u.id, tipo: 'cliente', cliente_id: cli }))});
      localStorage.setItem('usuario', ${JSON.stringify(JSON.stringify(usuario))});`);
    await cmd('Page.navigate', { url: `${BASE}/portal.html` }); await espera(2500);
    console.log(`--- ${papelNome}`);
  };
  // Telas do menu visíveis para quem entrou (portal novo); o antigo é uma página só
  const telas = () => js(`[...document.querySelectorAll('.sidebar .nav-link[data-page]')].filter(l => !l.hidden && l.offsetParent !== null).map(l => l.dataset.page)`);

  try {
    await cmd('Runtime.enable');
    for (const [u, papel] of [[gestor, 'gestor'], [aluno, 'licenca']]) {
      await entrar(u, papel);
      if (SO_FOTOS) {
        await foto(`antes-${papel}-desktop`, true);
        await celular(true); await espera(400);
        await foto(`antes-${papel}-celular`, true);
        ok(await semRolagemLateral(), `${papel}: celular sem rolagem para o lado`);
        await celular(false);
        continue;
      }
      const lista = await telas();
      ok(lista.length > 0, `${papel}: menu com ${lista.length} tela(s): ${lista.join(', ')}`);
      // Janelas do portal abrem por cima do menu lateral e da barra de baixo
      const janelas = papel === 'gestor' ? [['abrirModalNovoChamado()', 'modal-novo-chamado'], ['abrirAparencia()', 'modal-aparencia']]
        : [[`abrirCurso(${curso})`, 'modal-curso']];
      for (const [abrir, id] of janelas) {
        await js(abrir); await espera(800);
        ok(await js(`(() => { const m = document.querySelector('#${id} .modal-box'); const r = m.getBoundingClientRect();
          return m.contains(document.elementFromPoint(r.left + 20, r.top + 20)) && m.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()`),
          `${papel}: janela ${id} abre por cima de tudo`);
        await foto(`${papel}-${id}`);
        await js(`document.getElementById('${id}').classList.remove('show')`);
      }
      for (const t of lista) {
        await js(`mostrarTela('${t}')`); await espera(700);
        ok(await js(`document.getElementById('${t}-page').classList.contains('active')`), `${papel}: abre "${t}"`);
        await foto(`${papel}-${t}`);
      }
      // Tema escuro (o mesmo do sistema)
      await js(`window.Theme && Theme.set('sereno-escuro')`); await espera(500);
      await js(`mostrarTela('${lista[lista.length - 1]}')`); await espera(500);
      await foto(`${papel}-escuro`);
      await js(`window.Theme && Theme.set('sereno')`); await espera(300);
      await celular(true); await espera(400);
      for (const t of lista) {
        await js(`mostrarTela('${t}')`); await espera(500);
        ok(await semRolagemLateral(), `${papel} celular: "${t}" sem rolagem para o lado`);
        await foto(`${papel}-${t}-celular`);
      }
      ok(await js(`getComputedStyle(document.querySelector('.bottom-nav')).display !== 'none'`), `${papel} celular: barra de baixo visível`);
      await js(`document.getElementById('btn-menu-mobile').click()`); await espera(500);
      ok(await js(`!document.getElementById('menu-mobile').hidden && document.querySelectorAll('#menu-mobile-corpo .menu-mobile-item').length === ${lista.length}`),
        `${papel} celular: menu com todas as telas`);
      await foto(`${papel}-menu-celular`);
      await js(`fecharMenuMobile()`);
      await celular(false); await espera(300);
    }
    // Quem só usa licença não vê chamados nem financeiro
    if (!SO_FOTOS) {
      const lista = await telas();
      ok(!lista.includes('chamados') && !lista.includes('financeiro'), 'pessoa com licença: sem chamados e financeiro no menu');
    }
    ok(errosJs.length === 0, `sem erros de JavaScript${errosJs.length ? ': ' + errosJs.join(' | ') : ''}`);
  } finally {
    ws.close(); chrome.kill();
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(r => r.id);
    await pool.query('DELETE FROM direitos_acesso WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM matriculas WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM atendimentos WHERE chamado_id IN (SELECT id FROM chamados WHERE cliente_id = $1)', [cli]).catch(() => {});
    await pool.query('DELETE FROM chamados WHERE cliente_id = $1', [cli]).catch(e => console.log('(chamado ficou:', e.message, ')'));
    await pool.query('DELETE FROM faturas WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM licencas WHERE cliente_id = $1', [cli]).catch(() => {});
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id IN (SELECT id FROM contratos_conector WHERE cliente_id = $1)', [cli]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM clientes_admins WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]).catch(e => console.log('(usuários ficaram:', e.message, ')'));
    await pool.query('DELETE FROM beneficios WHERE curso_id = $1', [curso]).catch(() => {});
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = $1', [curso]);
    await pool.query('DELETE FROM cursos WHERE id = $1', [curso]).catch(() => {});
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]).catch(err => console.log('(cliente de teste ficou:', err.message, ')'));
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
