require('./_ambiente-local');
// Simulador de preço do Conector SAP (Comercial): cálculo puro, rota /calcular, validações, tabela de preços
// editável e "Gerar proposta" (cria a proposta na oportunidade e abre a página de impressão no Chrome headless).
// Uso: node testes/simulador-conector.js [saida.pdf]   (PDF de exemplo opcional; por padrão vai para a pasta temporária)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const conector = require('../backend/services/precificacao-conector');

const BASE = 'http://localhost:3000/api';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORTA = 9335;
const SAIDA_PDF = process.argv[2] || path.join(os.tmpdir(), 'proposta-conector-sap.pdf');
const espera = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);

(async () => {
  const u = (await pool.query(`SELECT id, nome, email, tipo, empresa_id FROM usuarios WHERE tipo IN ('admin_sistema','admin_empresa') ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: u.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const tokenTecnico = jwt.sign({ id: u.id, tipo: 'tecnico', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, body, tk = token) => {
    const r = await fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) console.log('  !', m, p, r.status, j.erro || j);
    return { status: r.status, ...j };
  };
  const calc = b => api('POST', '/comercial/simulador-conector/calcular', b);
  const criados = { oport: [] };
  // Guarda a tabela de preços atual para restaurar no fim
  const precosOriginais = (await pool.query('SELECT prop_precos_conector FROM financeiro_config WHERE empresa_id = 1')).rows[0];

  try {
    // 1. Função pura (sem servidor)
    const pura = b => conector.calcular(conector.validarEntradas(b).entradas);
    const p1 = pura({ funcionais: 3, abaps: 2, ciclo: 'anual', modalidade: 'individual', porte: 'nenhum' });
    ok(p1.totais.mensal_cheio === 2750 && p1.totais.total_unico === 0, `pura: 3 funcionais + 2 ABAPs anual individual = ${p1.totais.mensal_cheio}`);
    ok(conector.validarEntradas({ funcionais: -1 }).erro, 'pura: valida negativo');

    // 2. Rota: casos conhecidos
    const c1 = await calc({ funcionais: 3, abaps: 2, ciclo: 'anual', modalidade: 'individual', porte: 'nenhum' });
    ok(c1.totais && c1.totais.mensal_cheio === 2750 && c1.itens.length === 2, `3F + 2A anual individual = R$ ${c1.totais && c1.totais.mensal_cheio}/mês`);
    const c1m = await calc({ funcionais: 3, abaps: 2, ciclo: 'mensal', modalidade: 'individual', porte: 'nenhum' });
    ok(c1m.totais.mensal_cheio === 3 * 490 + 2 * 990, `3F + 2A mensal individual = ${c1m.totais.mensal_cheio}`);
    const c2 = await calc({ funcionais: 3, abaps: 2, ciclo: 'anual', modalidade: 'empresa', porte: 'nenhum' });
    ok(c2.totais.mensal_cheio === 3500 && c2.itens.length === 1, `Empresa 5 usuários = ${c2.totais.mensal_cheio}`);
    const c3 = await calc({ funcionais: 8, abaps: 4, ciclo: 'anual', modalidade: 'empresa', porte: 'nenhum' });
    ok(c3.totais.mensal_cheio === 6900 && c3.itens.some(i => i.quantidade === 2 && i.valor_unitario === 450), `Empresa 12 usuários = ${c3.totais.mensal_cheio} (6.000 + 2 × 450)`);
    const c4 = await calc({ funcionais: 3, abaps: 2, modalidade: 'automatico', porte: 'nenhum' });
    ok(c4.modalidade_escolhida === 'individual' && c4.comparacao.individual === 2750 && c4.comparacao.empresa === 3500,
      `automático escolhe Individual (2.750 < 3.500)`);
    const c5 = await calc({ funcionais: 0, abaps: 5, modalidade: 'automatico', porte: 'nenhum' });
    ok(c5.modalidade_escolhida === 'empresa' && c5.totais.mensal_cheio === 3500 && c5.comparacao.individual === 3950,
      `automático escolhe Empresa (3.500 < 3.950)`);
    const c6 = await calc({ funcionais: 1, abaps: 0, porte: 'medio', sistemas: 2 });
    ok(c6.totais.total_unico === 17000, `implantação Médio + 2 sistemas = ${c6.totais.total_unico}`);
    const c6b = await calc({ funcionais: 1, porte: 'grande', sistemas: 4 });
    ok(c6b.totais.total_unico === 31000, `implantação Grande + 4 sistemas = ${c6b.totais.total_unico}`);

    // Desconto
    const d1 = await calc({ funcionais: 3, abaps: 2, ciclo: 'anual', modalidade: 'individual', porte: 'nenhum', desconto_pct: 50, desconto_meses: 12 });
    ok(d1.totais.mensal_desconto === 1375 && d1.totais.mensal_cheio === 2750 && d1.totais.primeiro_ano === 16500,
      `desconto 50% por 12 meses: ${d1.totais.mensal_desconto}/mês, 1º ano ${d1.totais.primeiro_ano}`);
    const d2 = await calc({ funcionais: 3, abaps: 2, modalidade: 'individual', porte: 'medio', desconto_pct: 50, desconto_meses: 6 });
    ok(d2.totais.primeiro_ano === 1375 * 6 + 2750 * 6 + 15000 && d2.totais.total_unico === 15000,
      `desconto 6 meses + implantação cheia: 1º ano ${d2.totais.primeiro_ano}`);
    const d3 = await calc({ funcionais: 3, abaps: 2, modalidade: 'individual', porte: 'medio', desconto_pct: 50, desconto_meses: 12, desconto_implantacao: true });
    ok(d3.totais.total_unico === 7500 && d3.totais.unico_cheio === 15000, `desconto na implantação: ${d3.totais.total_unico}`);

    // Chamados e pacote (desconto não se aplica a serviços)
    const s1 = await calc({ funcionais: 3, abaps: 2, modalidade: 'individual', porte: 'nenhum', chamados_p: 2, chamados_m: 1, chamados_g: 1, desconto_pct: 50, desconto_meses: 12 });
    ok(s1.totais.servicos_mensal === 2 * 1500 + 4000 + 9000 && s1.totais.mensal_desconto === 1375 + 16000
      && s1.itens.filter(i => /estimativa/.test(i.descricao)).length === 3, `chamados P2 M1 G1 = ${s1.totais.servicos_mensal}/mês (estimativa)`);
    const s2 = await calc({ funcionais: 3, abaps: 2, modalidade: 'individual', porte: 'nenhum', pacotes: 2 });
    ok(s2.totais.servicos_mensal === 15000 && s2.totais.mensal_cheio === 17750, `2 pacotes de sustentação = ${s2.totais.servicos_mensal}/mês`);

    // ROI
    const r1 = await calc({ funcionais: 3, abaps: 2, modalidade: 'individual', porte: 'medio', sistemas: 1 });
    ok(r1.roi && r1.roi.economia_mensal === 3 * 6 * 150 + 2 * 10 * 160 && r1.roi.payback_meses === Math.ceil(15000 / (5900 - 2750)),
      `ROI padrão: economia ${r1.roi && r1.roi.economia_mensal}/mês, payback ${r1.roi && r1.roi.payback_meses} meses`);
    const r2 = await calc({ funcionais: 3, abaps: 2, porte: 'nenhum', roi_horas_funcional: 0, roi_horas_abap: 0 });
    ok(r2.roi === null, 'ROI zerado = sem bloco de ROI');

    // 3. Validações (400)
    const invalidos = [
      [{ funcionais: -1, abaps: 2 }, 'funcionais negativo'],
      [{ funcionais: 1.5, abaps: 2 }, 'funcionais fracionado'],
      [{ funcionais: 0, abaps: 0 }, 'nenhum usuário'],
      [{ funcionais: 1, desconto_pct: 150, desconto_meses: 12 }, 'desconto > 100'],
      [{ funcionais: 1, desconto_pct: 10, desconto_meses: 0 }, 'desconto sem meses'],
      [{ funcionais: 1, ciclo: 'semanal' }, 'ciclo inválido'],
      [{ funcionais: 1, modalidade: 'xpto' }, 'modalidade inválida'],
      [{ funcionais: 1, porte: 'gigante' }, 'porte inválido'],
      [{ funcionais: 1, sistemas: 0 }, 'sistemas = 0'],
      [{ funcionais: 1, chamados_p: 1, pacotes: 1 }, 'chamados e pacote ao mesmo tempo'],
      [{ funcionais: 1, validade_dias: 0 }, 'validade 0'],
      [{ funcionais: 1, roi_custo_abap: -5 }, 'custo/hora negativo']
    ];
    for (const [b, nome] of invalidos) {
      const r = await calc(b);
      ok(r.status === 400 && r.erro, `400: ${nome}`);
    }
    const tec = await api('POST', '/comercial/simulador-conector/calcular', { funcionais: 1 }, tokenTecnico);
    ok(tec.status === 403, 'técnico não acessa o simulador (comercial é só de administradores)');

    // 4. Tabela de preços editável
    const cfg = await api('GET', '/comercial/simulador-conector/config');
    ok(cfg.precos && cfg.padrao.leitura_anual === 390 && cfg.rotulos.leitura_anual, 'config devolve preços, padrão e rótulos');
    const cfgRuim = await api('PUT', '/comercial/simulador-conector/config', { precos: { ...cfg.precos, leitura_anual: -10 } });
    ok(cfgRuim.status === 400, 'preço negativo recusado');
    const cfgOk = await api('PUT', '/comercial/simulador-conector/config', { precos: { ...conector.PRECOS_PADRAO, leitura_anual: 400 } });
    ok(cfgOk.precos && cfgOk.precos.leitura_anual === 400, 'preço salvo');
    const c7 = await calc({ funcionais: 3, abaps: 2, ciclo: 'anual', modalidade: 'individual', porte: 'nenhum' });
    ok(c7.totais.mensal_cheio === 3 * 400 + 2 * 790, `cálculo usa a tabela editada (${c7.totais.mensal_cheio})`);
    await api('PUT', '/comercial/simulador-conector/config', { precos: conector.PRECOS_PADRAO });

    // 5. Gerar proposta na oportunidade (endpoint existente de propostas)
    const o = await api('POST', '/comercial/oportunidades', { titulo: 'TESTE Conector SAP', empresa_nome: 'TESTE Indústria Alfa', contato_nome: 'Joana',
      contato_email: 'joana@exemplo.com', origem: 'indicacao' });
    criados.oport.push(o.id);
    const entradas = { funcionais: 3, abaps: 2, ciclo: 'anual', modalidade: 'automatico', sistemas: 2, porte: 'medio',
      chamados_p: 1, chamados_m: 1, desconto_pct: 50, desconto_meses: 12, validade_dias: 20 };
    const ruim = await api('POST', `/comercial/oportunidades/${o.id}/propostas`, { simulador_conector: { ...entradas, desconto_pct: 120 } });
    ok(ruim.status === 400, 'gerar proposta com entrada inválida dá 400');
    const qtd0 = (await pool.query('SELECT COUNT(*)::int n FROM propostas WHERE oportunidade_id = $1', [o.id])).rows[0].n;
    ok(qtd0 === 0, 'nada criado com entrada inválida');

    const gp = await api('POST', `/comercial/oportunidades/${o.id}/propostas`, { simulador_conector: entradas, incluir_roi: true });
    ok(gp.id, 'proposta criada pelo simulador');
    const prop = await api('GET', `/comercial/propostas/${gp.id}`);
    // 1.375 (licenças com 50%) + 1.500 (P) + 4.000 (M) = 6.875/mês; 15.000 + 2.000 = 17.000 único
    ok(prop.total_mensal === 6875 && prop.total_unico === 17000, `totais da proposta: ${prop.total_mensal}/mês + ${prop.total_unico} único`);
    ok(prop.titulo === 'Conector SAP Marsh — TESTE Indústria Alfa', `título: ${prop.titulo}`);
    ok(prop.status === 'rascunho' && prop.itens.length === 6 && prop.itens.every(i => ['mensal', 'unico'].includes(i.tipo) && !('grupo' in i)),
      `itens no formato da proposta (${prop.itens.length})`);
    const somaMensal = prop.itens.filter(i => i.tipo === 'mensal').reduce((s, i) => s + i.total, 0);
    ok(Math.abs(somaMensal - prop.total_mensal) < 0.01, 'soma dos itens mensais = total mensal');
    ok(/Estimativa de retorno/.test(prop.introducao) && /Conector SAP Marsh liga/.test(prop.introducao), 'introdução com produto e ROI');
    ok(/S_DEVELOP/.test(prop.escopo) && /Cérebro inicial/.test(prop.escopo), 'escopo com o que a implantação inclui');
    ok(['IA (Claude', 'nunca em produção', 'Licença por máquina', 'LGPD', 'demanda aprovada', 'IPCA', 'vigência mínima de 12 meses', '1º ano']
      .every(t => prop.condicoes.includes(t)), 'condições com as premissas do conector');
    const hoje = new Date(); hoje.setDate(hoje.getDate() + 20);
    const esperada = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    ok(prop.validade === esperada, `validade de 20 dias (${prop.validade})`);
    const semRoi = await api('POST', `/comercial/oportunidades/${o.id}/propostas`, { simulador_conector: entradas, incluir_roi: false });
    const prop2 = await api('GET', `/comercial/propostas/${semRoi.id}`);
    ok(!/Estimativa de retorno/.test(prop2.introducao), 'sem ROI quando desmarcado');
    const op = await api('GET', `/comercial/oportunidades/${o.id}`);
    ok(op.historico.some(h => /simulador do Conector SAP/.test(h.texto)), 'histórico registra a proposta do simulador');
    // O fluxo existente continua: enviar gera link
    const env = await api('POST', `/comercial/propostas/${gp.id}/enviar`, { enviar_email: false });
    ok(env.link, 'proposta do simulador segue o fluxo (link gerado)');

    // 6. Página de impressão no Chrome headless (+ PDF A4 de exemplo)
    const html = await fetch('http://localhost:3000/proposta.html');
    ok(html.ok, 'proposta.html responde');
    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
    const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORTA}`, `--user-data-dir=${perfil}`, 'about:blank'], { stdio: 'ignore' });
    try {
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
      const avaliar = async expr => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
      await cmd('Page.navigate', { url: 'http://localhost:3000/login.html' });
      await espera(1000);
      await avaliar(`localStorage.setItem('token', ${JSON.stringify(token)}); true`);
      await cmd('Page.navigate', { url: `http://localhost:3000/proposta.html?id=${gp.id}` });
      await espera(2500);
      const pagina = await avaliar(`({ titulo: (document.querySelector('h1') || {}).textContent, linhas: document.querySelectorAll('.itens tbody tr').length,
        totais: [...document.querySelectorAll('.total strong')].map(e => e.textContent) })`);
      ok(pagina.titulo === prop.titulo && pagina.linhas === prop.itens.length, `página de impressão abre (${pagina.linhas} itens)`);
      ok(pagina.totais.some(t => /6\.875,00/.test(t)) && pagina.totais.some(t => /17\.000,00/.test(t)), `totais na página: ${pagina.totais.join(' | ')}`);
      const pdf = await cmd('Page.printToPDF', { paperWidth: 8.27, paperHeight: 11.69, marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4, printBackground: true });
      fs.writeFileSync(SAIDA_PDF, Buffer.from(pdf.data, 'base64'));
      ok(fs.statSync(SAIDA_PDF).size > 10000, `PDF A4 gerado: ${SAIDA_PDF}`);
      ws.close();
    } finally { chrome.kill(); }
  } finally {
    // limpeza (propostas e histórico caem junto com a oportunidade)
    if (criados.oport.length) await pool.query('DELETE FROM oportunidades WHERE id = ANY($1)', [criados.oport]);
    await pool.query('UPDATE financeiro_config SET prop_precos_conector = $1 WHERE empresa_id = 1',
      [precosOriginais ? precosOriginais.prop_precos_conector : null]);
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
