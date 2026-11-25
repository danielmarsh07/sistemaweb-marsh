require('./_ambiente-local');
// Encerramento do chamado pelo cliente (POST /api/chamados/:id/encerrar): cliente da empresa encerra,
// outra empresa não enxerga, não encerra duas vezes, timeline/log registram e depois dá para reabrir.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';
const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);

(async () => {
  const sufixo = Date.now();
  const novoCliente = async nome => (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ($1, $1, $2, 1, TRUE) RETURNING id`,
    [`TESTE ENCERRAR ${nome}`, `enc-${nome.toLowerCase()}-${sufixo}@exemplo.com`])).rows[0].id;
  const cliA = await novoCliente('A');
  const cliB = await novoCliente('B');
  const novoUsuario = async (nome, cliente_id) => (await pool.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo)
     VALUES ($1, $2, 'x', 1, 'cliente', $3, TRUE) RETURNING id`,
    [nome, `enc-${nome.toLowerCase().replace(/\s+/g, '-')}-${sufixo}@exemplo.com`, cliente_id])).rows[0].id;
  const uA = await novoUsuario('Cliente A Encerrar', cliA);
  const uB = await novoUsuario('Cliente B Encerrar', cliB);
  const assinar = p => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '10m' });
  const tokA = assinar({ id: uA, tipo: 'cliente', empresa_id: 1, cliente_id: cliA, nome: 'Cliente A Encerrar' });
  const tokB = assinar({ id: uB, tipo: 'cliente', empresa_id: 1, cliente_id: cliB, nome: 'Cliente B Encerrar' });
  const api = async (tok, p, m = 'GET', body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  const chId = (await pool.query(
    `INSERT INTO chamados (empresa_id, cliente_id, aberto_por_usuario_id, titulo, descricao, status, prioridade, ativo)
     VALUES (1, $1, $2, 'Teste encerrar', 'x', 'em_andamento', 'media', TRUE) RETURNING id`, [cliA, uA])).rows[0].id;

  try {
    let r = await api(tokB, `/chamados/${chId}/encerrar`, 'POST', {});
    ok(r.status === 404, `outra empresa não encerra (${r.status})`);

    r = await api(tokA, `/chamados/${chId}/encerrar`, 'POST', { motivo: 'Resolvido com o ajuste.' });
    ok(r.status === 200 && r.json.chamado?.status === 'fechado', `cliente encerra o próprio chamado (${r.status})`);

    const ch = (await pool.query('SELECT status, data_fechamento FROM chamados WHERE id = $1', [chId])).rows[0];
    ok(ch.status === 'fechado' && ch.data_fechamento, 'status fechado com data de fechamento');
    const at = (await pool.query(`SELECT descricao FROM atendimentos WHERE chamado_id = $1 AND tipo = 'fechamento'`, [chId])).rows;
    ok(at.length === 1 && at[0].descricao.includes('Resolvido com o ajuste.'), 'encerramento na timeline com o motivo');
    const log = (await pool.query(`SELECT status_anterior FROM chamados_status_log WHERE chamado_id = $1 AND status_novo = 'fechado'`, [chId])).rows;
    ok(log.length === 1 && log[0].status_anterior === 'em_andamento', 'log de status registrado');

    r = await api(tokA, `/chamados/${chId}/encerrar`, 'POST', {});
    ok(r.status === 409, `não encerra duas vezes (${r.status})`);

    r = await api(tokA, `/chamados/${chId}/reabrir`, 'POST', { motivo: 'Voltou.' });
    ok(r.status === 200, `depois de encerrado, reabre (${r.status})`);
  } finally {
    await pool.query('DELETE FROM atendimentos WHERE chamado_id = $1', [chId]);
    await pool.query('DELETE FROM chamados_status_log WHERE chamado_id = $1', [chId]);
    await pool.query('DELETE FROM chamados WHERE id = $1', [chId]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [[uA, uB]]);
    await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[cliA, cliB]]);
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
