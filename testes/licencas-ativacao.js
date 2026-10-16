require('./_ambiente-local');
// Licenças do conector: ativação por máquina (instalador), limite de máquinas, revogação,
// conexões SAP pré-preenchidas, /validar com e sem maquina_hash, /minhas e /download do portal.
// O servidor local precisa de LICENCA_CHAVE_PRIVADA no ambiente para /validar assinar (senão 503).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';

const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const sufixo = Date.now();
  const cliA = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
     VALUES ('TESTE Lic A', 'TESTE LICENCA A LTDA', 'lic-a@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const cliB = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
     VALUES ('TESTE Lic B', 'TESTE LICENCA B LTDA', 'lic-b@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const licIds = [];

  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokTecnico = jwt.sign({ id: 1, tipo: 'tecnico', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokCliA = jwt.sign({ id: await usuarioTeste(pool, { cliente_id: cliA }), tipo: 'cliente', empresa_id: 1, cliente_id: cliA }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokCliB = jwt.sign({ id: await usuarioTeste(pool, { cliente_id: cliB }), tipo: 'cliente', empresa_id: 1, cliente_id: cliB }, process.env.JWT_SECRET, { expiresIn: '5m' });

  const api = async (tok, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const conector = (p, body) => api(null, `/licencas-conector${p}`, 'POST', body);

  try {
    const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const conexoes = [
      { sid: 'DEV', descricao: 'Desenvolvimento', url: 'https://idce07.multi.dom:8011', mandante: '200', idioma: 'PT', usuario: 'NAO_GUARDA', senha: 'x' },
      { sid: 'qas', descricao: 'Qualidade', url: 'https://idcq07.multi.dom:8011/', mandante: '300', idioma: 'pt' },
      { sid: 'PRD', descricao: 'Produção', url: 'https://idcp07.multi.dom:8011', mandante: '400', idioma: 'PT' }
    ];
    const base = { cliente_id: cliA, plano: 'leitura', sids: 'DEV, QAS', data_fim: fim,
                   titular_nome: 'Fulano Funcional', titular_email: 'fulano@cliente.com.br', max_maquinas: 2, conexoes };

    // --- Validações do admin (400) ---
    const invalidos = [
      ['SID com 4 letras', { conexoes: [{ ...conexoes[0], sid: 'DEVX' }] }],
      ['URL sem http', { conexoes: [{ ...conexoes[0], url: 'idce07.multi.dom:8011' }] }],
      ['mandante com 2 dígitos', { conexoes: [{ ...conexoes[0], mandante: '20' }] }],
      ['idioma com 3 letras', { conexoes: [{ ...conexoes[0], idioma: 'POR' }] }],
      ['mais de 10 conexões', { conexoes: Array.from({ length: 11 }, () => conexoes[0]) }],
      ['conexões não-lista', { conexoes: 'DEV' }],
      ['duas conexões com o mesmo SID', { conexoes: [conexoes[0], { ...conexoes[0], sid: 'dev', mandante: '210' }] }],
      ['e-mail do titular inválido', { titular_email: 'fulano@' }],
      ['max_maquinas = 0', { max_maquinas: 0 }],
      ['max_maquinas fracionado', { max_maquinas: 1.5 }]
    ];
    for (const [nome, extra] of invalidos) {
      const r = await api(tokAdmin, '/licencas', 'POST', { ...base, ...extra });
      ok(r.status === 400, `! admin recusa ${nome} (${r.status} ${r.body?.erro || ''})`);
    }

    // --- Criação ---
    const cria = await api(tokAdmin, '/licencas', 'POST', base);
    ok(cria.status === 201 && /^MRSH-/.test(cria.body?.chave || ''), `admin cria licença com titular/máquinas/conexões (${cria.status})`);
    const lid = cria.body.id; licIds.push(lid);
    const chave = cria.body.chave;
    const gravada = (await pool.query('SELECT conexoes, max_maquinas, titular_email FROM licencas WHERE id = $1', [lid])).rows[0];
    ok(gravada.conexoes.length === 3 && !('usuario' in gravada.conexoes[0]) && !('senha' in gravada.conexoes[0]),
      'conexões gravadas sem usuário/senha');
    ok(gravada.conexoes[1].sid === 'QAS' && gravada.conexoes[1].idioma === 'PT' && !gravada.conexoes[1].url.endsWith('/'),
      'conexões normalizadas (SID/idioma em maiúsculas, URL sem barra final)');

    const M = [1, 2, 3, 4].map(i => hash(`maquina-teste-${sufixo}-${i}`));
    const ativar = (i, extra = {}) => conector('/ativar', {
      chave, maquina_hash: M[i - 1], nome_maquina: `NB-TESTE-${i}`, usuario_windows: `MULTI\\fulano${i}`, versao: '1.0.0', ...extra });

    // --- /ativar: corpo inválido (400) e chave errada (403) ---
    ok((await conector('/ativar', { chave, nome_maquina: 'NB' })).status === 400, '! /ativar sem maquina_hash -> 400');
    ok((await conector('/ativar', { chave, maquina_hash: 'g'.repeat(64), nome_maquina: 'NB' })).status === 400, '! /ativar com maquina_hash não-hex -> 400');
    ok((await conector('/ativar', { chave, maquina_hash: M[0] })).status === 400, '! /ativar sem nome_maquina -> 400');
    ok((await conector('/ativar', { chave, maquina_hash: M[0], nome_maquina: 'x'.repeat(101) })).status === 400, '! /ativar com nome_maquina > 100 -> 400');
    ok((await conector('/ativar', { chave, maquina_hash: M[0], nome_maquina: 'NB', usuario_windows: 'u'.repeat(101) })).status === 400, '! /ativar com usuario_windows > 100 -> 400');
    const errada = await conector('/ativar', { chave: 'MRSH-AAAA-BBBB-CCCC', maquina_hash: M[0], nome_maquina: 'NB' });
    ok(errada.status === 403 && errada.body?.motivo === 'chave', `! /ativar com chave errada -> 403 chave`);

    // --- /ativar ok ---
    const a1 = await ativar(1);
    const b1 = a1.body || {};
    ok(a1.status === 200, `/ativar máquina 1 (${a1.status} ${b1.erro || ''})`);
    ok(b1.cliente === 'TESTE LICENCA A LTDA' && b1.titular_nome === 'Fulano Funcional' && b1.titular_email === 'fulano@cliente.com.br',
      '/ativar devolve cliente e titular');
    ok(b1.plano === 'leitura' && b1.permite_escrita === false && b1.data_fim === fim && b1.max_maquinas === 2,
      '/ativar devolve plano, permite_escrita, data_fim AAAA-MM-DD e max_maquinas');
    ok(JSON.stringify(b1.sids) === '["DEV","QAS"]', `/ativar devolve sids (${JSON.stringify(b1.sids)})`);
    ok(Array.isArray(b1.conexoes) && b1.conexoes.map(c => c.sid).join(',') === 'DEV,QAS',
      `/ativar filtra conexões pelos sids (${(b1.conexoes || []).map(c => c.sid).join(',')})`);
    ok(b1.conexoes?.[0]?.url === 'https://idce07.multi.dom:8011' && b1.conexoes[0].mandante === '200',
      '/ativar devolve url e mandante da conexão');

    const a1b = await ativar(1, { nome_maquina: 'NB-TESTE-1-RENOMEADO', versao: '1.0.1' });
    const lin1 = (await pool.query('SELECT COUNT(*)::int AS n, MAX(nome_maquina) AS nome, MAX(versao_conector) AS v FROM licencas_ativacoes WHERE licenca_id = $1', [lid])).rows[0];
    ok(a1b.status === 200 && lin1.n === 1 && lin1.nome === 'NB-TESTE-1-RENOMEADO' && lin1.v === '1.0.1',
      'reativar a mesma máquina: 200, sem nova linha, nome/versão atualizados');

    ok((await ativar(2)).status === 200, '/ativar máquina 2');
    const a3 = await ativar(3);
    ok(a3.status === 403 && a3.body?.motivo === 'maquinas', `! /ativar máquina 3 com limite 2 -> 403 maquinas (${a3.status} ${a3.body?.motivo})`);
    ok((await ativar(2)).status === 200, 'máquina já ativada continua ativando com o limite cheio');

    // --- Painel admin ---
    const lista = await api(tokAdmin, '/licencas');
    const li = (lista.body || []).find(x => x.id === lid) || {};
    ok(li.titular_nome === 'Fulano Funcional' && li.titular_email === 'fulano@cliente.com.br' && li.max_maquinas === 2 && Array.isArray(li.conexoes),
      'GET /licencas traz titular, max_maquinas e conexões');
    ok(li.maquinas_ativas === 2 && li.maquinas_online_24h === 2, `GET /licencas traz maquinas_ativas=2 e online_24h=2 (${li.maquinas_ativas}/${li.maquinas_online_24h})`);

    let maqs = await api(tokAdmin, `/licencas/${lid}/maquinas`);
    ok(maqs.status === 200 && maqs.body.length === 2 && maqs.body[0].nome_maquina && maqs.body[0].usuario_windows && !('maquina_hash' in maqs.body[0]),
      'GET /:id/maquinas lista as ativações (sem expor o hash)');
    const mid = n => maqs.body.find(x => x.nome_maquina.startsWith(`NB-TESTE-${n}`))?.id;
    const mid1 = mid(1), mid2 = mid(2);
    ok((await api(tokTecnico, `/licencas/${lid}/maquinas`)).status === 403, '! técnico não vê máquinas');

    // --- Revogar ---
    ok((await api(tokAdmin, `/licencas/${lid}/maquinas/${mid1}/revogar`, 'POST')).status === 200, 'admin revoga máquina 1');
    const r1 = await ativar(1);
    ok(r1.status === 403 && r1.body?.motivo === 'maquina_revogada', `! /ativar máquina revogada -> 403 maquina_revogada (${r1.body?.motivo})`);
    const uh = hash(`usuario-${sufixo}`);
    const v1 = await conector('/validar', { chave, sid: 'DEV', versao: '1.0.1', usuario_hash: uh, maquina_hash: M[0], nome_maquina: 'NB-TESTE-1' });
    ok(v1.status === 403 && v1.body?.motivo === 'maquina_revogada', `! /validar máquina revogada -> 403 maquina_revogada (${v1.status} ${v1.body?.motivo})`);

    // vaga liberada: a máquina 3 entra
    ok((await ativar(3)).status === 200, 'com a máquina 1 revogada, a máquina 3 ativa');
    maqs = await api(tokAdmin, `/licencas/${lid}/maquinas`);
    ok(maqs.body[maqs.body.length - 1].id === mid1 && maqs.body[maqs.body.length - 1].revogada === true, 'revogadas aparecem por último');
    const mid3 = mid(3);
    const re409 = await api(tokAdmin, `/licencas/${lid}/maquinas/${mid1}/reativar`, 'POST');
    ok(re409.status === 409, `! reativar com o limite cheio -> 409 (${re409.status})`);
    ok((await api(tokAdmin, `/licencas/${lid}/maquinas/${mid3}/revogar`, 'POST')).status === 200, 'admin revoga máquina 3');
    ok((await api(tokAdmin, `/licencas/${lid}/maquinas/${mid1}/reativar`, 'POST')).status === 200, 'admin reativa máquina 1');
    ok((await ativar(1)).status === 200, 'máquina 1 reativada volta a ativar');
    ok((await api(tokAdmin, `/licencas/${lid}/maquinas/999999999/revogar`, 'POST')).status === 404, '! revogar máquina inexistente -> 404');

    // --- /validar ---
    const chavePub = await fetch(`${BASE}/licencas-conector/chave-publica`);
    const pem = chavePub.ok ? await chavePub.text() : null;
    const confere = b => pem && crypto.verify(null, Buffer.from(b.licenca_json, 'utf8'), crypto.createPublicKey(pem), Buffer.from(b.assinatura, 'base64'));

    const vSem = await conector('/validar', { chave, sid: 'DEV', versao: '1.0.1', usuario_hash: uh });
    if (vSem.status === 503) {
      ok(false, '/validar 503: servidor sem LICENCA_CHAVE_PRIVADA (testes de assinatura não rodaram)');
    } else {
      const p = JSON.parse(vSem.body.licenca_json);
      ok(vSem.status === 200 && confere(vSem.body) && !('maquina_hash' in p), '/validar sem maquina_hash continua ok (assinado, sem maquina_hash)');
      ok(JSON.stringify(p.conexoes) === JSON.stringify([
           { sid: 'DEV', url: 'https://idce07.multi.dom:8011', mandante: '200' },
           { sid: 'QAS', url: 'https://idcq07.multi.dom:8011', mandante: '300' }]),
        `payload assinado traz conexoes {sid,url,mandante} só dos SIDs da licença (${JSON.stringify(p.conexoes)})`);
      const vCom = await conector('/validar', { chave, sid: 'QAS', versao: '1.0.1', usuario_hash: uh, maquina_hash: M[1], nome_maquina: 'NB-TESTE-2' });
      const pc = vCom.status === 200 ? JSON.parse(vCom.body.licenca_json) : {};
      ok(vCom.status === 200 && confere(vCom.body) && pc.maquina_hash === M[1], '/validar com maquina_hash traz maquina_hash no payload assinado');
    }
    const vNova = await conector('/validar', { chave, sid: 'DEV', usuario_hash: uh, maquina_hash: M[3], nome_maquina: 'NB-TESTE-4' });
    ok(vNova.status === 403 && vNova.body?.motivo === 'maquinas', `! /validar máquina nova com limite cheio -> 403 maquinas (${vNova.body?.motivo})`);
    ok((await conector('/validar', { chave, sid: 'DEV', usuario_hash: uh, maquina_hash: 'abc' })).status === 400, '! /validar com maquina_hash inválido -> 400');

    // --- PUT: validações e limite ilimitado ---
    ok((await api(tokAdmin, `/licencas/${lid}`, 'PUT', { conexoes: [{ sid: 'DEV', url: 'ftp://x', mandante: '200', idioma: 'PT' }] })).status === 400,
      '! PUT recusa conexão com URL ftp');
    ok((await api(tokAdmin, `/licencas/${lid}`, 'PUT', { titular_email: 'sem-arroba' })).status === 400, '! PUT recusa e-mail inválido');
    const put = await api(tokAdmin, `/licencas/${lid}`, 'PUT', { max_maquinas: '', titular_nome: 'Beltrano', conexoes: [conexoes[0]] });
    ok(put.status === 200, `PUT limpa max_maquinas (ilimitado), troca titular e conexões (${put.status})`);
    const a4 = await ativar(4);
    ok(a4.status === 200 && a4.body.max_maquinas === null && a4.body.titular_nome === 'Beltrano' && a4.body.conexoes.length === 1,
      'sem limite a máquina 4 ativa; /ativar reflete o PUT');

    // --- Portal: /minhas e /download ---
    const minhas = await api(tokCliA, '/licencas/minhas');
    const m0 = (minhas.body || []).find(x => x.id === lid) || {};
    ok(minhas.status === 200 && m0.titular_nome === 'Beltrano' && m0.max_maquinas === null && m0.maquinas_ativas === 3 &&
       Array.isArray(m0.conexoes) && m0.conexoes.length === 1, `/minhas traz titular, max_maquinas, maquinas_ativas e conexões (${m0.maquinas_ativas})`);
    ok(!('chave_hash' in m0) && !('titular_email' in m0), '/minhas não expõe hash da chave');

    const dA = await api(tokCliA, '/licencas/download');
    ok(dA.status === 200 && 'url' in dA.body && 'versao' in dA.body, `/download para cliente com licença ativa (url=${dA.body?.url}, versao=${dA.body?.versao})`);
    ok((await api(tokCliB, '/licencas/download')).status === 403, '! /download para cliente sem licença -> 403');
    ok((await api(tokAdmin, '/licencas/download')).status === 200, '/download para admin');
    ok((await api(tokTecnico, '/licencas/download')).status === 403, '! /download para técnico -> 403');

    // --- Sem conexões cadastradas: payload assinado traz lista vazia ---
    await api(tokAdmin, `/licencas/${lid}`, 'PUT', { conexoes: [] });
    const vVazia = await conector('/validar', { chave, sid: 'DEV', usuario_hash: uh, maquina_hash: M[0] });
    if (vVazia.status !== 503) {
      const pv = vVazia.status === 200 ? JSON.parse(vVazia.body.licenca_json) : {};
      ok(vVazia.status === 200 && Array.isArray(pv.conexoes) && pv.conexoes.length === 0,
        `licença sem conexões: payload assinado traz conexoes = [] (${vVazia.status})`);
    }

    // --- Contrato: suspensa e vencida ---
    await api(tokAdmin, `/licencas/${lid}`, 'PUT', { status: 'suspensa' });
    const s = await ativar(1);
    ok(s.status === 403 && s.body?.motivo === 'suspensa', `! /ativar licença suspensa -> 403 suspensa (${s.body?.motivo})`);
    ok((await api(tokCliA, '/licencas/download')).status === 403, '! /download com licença suspensa -> 403');
    await pool.query(`UPDATE licencas SET status = 'ativa', data_fim = CURRENT_DATE - 1 WHERE id = $1`, [lid]);
    const venc = await ativar(1);
    ok(venc.status === 403 && venc.body?.motivo === 'vencida', `! /ativar licença vencida -> 403 vencida (${venc.body?.motivo})`);
    await api(tokAdmin, `/licencas/${lid}`, 'DELETE');
    const canc = await ativar(1);
    ok(canc.status === 403 && canc.body?.motivo === 'chave', `! /ativar licença cancelada -> 403 (${canc.body?.motivo})`);
  } finally {
    if (licIds.length) {
      await pool.query('DELETE FROM licencas_ativacoes WHERE licenca_id = ANY($1)', [licIds]);
      await pool.query('DELETE FROM licencas_uso WHERE licenca_id = ANY($1)', [licIds]);
    }
    await pool.query('DELETE FROM licencas WHERE cliente_id IN ($1, $2)', [cliA, cliB]);
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM clientes WHERE id IN ($1, $2)', [cliA, cliB]);
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
