require('./_ambiente-local');
// Consumo de IA: chave de administrador (prefixo, cifrada, nunca devolvida), sincronização com as APIs de custos
// (OpenAI: amount.value em US$; Anthropic: centavos em texto), saldo estimado pelas recargas e alerta de saldo baixo.
// As APIs são imitadas por um servidor falso na porta 3999. Rode o servidor local assim:
//   CONSUMO_IA_OPENAI_URL=http://localhost:3999 CONSUMO_IA_ANTHROPIC_URL=http://localhost:3999
//   MARKETING_CHAVE_CIFRA=<64 hex> npm run dev:local
const http = require('http');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const dia = n => new Date(Date.now() - n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const seg = d => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

const falso = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (u.pathname === '/v1/organization/costs') {
    if (req.headers.authorization !== 'Bearer sk-admin-teste123') return json(401, { error: { message: 'invalid key' } });
    return json(200, { object: 'page', has_more: false, next_page: null, data: [
      { object: 'bucket', start_time: seg(dia(1)), end_time: seg(dia(0)), results: [
        { object: 'organization.costs.result', amount: { value: 1.5, currency: 'usd' }, line_item: 'gpt-4o-mini, input' },
        { object: 'organization.costs.result', amount: { value: 0.25, currency: 'usd' }, line_item: 'tts' }] },
      { object: 'bucket', start_time: seg(dia(0)), end_time: seg(dia(-1)), results: [
        { object: 'organization.costs.result', amount: { value: 0.75, currency: 'usd' }, line_item: 'gpt-4o-mini, input' }] }] });
  }
  if (u.pathname === '/v1/organizations/cost_report') {
    if (req.headers['x-api-key'] !== 'sk-ant-admin01-teste') return json(401, { error: { type: 'authentication_error' } });
    return json(200, { has_more: false, next_page: null, data: [
      { starting_at: `${dia(0)}T00:00:00Z`, ending_at: `${dia(-1)}T00:00:00Z`, results: [
        { amount: '250.5', currency: 'USD', description: 'Claude Sonnet' }] }] });
  }
  json(404, {});
});

(async () => {
  await new Promise(r => falso.listen(3999, r));
  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokTecnico = jwt.sign({ id: 1, tipo: 'tecnico', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const api = async (tok, p, m = 'GET', body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body && JSON.stringify(body) });
    const texto = await r.text();
    let corpo = null; try { corpo = JSON.parse(texto); } catch { /* */ }
    return { status: r.status, body: corpo, texto };
  };
  await pool.query('DELETE FROM ia_recargas WHERE empresa_id = 1');
  await pool.query('DELETE FROM ia_custos_diarios WHERE empresa_id = 1');
  await pool.query('DELETE FROM ia_provedores WHERE empresa_id = 1');

  try {
    ok((await api(tokTecnico, '/consumo-ia')).status === 403, '! técnico não vê o consumo de IA');
    ok((await api(tokAdmin, '/consumo-ia/openai', 'PUT', { admin_chave: 'sk-proj-abc' })).status === 400, '! OpenAI recusa chave que não é de administrador');
    ok((await api(tokAdmin, '/consumo-ia/anthropic', 'PUT', { admin_chave: 'sk-ant-api03-x' })).status === 400, '! Anthropic recusa chave de uso');
    ok((await api(tokAdmin, '/consumo-ia/gemini', 'PUT', { limite_alerta_usd: 1 })).status === 404, '! provedor desconhecido');
    let r = await api(tokAdmin, '/consumo-ia/openai', 'PUT', { admin_chave: 'sk-admin-teste123', limite_alerta_usd: 8 });
    ok(r.status === 200, `salva a chave de administrador da OpenAI (${r.status} ${r.body?.erro || ''})`);
    ok((await api(tokAdmin, '/consumo-ia/anthropic', 'PUT', { admin_chave: 'sk-ant-admin01-teste' })).status === 200, 'salva a chave da Anthropic');
    const g = (await pool.query(`SELECT admin_chave_cifrada FROM ia_provedores WHERE empresa_id = 1 AND provedor = 'openai'`)).rows[0];
    ok(g.admin_chave_cifrada.startsWith('v1:') && !g.admin_chave_cifrada.includes('teste123'), 'chave gravada cifrada');
    ok((await api(tokAdmin, '/consumo-ia/openai/recargas', 'POST', { data: dia(5), valor_usd: 0 })).status === 400, '! recarga de valor zero');
    ok((await api(tokAdmin, '/consumo-ia/openai/recargas', 'POST', { data: dia(5), valor_usd: 10, observacao: 'Recarga inicial' })).status === 201,
      'lança recarga de US$ 10 há 5 dias');

    r = await api(tokAdmin, '/consumo-ia/sincronizar', 'POST');
    ok(r.status === 200 && r.body.resultado.openai.ok && r.body.resultado.anthropic.ok, `sincroniza os dois provedores (${JSON.stringify(r.body?.resultado)})`);
    const res = await api(tokAdmin, '/consumo-ia');
    const o = res.body.provedores.openai, a = res.body.provedores.anthropic;
    ok(Math.abs(o.gasto_30d - 2.5) < 1e-6 && Math.abs(o.gasto_hoje - 0.75) < 1e-6, `OpenAI: gasto 30 dias US$ 2,50 e hoje US$ 0,75 (${o.gasto_30d} / ${o.gasto_hoje})`);
    ok(Math.abs(a.gasto_30d - 2.505) < 1e-6, `Anthropic: centavos convertidos (US$ 2,505) (${a.gasto_30d})`);
    ok(Math.abs(o.saldo_estimado - 7.5) < 1e-6 && a.saldo_estimado === null, `saldo estimado OpenAI = 10 − 2,50 = 7,50; Anthropic sem recarga = vazio (${o.saldo_estimado})`);
    ok(o.itens_mes.length >= 1 && o.itens_mes[0].item === 'gpt-4o-mini, input', 'itens do mês agrupados');
    ok(!res.texto.includes('teste123') && o.chave_prefixo.startsWith('sk-admin-'), 'resumo nunca devolve a chave inteira (só o prefixo)');
    const alerta = (await pool.query(`SELECT alerta_enviado_em FROM ia_provedores WHERE empresa_id = 1 AND provedor = 'openai'`)).rows[0];
    ok(!!alerta.alerta_enviado_em, 'saldo 7,50 abaixo do limite 8: alerta marcado (e-mail aos administradores)');

    await api(tokAdmin, '/consumo-ia/openai', 'PUT', { admin_chave: 'sk-admin-errada' });
    r = await api(tokAdmin, '/consumo-ia/sincronizar', 'POST');
    ok(r.body.resultado.openai.ok === false && /administrador/i.test(r.body.resultado.openai.erro), 'chave recusada pelo provedor vira erro legível');
    ok(!!(await api(tokAdmin, '/consumo-ia')).body.provedores.openai.ultimo_erro, 'erro aparece no painel');
    const rec = (await pool.query(`SELECT id FROM ia_recargas WHERE empresa_id = 1 LIMIT 1`)).rows[0];
    ok((await api(tokAdmin, `/consumo-ia/recargas/${rec.id}`, 'DELETE')).status === 200, 'remove a recarga');
  } finally {
    await pool.query('DELETE FROM ia_recargas WHERE empresa_id = 1');
    await pool.query('DELETE FROM ia_custos_diarios WHERE empresa_id = 1');
    await pool.query('DELETE FROM ia_provedores WHERE empresa_id = 1');
    await pool.end();
    falso.close();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
