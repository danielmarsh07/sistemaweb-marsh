require('./_ambiente-local');
// Contrato x rascunho do mês: criar/editar contrato vigente gera o rascunho na hora (se a geração do mês já passou),
// editar o contrato atualiza os rascunhos não aprovados, e o contrato do Conector pode virar cortesia (sem cobrança).
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
const api = async (p, m = 'GET', body) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const comp = hoje.slice(0, 7);

(async () => {
  const cfgAntes = (await pool.query('SELECT geracao_automatica, dia_geracao FROM financeiro_config WHERE empresa_id = 1')).rows[0];
  await pool.query('UPDATE financeiro_config SET geracao_automatica = TRUE, dia_geracao = 1 WHERE empresa_id = 1');
  const cli = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ('TESTE Rascunho', 'TESTE RASCUNHO LTDA', 'rasc@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const rascunhos = async ct => (await pool.query(`SELECT valor::float, to_char(data_vencimento,'DD') dia, status FROM faturas WHERE contrato_id = $1 AND competencia = $2::date`, [ct, `${comp}-01`])).rows;
  const base = { cliente_id: cli, descricao: 'TESTE serviço', descricao_servico: 'TESTE serviço', valor: 1000, dia_vencimento: 10,
    data_inicio: `${comp}-01`, periodicidade: 'mensal', tipo: 'servico' };
  try {
    // Contrato que começa no mês que vem: nada agora
    const fut = await api('/financeiro/contratos', 'POST', { ...base, data_inicio: new Date(Date.UTC(+comp.slice(0, 4), +comp.slice(5, 7), 1)).toISOString().slice(0, 10) });
    ok(fut.status === 201 && (await rascunhos(fut.body.id)).length === 0, 'contrato que começa no mês que vem: sem rascunho agora');
    // Editar o início para este mês: o rascunho sai na hora
    const ed = await api(`/financeiro/contratos/${fut.body.id}`, 'PUT', { ...base, status: 'ativo' });
    ok(ed.status === 200 && (await rascunhos(fut.body.id)).length === 1 && /rascunho de/.test(ed.body.mensagem), `editar o início para este mês cria o rascunho (${ed.body?.mensagem})`);

    // Contrato novo vigente: rascunho na criação
    const cria = await api('/financeiro/contratos', 'POST', base);
    let r = await rascunhos(cria.body.id);
    ok(cria.status === 201 && r.length === 1 && r[0].valor === 1000 && r[0].dia === '10', `contrato novo vigente: rascunho na hora (${cria.body?.mensagem})`);
    // Editar valor e dia: o rascunho acompanha
    const ed2 = await api(`/financeiro/contratos/${cria.body.id}`, 'PUT', { ...base, valor: 1500, dia_vencimento: 5, status: 'ativo' });
    r = await rascunhos(cria.body.id);
    ok(ed2.status === 200 && r.length === 1 && r[0].valor === 1500 && r[0].dia === '05', `editar valor/dia atualiza o rascunho (${ed2.body?.mensagem})`);
    // Fatura aprovada não muda
    await pool.query(`UPDATE faturas SET status = 'aberta' WHERE contrato_id = $1`, [cria.body.id]);
    await api(`/financeiro/contratos/${cria.body.id}`, 'PUT', { ...base, valor: 2000, status: 'ativo' });
    ok((await rascunhos(cria.body.id))[0].valor === 1500, 'fatura já aprovada não muda ao editar o contrato');

    // Conector com cobrança mensal → cortesia
    const k = await api('/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'TESTE Gestor', gestor_email: `gestor-rasc-${Date.now()}@teste.local`,
      vagas: { funcional: 2 }, precos: { funcional: 100 }, ciclo: 'mensal', data_inicio: `${comp}-01`,
      data_fim: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10), cobranca: { gerar: true, dia_vencimento: 10 } });
    const cob = (await pool.query('SELECT id FROM contratos WHERE contrato_conector_id = $1', [k.body.id])).rows[0];
    ok((await rascunhos(cob.id)).length === 1 && /rascunho deste mês/.test(k.body.mensagem), `Conector com cobrança: rascunho do mês na criação (${k.body?.mensagem})`);
    // Preço novo: o rascunho acompanha
    await api(`/contratos-conector/${k.body.id}/precos`, 'PUT', { precos: { funcional: 150 } });
    ok((await rascunhos(cob.id))[0].valor === 300, 'preço novo do Conector atualiza o rascunho (2 × 150)');
    const cort = await api(`/contratos-conector/${k.body.id}/cortesia`, 'POST');
    const resta = (await pool.query('SELECT 1 FROM contratos WHERE id = $1', [cob.id])).rows.length;
    ok(cort.status === 200 && !resta && (await rascunhos(cob.id)).length === 0, `cortesia: rascunho e cobrança saem (${cort.body?.mensagem || cort.body?.erro})`);
    const det = (await api(`/contratos-conector/${k.body.id}`)).body;
    ok(!det.cobranca && det.status === 'ativo', 'contrato do Conector segue ativo, sem cobrança');
    ok((await api(`/contratos-conector/${k.body.id}/cortesia`, 'POST')).status === 400, '! já é cortesia');
  } finally {
    const ks = (await pool.query('SELECT id, gestor_usuario_id FROM contratos_conector WHERE cliente_id = $1', [cli])).rows;
    await pool.query('DELETE FROM faturas WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks.map(x => x.id)]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM clientes_admins WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [ks.map(x => x.gestor_usuario_id)]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [ks.map(x => x.gestor_usuario_id)]);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    if (cfgAntes) await pool.query('UPDATE financeiro_config SET geracao_automatica = $1, dia_geracao = $2 WHERE empresa_id = 1', [cfgAntes.geracao_automatica, cfgAntes.dia_geracao]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
