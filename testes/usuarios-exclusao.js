require('./_ambiente-local');
// Exclusão de usuários: sem histórico apaga; com histórico só desativa; protege a si mesmo e o último admin.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api/usuarios';

(async () => {
  const eu = (await pool.query(`SELECT id, tipo FROM usuarios WHERE tipo IN ('admin_sistema','admin_empresa') AND ativo ORDER BY id LIMIT 1`)).rows[0];
  const token = jwt.sign({ id: eu.id, tipo: 'admin_sistema', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const api = async (m, p, b) => {
    const r = await fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) });
    return { status: r.status, ...(await r.json()) };
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const criar = async (nome, tipo = 'tecnico') => (await api('POST', '/', { nome, email: `${nome.replace(/\W/g, '').toLowerCase()}@teste.local`, senha: 'segredo123', tipo })).usuario.id;

  // Sem histórico → apaga
  const a = await criar('TESTE Sem Historico');
  const r1 = await api('DELETE', `/${a}/definitivo`);
  const sobrou = (await pool.query('SELECT 1 FROM usuarios WHERE id = $1', [a])).rows.length;
  ok(r1.status === 200 && !sobrou, `sem histórico: excluído (${r1.mensagem})`);

  // Com histórico (comentou num chamado) → só desativa
  const b = await criar('TESTE Com Historico');
  const ch = (await pool.query(`SELECT id FROM chamados ORDER BY id LIMIT 1`)).rows[0];
  if (ch) {
    await pool.query(`INSERT INTO atendimentos (chamado_id, usuario_id, descricao) VALUES ($1, $2, 'TESTE comentário')`, [ch.id, b]).catch(async () =>
      pool.query(`INSERT INTO atendimentos (chamado_id, usuario_id, comentario) VALUES ($1, $2, 'TESTE comentário')`, [ch.id, b]));
    const r2 = await api('DELETE', `/${b}/definitivo`);
    const u2 = (await pool.query('SELECT ativo FROM usuarios WHERE id = $1', [b])).rows[0];
    ok(r2.status === 409 && u2 && u2.ativo === false, `com histórico: mantido e desativado (${r2.erro})`);
    await pool.query(`DELETE FROM atendimentos WHERE usuario_id = $1`, [b]);
  } else {
    console.log('     (sem chamados locais para testar histórico)');
  }
  await api('DELETE', `/${b}/definitivo`);

  // Não exclui a si mesmo
  const r3 = await api('DELETE', `/${eu.id}/definitivo`);
  ok(r3.status === 400, 'não exclui a própria conta');

  // Inexistente
  const r4 = await api('DELETE', '/999999/definitivo');
  ok(r4.status === 404, 'usuário inexistente → 404');

  await pool.query(`DELETE FROM usuarios WHERE nome LIKE 'TESTE %'`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
