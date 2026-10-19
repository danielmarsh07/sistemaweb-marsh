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

  // Usuário do portal numa vaga do Conector (com convite pendente) → apaga e a vaga fica livre;
  // gestor do contrato → só desativa (o contrato precisa dele)
  const cli = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ('TESTE Exclusao', 'TESTE EXCLUSAO LTDA', 'excl@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const sufixo = Date.now();
  const tokApi = async (p, m, b) => (await fetch('http://localhost:3000/api' + p, { method: m,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })).json();
  const k = await tokApi('/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'TESTE Gestor Excl', gestor_email: `gestor-excl-${sufixo}@teste.local`,
    vagas: { funcional: 1 }, data_fim: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) });
  const vaga = (await tokApi(`/contratos-conector/${k.id}`, 'GET')).body?.vagas?.[0] || (await tokApi(`/contratos-conector/${k.id}`, 'GET')).vagas[0];
  await tokApi(`/contratos-conector/${k.id}/vagas/${vaga.id}/ocupar`, 'POST', { nome: 'TESTE Pessoa Vaga', email: `pessoa-excl-${sufixo}@teste.local` });
  const pessoa = (await pool.query(`SELECT id FROM usuarios WHERE email = $1`, [`pessoa-excl-${sufixo}@teste.local`])).rows[0].id;
  const r5 = await api('DELETE', `/${pessoa}/definitivo`);
  const vagaDepois = (await pool.query('SELECT usuario_id, estado FROM contratos_conector_vagas WHERE id = $1', [vaga.id])).rows[0];
  ok(r5.status === 200 && vagaDepois.usuario_id === null && vagaDepois.estado === 'livre', `usuário numa vaga: excluído e vaga livre (${r5.mensagem || r5.erro})`);
  const gestor = (await pool.query(`SELECT id FROM usuarios WHERE email = $1`, [`gestor-excl-${sufixo}@teste.local`])).rows[0].id;
  const r6 = await api('DELETE', `/${gestor}/definitivo`);
  const g6 = (await pool.query('SELECT ativo FROM usuarios WHERE id = $1', [gestor])).rows[0];
  ok(r6.status === 409 && g6 && g6.ativo === false && /gestor/.test(r6.erro), `gestor de contrato: desativado (${r6.erro})`);
  await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = $1', [k.id]);
  await pool.query('DELETE FROM contratos_conector WHERE id = $1', [k.id]);
  await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = $1', [gestor]);
  await pool.query('DELETE FROM usuarios WHERE id = $1', [gestor]);
  await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);

  // Não exclui a si mesmo
  const r3 = await api('DELETE', `/${eu.id}/definitivo`);
  ok(r3.status === 400, 'não exclui a própria conta');

  // Inexistente
  const r4 = await api('DELETE', '/999999/definitivo');
  ok(r4.status === 404, 'usuário inexistente → 404');

  await pool.query(`DELETE FROM usuarios WHERE nome LIKE 'TESTE %'`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
