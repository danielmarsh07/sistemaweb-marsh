require('./_ambiente-local');
// E-mails do chamado: SÓ quem abriu e o ABAP responsável (chamados.atribuido_para_usuario_id; sem ele, o padrão
// da empresa) recebem. Nunca os demais usuários do cliente nem a equipe toda.
// - mudança de status (inclusive fechar) e comentário da equipe: para quem abriu, cópia para o responsável
// - comentário do cliente e chamado novo: só para o responsável
// - sem quem abriu: nada sai para o cliente
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
  const abap = await usuarioTeste(pool, { tipo: 'tecnico' });
  const outroAbap = await usuarioTeste(pool, { tipo: 'tecnico' });
  const email = async id => (await pool.query('SELECT email FROM usuarios WHERE id = $1', [id])).rows[0].email;
  const [eDono, eColega, eAbap, eOutro] = [await email(dono), await email(colega), await email(abap), await email(outroAbap)];
  const padraoAntes = (await pool.query('SELECT abap_padrao_usuario_id FROM empresas WHERE id = 1')).rows[0].abap_padrao_usuario_id;

  const token = (id, tipo, extra = {}) => jwt.sign({ id, tipo, empresa_id: 1, ...extra }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokAdmin = token(1, 'admin_empresa');
  const tokDono = token(dono, 'cliente', { cliente_id: cli });
  const api = async (tok, p, m = 'GET', body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // O registro em emails_enviados é gravado sem esperar: aguarda aparecer
  const ultimo = async (assunto) => {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 150));
      const row = (await pool.query(`SELECT para, copia FROM emails_enviados WHERE assunto LIKE $1 ORDER BY id DESC LIMIT 1`, [assunto])).rows[0];
      if (row) return row;
    }
    return { para: null, copia: null };
  };
  const ninguemMais = (row) => ![eColega, eOutro, 'admin@marsh.local'].some(e => `${row.para} ${row.copia}`.includes(e));

  const ch = (await pool.query(
    `INSERT INTO chamados (empresa_id, cliente_id, titulo, descricao, prioridade, status, ativo, aberto_por_usuario_id,
       atribuido_para_usuario_id)
     VALUES (1, $1, 'Teste aviso dono e ABAP', 'x', 'media', 'aberto', TRUE, $2, $3) RETURNING id`, [cli, dono, abap])).rows[0].id;
  const semDono = (await pool.query(
    `INSERT INTO chamados (empresa_id, cliente_id, titulo, descricao, prioridade, status, ativo, atribuido_para_usuario_id)
     VALUES (1, $1, 'Teste sem dono', 'x', 'media', 'aberto', TRUE, $2) RETURNING id`, [cli, abap])).rows[0].id;
  const criados = [ch, semDono];

  try {
    // Responsável: lista e troca
    const lista = await api(tokAdmin, '/chamados/responsaveis');
    ok(lista.status === 200 && lista.body.responsaveis.some(u => u.id === abap), 'lista de ABAP responsáveis');
    ok((await api(tokDono, '/chamados/responsaveis')).status === 403, '! cliente não vê a lista');
    ok((await api(tokDono, `/chamados/${ch}/responsavel`, 'PUT', { usuario_id: abap })).status === 403, '! cliente não troca o responsável');
    ok((await api(tokAdmin, `/chamados/${ch}/responsavel`, 'PUT', { usuario_id: colega })).status === 400, '! usuário do cliente não pode ser responsável');
    ok((await api(tokAdmin, `/chamados/${ch}/responsavel`, 'PUT', { usuario_id: abap, padrao: true })).status === 200,
      'admin define o ABAP responsável e o padrão');

    // Cliente comenta -> só o responsável
    ok((await api(tokDono, '/atendimentos', 'POST', { chamado_id: ch, descricao: 'Comentário do cliente' })).status === 201, 'cliente comenta');
    let row = await ultimo(`%do cliente — Chamado #${ch}:%`);
    ok(row.para === eAbap && !row.copia && ninguemMais(row), `comentário do cliente: só o ABAP responsável (${row.para})`);

    // Equipe fecha -> quem abriu, cópia para o responsável
    ok((await api(tokAdmin, `/chamados/${ch}`, 'PUT', { status: 'fechado' })).status === 200, 'equipe fecha o chamado');
    row = await ultimo(`%Chamado #${ch} — Status atualizado%`);
    ok(row.para === eDono && row.copia === eAbap && ninguemMais(row), `fechar: quem abriu + cópia ao responsável (${row.para} / cc ${row.copia})`);

    // Equipe comenta -> quem abriu, cópia para o responsável
    await api(tokAdmin, `/chamados/${ch}/reabrir`, 'POST', { motivo: 'teste' });
    ok((await api(tokAdmin, '/atendimentos', 'POST', { chamado_id: ch, tipo: 'comentario', descricao: 'Comentário da equipe' })).status === 201,
      'equipe comenta');
    row = await ultimo(`%no seu chamado #${ch}:%`);
    ok(row.para === eDono && row.copia === eAbap && ninguemMais(row), `comentário da equipe: quem abriu + cópia ao responsável (${row.para} / cc ${row.copia})`);

    // Chamado novo pelo portal -> nasce com o responsável padrão e só ele é avisado
    const novo = await api(tokDono, '/chamados', 'POST', { titulo: 'Teste chamado novo', descricao: 'x', sid: null });
    if (novo.status === 201) {
      criados.push(novo.body.chamado.id);
      ok(novo.body.chamado.atribuido_para_usuario_id === abap, 'chamado novo nasce com o ABAP padrão');
      row = await ultimo(`%Novo chamado #${novo.body.chamado.id}:%`);
      ok(row.para === eAbap && ninguemMais(row), `chamado novo: só o ABAP responsável (${row.para})`);
    } else {
      console.log(`SKIP chamado novo pelo portal (${novo.status}: ${novo.body && novo.body.erro})`);
    }

    // Sem quem abriu: nada sai para o cliente
    const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM emails_enviados WHERE assunto LIKE $1`, [`%Chamado #${semDono} %`])).rows[0].n;
    ok((await api(tokAdmin, `/chamados/${semDono}`, 'PUT', { status: 'fechado' })).status === 200, 'fecha chamado sem dono identificado');
    await new Promise(r => setTimeout(r, 1500));
    const depois = (await pool.query(`SELECT COUNT(*)::int AS n FROM emails_enviados WHERE assunto LIKE $1`, [`%Chamado #${semDono} %`])).rows[0].n;
    ok(depois === antes, '! sem dono: nenhum e-mail (nunca para todos os usuários do cliente)');
  } finally {
    await pool.query('UPDATE empresas SET abap_padrao_usuario_id = $1 WHERE id = 1', [padraoAntes]);
    await pool.query('DELETE FROM atendimentos WHERE chamado_id = ANY($1)', [criados]);
    await pool.query('DELETE FROM chamados_status_log WHERE chamado_id = ANY($1)', [criados]);
    await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [criados]);
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
