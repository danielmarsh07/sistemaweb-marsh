require('./_ambiente-local');
// Chamados ABAP internos (consultor Marsh pelo Claude, chave do agente): abrir no cliente no nome do autor,
// registrar andamento com request, listar, encerrar; sem e-mail; isolamento (cliente não é autor, chamado do
// Conector não recebe andamento interno) e fora da fila de análise do agente.
// Servidor local: npm run dev:local
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };

(async () => {
  const cli = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
    VALUES ('TESTE Interno', 'TESTE INTERNO LTDA', 'interno@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const api = async (auth, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let chaveId = null;
  const tecnico = await usuarioTeste(pool, { tipo: 'tecnico' });
  const emailTec = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [tecnico])).rows[0].email;
  const usuCliente = await usuarioTeste(pool, { cliente_id: cli });
  const emailCli = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [usuCliente])).rows[0].email;
  const emailsAntes = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM emails_enviados')).rows[0].m;

  try {
    const cria = await api(tokAdmin, '/agente/chaves', 'POST', { nome: 'Agente interno teste' });
    const chave = cria.body.chave;
    chaveId = (await api(tokAdmin, '/agente/chaves')).body.find(k => k.nome === 'Agente interno teste')?.id;

    const base = { autor_email: emailTec, cliente: String(cli), titulo: 'Dump ZCL_DBCON conexão BI', tipo: 'erro',
      modulo: 'ABAP', pedido: 'Analisar o dump DBIF_DSQL2_CONNECTERR do job de réplica.', sid: 'PRD',
      objetos: [{ tipo: 'CLAS', nome: 'ZCL_DBCON' }, { tipo: 'PROG', nome: 'x y' }] };
    ok((await api(null, '/agente-servico/chamados/interno', 'POST', base)).status === 401, '! sem chave -> 401');
    ok((await api(chave, '/agente-servico/chamados/interno', 'POST', { ...base, autor_email: emailCli })).status === 400,
      '! usuário do cliente não é autor -> 400');
    ok((await api(chave, '/agente-servico/chamados/interno', 'POST', { ...base, tipo: 'xpto' })).status === 400, '! tipo inválido -> 400');
    ok((await api(chave, '/agente-servico/chamados/interno', 'POST', { ...base, request: 'ABC' })).status === 400, '! request inválida -> 400');
    ok((await api(chave, '/agente-servico/chamados/interno', 'POST', { ...base, cliente: 'NAO EXISTE XYZ' })).status === 400,
      '! cliente inexistente -> 400');
    const cl = await api(chave, '/agente-servico/clientes');
    ok(cl.status === 200 && cl.body.some(c => c.id === cli), 'lista clientes da empresa');

    const ab = await api(chave, '/agente-servico/chamados/interno', 'POST', { ...base, cliente: 'TESTE INTERNO', request: 'PRDK9Y020H' });
    ok(ab.status === 201 && ab.body.numero === `#${ab.body.id}`, `abre o chamado interno (${ab.status})`);
    const id = ab.body.id;
    const ch = (await pool.query('SELECT * FROM chamados WHERE id = $1', [id])).rows[0];
    ok(ch.origem === 'interno' && ch.cliente_id === cli && ch.aberto_por_usuario_id === tecnico
      && ch.atribuido_para_usuario_id === tecnico && ch.status === 'em_andamento' && ch.categoria === 'ABAP'
      && ch.request_sap === 'PRDK9Y020H' && ch.aprovacao_cliente === null && ch.objetos_sap.length === 1,
      'chamado no cliente, no nome do autor, em andamento, sem aprovação, objeto inválido descartado');

    const pend = await api(chave, '/agente-servico/chamados/pendentes');
    ok(!(pend.body || []).some(c => c.id === id), 'chamado interno fora da fila de análise do agente');

    ok((await api(chave, `/agente-servico/chamados/${id}/andamento`, 'POST', { autor_email: emailTec, texto: 'curto' })).status === 400,
      '! andamento curto -> 400');
    const an = await api(chave, `/agente-servico/chamados/${id}/andamento`, 'POST',
      { autor_email: emailTec, texto: 'Ajuste no ZFIR_DACON_VENDOR: log da BAPI antes do erro.', request: 'prdk9y020h', tempo_minutos: 30 });
    ok(an.status === 201, `registra andamento (${an.status})`);
    const at = (await pool.query(`SELECT * FROM atendimentos WHERE chamado_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    ok(at && at.usuario_id === tecnico && at.descricao.includes('Request SAP: PRDK9Y020H') && at.tempo_gasto_minutos === 30,
      'andamento na timeline com autor, request e tempo');

    const conector = (await pool.query(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem)
      VALUES (1, $1, 'do conector', 'aberto', TRUE, 'conector') RETURNING id`, [cli])).rows[0].id;
    ok((await api(chave, `/agente-servico/chamados/${conector}/andamento`, 'POST', { autor_email: emailTec, texto: 'x'.repeat(20) })).status === 404,
      '! andamento interno em chamado do Conector -> 404');

    const ls = await api(chave, `/agente-servico/chamados/internos?autor_email=${encodeURIComponent(emailTec)}`);
    ok(ls.status === 200 && ls.body.some(c => c.id === id && c.andamentos === 1 && c.request_sap === 'PRDK9Y020H'),
      'lista os chamados internos do autor');

    const ad = await api(tokAdmin, `/chamados?origem=manual`);
    const lista = Array.isArray(ad.body) ? ad.body : (ad.body?.chamados || ad.body?.dados || []);
    ok(ad.status === 200 && lista.some(c => c.id === id), 'equipe vê o chamado interno no filtro manual');

    // Mudar status (aberto / em_andamento / aguardando_cliente)
    const st = `/agente-servico/chamados/${id}/status-interno`;
    ok((await api(chave, st, 'POST', { autor_email: emailTec, status: 'fechado' })).status === 400, '! status fechado pela rota de status -> 400');
    ok((await api(chave, st, 'POST', { autor_email: emailCli, status: 'aberto' })).status === 400, '! status por usuário cliente -> 400');
    ok((await api(chave, `/agente-servico/chamados/${conector}/status-interno`, 'POST', { autor_email: emailTec, status: 'aberto' })).status === 404,
      '! status em chamado do Conector -> 404');
    const sa = await api(chave, st, 'POST', { autor_email: emailTec, status: 'aberto', texto: 'Aguardando priorização do Daniel.' });
    ok(sa.status === 200 && sa.body.status === 'aberto', `muda para aberto (${sa.status})`);
    ok((await pool.query('SELECT status FROM chamados WHERE id = $1', [id])).rows[0].status === 'aberto', 'status aberto gravado');
    const lg = (await pool.query(`SELECT * FROM chamados_status_log WHERE chamado_id = $1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    ok(lg && lg.status_anterior === 'em_andamento' && lg.status_novo === 'aberto' && lg.usuario_id === tecnico, 'log de status em_andamento -> aberto');
    ok((await pool.query(`SELECT COUNT(*)::int AS n FROM atendimentos WHERE chamado_id = $1 AND descricao = 'Aguardando priorização do Daniel.'`, [id])).rows[0].n === 1,
      'texto do status na timeline');
    const sr = await api(chave, st, 'POST', { autor_email: emailTec, status: 'aberto' });
    ok(sr.status === 200 && /já está/.test(sr.body.mensagem), 'mesmo status -> 200 sem mudar');
    ok((await api(chave, st, 'POST', { autor_email: emailTec, status: 'aguardando_cliente' })).status === 200, 'muda para aguardando_cliente');

    const en = await api(chave, `/agente-servico/chamados/${id}/encerrar-interno`, 'POST',
      { autor_email: emailTec, texto: 'Ajuste gravado e testado no PRD Rise.' });
    ok(en.status === 200, `encerra o chamado interno (${en.status})`);
    ok((await pool.query('SELECT status FROM chamados WHERE id = $1', [id])).rows[0].status === 'fechado', 'status fechado');
    ok((await api(chave, `/agente-servico/chamados/${id}/encerrar-interno`, 'POST', { autor_email: emailTec, texto: 'x'.repeat(20) })).status === 409,
      '! encerrar de novo -> 409');
    ok((await api(chave, `/agente-servico/chamados/${id}/andamento`, 'POST', { autor_email: emailTec, texto: 'x'.repeat(20) })).status === 409,
      '! andamento em chamado encerrado -> 409');
    ok((await api(chave, st, 'POST', { autor_email: emailTec, status: 'aberto' })).status === 409,
      '! status em chamado encerrado -> 409');

    await new Promise(r => setTimeout(r, 800));
    const emails = (await pool.query(`SELECT COUNT(*)::int AS n FROM emails_enviados WHERE id > $1 AND assunto LIKE $2`,
      [emailsAntes, `%#${id}%`])).rows[0].n;
    ok(emails === 0, `nenhum e-mail do chamado interno (${emails})`);
  } catch (e) {
    falhas++;
    console.error('ERRO', e);
  } finally {
    await pool.query(`DELETE FROM atendimentos WHERE chamado_id IN (SELECT id FROM chamados WHERE cliente_id = $1)`, [cli]);
    await pool.query(`DELETE FROM chamados_status_log WHERE chamado_id IN (SELECT id FROM chamados WHERE cliente_id = $1)`, [cli]);
    await pool.query(`DELETE FROM chamados WHERE cliente_id = $1`, [cli]);
    if (chaveId) await pool.query('DELETE FROM agente_chaves WHERE id = $1', [chaveId]);
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
    console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo OK');
    process.exit(falhas ? 1 : 0);
  }
})();
