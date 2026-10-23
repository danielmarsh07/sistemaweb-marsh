require('./_ambiente-local');
// Agente ABAP: chave de serviço (criar, usar, revogar), chamados do Conector pendentes de análise, link de anexo,
// gravação da análise interna (não volta a ser pendente) e isolamento: o cliente nunca lê a análise.
// Servidor local: npm run dev:local (com storage s3mock para o link de anexo; sem ele o teste aceita 503).
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };

(async () => {
  const cli = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
    VALUES ('TESTE Agente', 'TESTE AGENTE LTDA', 'agente@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokCliente = jwt.sign({ id: await usuarioTeste(pool, { cliente_id: cli }), tipo: 'cliente', empresa_id: 1, cliente_id: cli },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  const api = async (auth, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ins = (titulo, status = 'aberto', origem = 'conector') => pool.query(
    `INSERT INTO chamados (empresa_id, cliente_id, titulo, descricao, prioridade, categoria, status, ativo, origem, sid, modulo,
       tipo_demanda, pedido_original, especificacao, objetos_sap, solicitante_nome, aprovacao_cliente)
     VALUES (1, $1, $2, 'x', 'media', 'Conector SAP', $3, TRUE, $4, 'QAS', 'FISCAL', 'erro', 'Cálculo do ISS errado',
       '# Spec', '[{"tipo":"PROG","nome":"ZNFSE_PROC"}]', 'Renan', 'pendente') RETURNING id`, [cli, titulo, status, origem]);
  const chave = { id: null, texto: null };

  try {
    ok((await api(null, '/agente-servico/chamados/pendentes')).status === 401, '! sem chave -> 401');
    ok((await api('MRSH-AG-' + '0'.repeat(32), '/agente-servico/chamados/pendentes')).status === 401, '! chave desconhecida -> 401');
    ok((await api(tokCliente, '/agente/chaves', 'POST', {})).status === 403, '! cliente não cria chave');
    const cria = await api(tokAdmin, '/agente/chaves', 'POST', { nome: 'Agente teste' });
    ok(cria.status === 201 && /^MRSH-AG-[a-f0-9]{32}$/.test(cria.body?.chave || ''), 'admin cria a chave do agente (texto só agora)');
    chave.texto = cria.body.chave;
    const lista = await api(tokAdmin, '/agente/chaves');
    chave.id = lista.body.find(k => k.nome === 'Agente teste')?.id;
    ok(chave.id && !('chave_hash' in lista.body[0]), 'lista de chaves sem o hash');

    const c1 = (await ins('Ajuste ISS ZNFSE')).rows[0].id;
    const c2 = (await ins('Já fechado', 'fechado')).rows[0].id;
    const c3 = (await ins('Chamado comum', 'aberto', 'portal')).rows[0].id;
    await pool.query(`INSERT INTO chamados_anexos (chamado_id, empresa_id, nome_original, storage_key, tamanho_bytes, mime_type)
      VALUES ($1, 1, 'tela.png', 'chamados/teste/tela.png', 10, 'image/png')`, [c1]);
    let p = await api(chave.texto, '/agente-servico/chamados/pendentes');
    const ids = (p.body || []).map(c => c.id);
    ok(p.status === 200 && ids.includes(c1) && !ids.includes(c2) && !ids.includes(c3),
      'pendentes: só o chamado do Conector em aberto (não o fechado nem o do portal)');
    const item = p.body.find(c => c.id === c1);
    ok(item && item.especificacao === '# Spec' && item.anexos.length === 1 && item.cliente_nome === 'TESTE AGENTE LTDA',
      'pendente traz especificação, cliente e anexos');
    const lk = await api(chave.texto, `/agente-servico/chamados/${c1}/anexos/${item.anexos[0].id}`);
    ok(lk.status === 200 ? /^https?:\/\//.test(lk.body.url) : lk.status === 503, `link temporário do anexo (${lk.status})`);
    ok((await api(chave.texto, `/agente-servico/chamados/${c3}/analise`, 'POST', { analise: 'x'.repeat(30) })).status === 404,
      '! análise em chamado que não é do Conector -> 404');
    ok((await api(chave.texto, `/agente-servico/chamados/${c1}/analise`, 'POST', { analise: 'curta' })).status === 400, '! análise curta -> 400');
    const a = await api(chave.texto, `/agente-servico/chamados/${c1}/analise`, 'POST', {
      analise: '## Causa confirmada\nA base do ISS ignora o desconto (ZNFSE_PROC_F01, linha 212).',
      resumo: { complexidade: 'media', horas: 6.5, risco: 'Notas já emitidas no mês', cerebro: 'DEM-0003', lixo: 'x' } });
    ok(a.status === 201, `agente grava a análise (${a.status})`);
    // Aviso da análise: só para quem gerou a chave (usuário 1), nunca para o restante da equipe
    const tecnico = await usuarioTeste(pool, { tipo: 'tecnico' });
    const emailTec = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [tecnico])).rows[0].email;
    const emailDono = (await pool.query('SELECT email FROM usuarios WHERE id = 1')).rows[0].email;
    await api(chave.texto, `/agente-servico/chamados/${c1}/analise`, 'POST', { analise: 'Reanálise para conferir o aviso.' });
    let aviso;
    for (let i = 0; i < 20 && !aviso; i++) {
      await new Promise(r => setTimeout(r, 150));
      aviso = (await pool.query(`SELECT para FROM emails_enviados WHERE assunto LIKE $1 ORDER BY id DESC LIMIT 1`,
        [`%análise do chamado #${c1} %`])).rows[0];
    }
    ok(aviso && aviso.para === emailDono && !aviso.para.includes(emailTec),
      `aviso da análise só para quem gerou a chave (${aviso && aviso.para})`);
    p = await api(chave.texto, '/agente-servico/chamados/pendentes');
    ok(!(p.body || []).some(c => c.id === c1), 'chamado analisado sai dos pendentes');
    ok((await api(chave.texto, `/agente-servico/chamados/${c1}/analise`, 'POST', { analise: 'Reanálise com mais detalhes do caso.' })).status === 200,
      'regravar substitui a análise (200)');
    const ver = await api(tokAdmin, `/agente/chamados/${c1}/analise`);
    ok(ver.status === 200 && ver.body.analise.startsWith('Reanálise') && ver.body.agente === 'Agente teste', 'equipe lê a análise');
    ok((await api(tokCliente, `/agente/chamados/${c1}/analise`)).status === 403, '! cliente não lê a análise -> 403');
    const det = await api(tokCliente, `/chamados/${c1}`);
    ok(det.status !== 200 || !JSON.stringify(det.body).includes('Reanálise'), 'detalhe do chamado para o cliente não traz a análise');

    // Resposta ao solicitante: rascunho interno até a equipe enviar
    await api(chave.texto, `/agente-servico/chamados/${c1}/analise`, 'POST', {
      analise: 'Reanálise com resposta ao solicitante.', resposta: 'Renan, analisamos o chamado: RASCUNHO-SECRETO procede.' });
    await api(chave.texto, `/agente-servico/chamados/${c1}/analise`, 'POST', { analise: 'Reanálise sem resposta nova no corpo.' });
    let v2 = await api(tokAdmin, `/agente/chamados/${c1}/analise`);
    ok(v2.body?.resposta_rascunho?.includes('RASCUNHO-SECRETO') && !v2.body.resposta_enviada, 'rascunho gravado e mantido na reanálise');
    ok(!JSON.stringify((await api(tokCliente, `/chamados/${c1}`)).body).includes('RASCUNHO-SECRETO'), 'cliente não vê o rascunho');
    ok((await api(tokCliente, `/agente/chamados/${c1}/resposta`, 'POST', { texto: 'x'.repeat(30) })).status === 403, '! cliente não envia resposta');
    ok((await api(tokAdmin, `/agente/chamados/${c1}/resposta`, 'POST', { texto: 'x'.repeat(30), reply_to: 'nao-e-email' })).status === 400,
      '! reply_to inválido -> 400');
    const corpoResp = { texto: 'Renan, analisamos o chamado: ENVIADO-OK procede. Informe a request.', reply_to: 'Daniel.Lopes@Cliente.com.br' };
    const semDestino = await api(tokAdmin, `/agente/chamados/${c1}/resposta`, 'POST', corpoResp);
    ok(semDestino.status === 409 && !JSON.stringify((await api(tokCliente, `/chamados/${c1}`)).body).includes('ENVIADO-OK'),
      '! sem e-mail de quem abriu (nem na licença) -> 409 e nada enviado (nunca para os demais usuários do cliente)');
    await pool.query(`UPDATE chamados SET solicitante_email = 'renan.teste@exemplo.com' WHERE id = $1`, [c1]);
    ok((await api(tokAdmin, `/agente/chamados/${c1}/analise`)).body.destino_email === 'renan.teste@exemplo.com', 'painel mostra o destinatário real');
    const env = await api(tokAdmin, `/agente/chamados/${c1}/resposta`, 'POST', corpoResp);
    ok(env.status === 200, `equipe envia a resposta (${env.status}; e-mail ${env.body?.enviado ? 'saiu' : 'desligado no local'})`);
    // O registro em emails_enviados é gravado sem esperar (não atrasa a resposta): aguarda ele aparecer
    let reg;
    for (let i = 0; i < 20 && !reg; i++) {
      await new Promise(r => setTimeout(r, 150));
      reg = (await pool.query(`SELECT para FROM emails_enviados WHERE assunto LIKE $1 ORDER BY id DESC LIMIT 1`, [`%] Chamado #${c1} %`])).rows[0];
    }
    ok(reg && reg.para === 'renan.teste@exemplo.com', `e-mail só para quem abriu (${reg && reg.para})`);
    const detEnv = await api(tokCliente, `/chamados/${c1}`);
    ok(JSON.stringify(detEnv.body).includes('ENVIADO-OK') && detEnv.body.status === 'em_andamento', 'resposta vira atendimento visível e chamado em andamento');
    v2 = await api(tokAdmin, `/agente/chamados/${c1}/analise`);
    ok(v2.body.resposta_enviada?.includes('ENVIADO-OK') && v2.body.email_resposta_marsh === 'daniel.lopes@cliente.com.br',
      'resposta enviada registrada e reply_to guardado no cliente');

    // Request SAP -> preparo do agente
    ok((await api(tokCliente, `/chamados/${c1}/request`, 'POST', { request: 'ABC123' })).status === 400, '! request inválida -> 400');
    ok((await api(tokCliente, `/chamados/${c3}/request`, 'POST', { request: 'UPDK955200' })).status === 409, '! chamado fora do Conector -> 409');
    ok((await api(chave.texto, '/agente-servico/chamados/preparar')).body.every(c => c.id !== c1), 'sem request: nada a preparar');
    ok((await api(tokCliente, `/chamados/${c1}/request`, 'POST', { request: 'updk955200' })).status === 200, 'cliente informa a request');
    let prep = await api(chave.texto, '/agente-servico/chamados/preparar');
    const itemPrep = (prep.body || []).find(c => c.id === c1);
    ok(itemPrep && itemPrep.request_sap === 'UPDK955200' && itemPrep.analise, 'chamado com request entra em "preparar" (com a análise)');
    ok((await api(chave.texto, `/agente-servico/chamados/${c1}/preparo`, 'POST', { request: 'UPDK999999', preparo: 'y'.repeat(30) })).status === 409,
      '! preparo para outra request -> 409');
    ok((await api(chave.texto, `/agente-servico/chamados/${c1}/preparo`, 'POST', { request: 'UPDK955200', preparo: '## Diff\nPREPARO-OK no nó %CODE4.' })).status === 200,
      'agente grava o preparo');
    ok((await api(chave.texto, '/agente-servico/chamados/preparar')).body.every(c => c.id !== c1), 'preparado sai da fila');
    await api(tokAdmin, `/chamados/${c1}/request`, 'POST', { request: 'UPDK955201' });
    ok((await api(chave.texto, '/agente-servico/chamados/preparar')).body.some(c => c.id === c1), 'request trocada volta para a fila');
    ok(!JSON.stringify((await api(tokCliente, `/chamados/${c1}`)).body).includes('PREPARO-OK'), 'cliente não vê o preparo');

    ok((await api(tokAdmin, `/agente/chaves/${chave.id}`, 'DELETE')).status === 200, 'admin revoga a chave');
    ok((await api(chave.texto, '/agente-servico/chamados/pendentes')).status === 401, '! chave revogada -> 401');
  } finally {
    const chs = (await pool.query('SELECT id FROM chamados WHERE cliente_id = $1', [cli])).rows.map(c => c.id);
    await pool.query('DELETE FROM chamados_analises WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM atendimentos WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados_status_log WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados_anexos WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [chs]);
    if (chave.id) await pool.query('DELETE FROM agente_chaves WHERE id = $1', [chave.id]);
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
