require('./_ambiente-local');
// Avisos do chamado ao cliente (mudança de status, inclusive fechar; comentário/solução da equipe):
// vão SÓ para quem abriu o chamado, nunca para os demais usuários do cliente. Sem dono, não envia.
// Servidor local: npm run dev:local.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };

(async () => {
  const cli = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
    VALUES ('TESTE E-mails', 'TESTE EMAILS LTDA', 'emails@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const dono = await usuarioTeste(pool, { cliente_id: cli });
  const colega = await usuarioTeste(pool, { cliente_id: cli });
  const email = async id => (await pool.query('SELECT email FROM usuarios WHERE id = $1', [id])).rows[0].email;
  const [emailDono, emailColega] = [await email(dono), await email(colega)];
  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const api = async (p, m = 'GET', body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokAdmin}` },
      body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // O registro em emails_enviados é gravado sem esperar: aguarda aparecer
  const ultimo = async (assunto) => {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150));
      const row = (await pool.query(`SELECT para FROM emails_enviados WHERE assunto LIKE $1 ORDER BY id DESC LIMIT 1`, [assunto])).rows[0];
      if (row) return row.para;
    }
    return null;
  };

  const ch = (await pool.query(
    `INSERT INTO chamados (empresa_id, cliente_id, titulo, descricao, prioridade, status, ativo, aberto_por_usuario_id)
     VALUES (1, $1, 'Teste aviso só ao dono', 'x', 'media', 'aberto', TRUE, $2) RETURNING id`, [cli, dono])).rows[0].id;
  const semDono = (await pool.query(
    `INSERT INTO chamados (empresa_id, cliente_id, titulo, descricao, prioridade, status, ativo)
     VALUES (1, $1, 'Teste sem dono', 'x', 'media', 'aberto', TRUE) RETURNING id`, [cli])).rows[0].id;

  try {
    ok((await api(`/chamados/${ch}`, 'PUT', { status: 'fechado' })).status === 200, 'equipe fecha o chamado');
    let para = await ultimo(`%Chamado #${ch} — Status atualizado%`);
    ok(para === emailDono && !para.includes(emailColega), `fechar: só para quem abriu (${para})`);

    ok((await api(`/chamados/${ch}/reabrir`, 'POST', { motivo: 'teste' })).status < 500, 'reabre para comentar');
    ok((await api('/atendimentos', 'POST', { chamado_id: ch, tipo: 'comentario', descricao: 'Comentário da equipe para o dono' })).status === 201,
      'equipe comenta');
    para = await ultimo(`%no seu chamado #${ch}:%`);
    ok(para === emailDono && !para.includes(emailColega), `comentário da equipe: só para quem abriu (${para})`);

    const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM emails_enviados WHERE assunto LIKE $1`, [`%Chamado #${semDono} %`])).rows[0].n;
    ok((await api(`/chamados/${semDono}`, 'PUT', { status: 'fechado' })).status === 200, 'fecha chamado sem dono identificado');
    await new Promise(r => setTimeout(r, 1500));
    const depois = (await pool.query(`SELECT COUNT(*)::int AS n FROM emails_enviados WHERE assunto LIKE $1`, [`%Chamado #${semDono} %`])).rows[0].n;
    ok(depois === antes, '! sem dono: nenhum e-mail (nunca para todos os usuários do cliente)');
  } finally {
    const chs = [ch, semDono];
    await pool.query('DELETE FROM atendimentos WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados_status_log WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [chs]);
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
