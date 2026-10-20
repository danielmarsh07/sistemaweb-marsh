require('./_ambiente-local');
// Conector: sistema marcado como PRODUÇÃO (vai assinado na licença; o conector 0.6.0+ só lê), log central das
// consultas à produção (/log-producao: recebe, não duplica no reenvio, exige máquina ativada; admin lista e exporta
// CSV) e anexos do chamado aberto pelo conector (/chamados/:id/anexos, só para quem abriu).
// Servidor local com LICENCA_CHAVE_PRIVADA (assinatura) e, para os anexos, storage (s3mock; ver certificacao-conector.js).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const sufixo = Date.now();
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
     VALUES ('TESTE Prod', 'TESTE PRODUCAO LTDA', 'prod@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const api = async (tok, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* csv */ }
    return { status: r.status, body: json, texto };
  };
  const conector = (p, body) => api(null, `/licencas-conector${p}`, 'POST', body);
  const M = [hash(`m1-${sufixo}`), hash(`m2-${sufixo}`)];
  const uh = hash(`usuario-${sufixo}`);

  try {
    const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const cria = await api(tokAdmin, '/licencas', 'POST', {
      cliente_id: cli, plano: 'leitura', sids: 'DEV, PRD', data_fim: fim, titular_nome: 'Renan Teste', max_maquinas: 1,
      conexoes: [
        { sid: 'DEV', descricao: 'Desenvolvimento', url: 'https://dev.exemplo', porta: '8011', mandante: '200', idioma: 'PT' },
        { sid: 'PRD', descricao: 'Produção', url: 'https://prd.exemplo', porta: '8080', mandante: '400', idioma: 'PT', producao: true }] });
    ok(cria.status === 201, `licença com DEV e PRD (produção) criada (${cria.status})`);
    const lid = cria.body.id, chave = cria.body.chave;
    const g = (await pool.query('SELECT conexoes FROM licencas WHERE id = $1', [lid])).rows[0].conexoes;
    ok(g[1].producao === true && !('producao' in g[0]) && g[1].url === 'https://prd.exemplo:8080',
      'PRD gravado como produção (com a porta); DEV sem a marca');

    const at = await conector('/ativar', { chave, maquina_hash: M[0], nome_maquina: 'NB-RENAN', versao: '0.6.0' });
    ok(at.status === 200 && at.body.conexoes.find(c => c.sid === 'PRD').producao === true, '/ativar entrega o PRD marcado como produção');
    const v = await conector('/validar', { chave, sid: 'PRD', versao: '0.6.0', usuario_hash: uh, maquina_hash: M[0] });
    if (v.status === 503) ok(false, '/validar 503: servidor sem LICENCA_CHAVE_PRIVADA');
    else {
      const p = JSON.parse(v.body.licenca_json);
      ok(p.conexoes.find(c => c.sid === 'PRD').producao === true && !('producao' in p.conexoes.find(c => c.sid === 'DEV')),
        'licença assinada traz producao: true só no PRD');
    }

    // --- Log das consultas à produção ---
    const reg = (id, extra = {}) => ({ id, ts: new Date().toISOString(), sid: 'PRD', usuario: 'rfranco', ferramenta: 'run_select',
      parametros: { sql: "SELECT docnum FROM j_1bnfdoc WHERE docdat >= '20261001'", max_rows: 50 }, linhas: 12, status: 'ok', ms: 340, ...extra });
    const r1 = `r1-${sufixo}`, r2 = `r2-${sufixo}`;
    ok((await conector('/log-producao', { chave, usuario_hash: uh, maquina_hash: M[1], registros: [reg(r1)] })).status === 403,
      '! log de máquina não ativada -> 403');
    ok((await conector('/log-producao', { chave, usuario_hash: uh, maquina_hash: M[0], registros: [] })).status === 400,
      '! log sem registros -> 400');
    let r = await conector('/log-producao', { chave, usuario_hash: uh, maquina_hash: M[0],
      registros: [reg(r1), reg(r2, { ferramenta: 'get_source', parametros: { name: 'ZNFSE_PROC' }, linhas: undefined }),
                  reg(`r3-${sufixo}`, { sid: 'QAS' })] });
    ok(r.status === 200 && r.body.gravados === 2, `log grava 2 e ignora SID fora da licença (${JSON.stringify(r.body)})`);
    r = await conector('/log-producao', { chave, usuario_hash: uh, maquina_hash: M[0], registros: [reg(r1), reg(r2)] });
    ok(r.status === 200 && r.body.gravados === 0, 'reenvio do mesmo registro não duplica');
    const lista = await api(tokAdmin, `/licencas/log-producao?licenca_id=${lid}`);
    ok(lista.status === 200 && lista.body.length === 2 && lista.body.some(x => x.usuario_sap === 'RFRANCO' && x.linhas === 12
      && x.nome_maquina === 'NB-RENAN'), 'admin vê as 2 consultas (usuário SAP, máquina, linhas)');
    const csv = await api(tokAdmin, `/licencas/log-producao?cliente_id=${cli}&formato=csv`);
    ok(csv.status === 200 && csv.texto.includes('j_1bnfdoc') && csv.texto.includes('Usuário SAP') && csv.texto.includes('ZNFSE_PROC'),
      'CSV do cliente traz cabeçalho e o texto das consultas');
    ok((await api(tokAdmin, '/licencas/log-producao')).status === 400, '! log sem cliente_id nem licenca_id -> 400');

    // --- Anexos do chamado aberto pelo conector ---
    const ch = await conector('/chamados', { chave, sid: 'DEV', usuario_hash: uh, maquina_hash: M[0], titulo: 'Botão na ALV da ZNFSE',
      tipo: 'melhoria', modulo: 'FISCAL', pedido: 'Incluir botão', especificacao: '# Especificação\n...', solicitante_nome: 'Renan Teste' });
    ok(ch.status === 201, `chamado aberto pelo conector (${ch.status})`);
    const anexar = async (nome, conteudo, hashUsuario = uh) => {
      const form = new FormData();
      for (const [k, val] of Object.entries({ chave, usuario_hash: hashUsuario, maquina_hash: M[0] })) form.append(k, val);
      form.append('arquivo', new Blob([conteudo]), nome);
      const resp = await fetch(`${BASE}/licencas-conector/chamados/${ch.body.id}/anexos`, { method: 'POST', body: form });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    };
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077053e0000000c49444154789c63f8cfc000000301010018dd8db40000000049454e44ae426082', 'hex');
    const a1 = await anexar('tela-znfse.png', png);
    if (a1.status === 503) ok(true, 'anexos: servidor sem storage (503) — rode com o s3mock para testar o upload');
    else {
      ok(a1.status === 201, `anexo PNG incluído (${a1.status} ${a1.body?.erro || ''})`);
      ok((await anexar('evidencias.md', '# QAS x PRD')).status === 201, 'anexo .md incluído');
      const salvos = (await pool.query('SELECT nome_original, mime_type, usuario_id FROM chamados_anexos WHERE chamado_id = $1 ORDER BY id', [ch.body.id])).rows;
      ok(salvos.length === 2 && salvos[0].mime_type === 'image/png' && salvos[1].mime_type === 'text/markdown' && salvos[0].usuario_id === null,
        'anexos gravados no chamado com o tipo pela extensão');
    }
    ok((await anexar('virus.exe', 'MZ')).status === 400, '! extensão não aceita (.exe) -> 400');
    ok((await anexar('tela.png', png, hash('outro'))).status === 404, '! anexar no chamado de outro consultor -> 404');
  } finally {
    const lics = (await pool.query('SELECT id FROM licencas WHERE cliente_id = $1', [cli])).rows.map(l => l.id);
    const chs = (await pool.query('SELECT id FROM chamados WHERE licenca_id = ANY($1)', [lics])).rows.map(c => c.id);
    await pool.query('DELETE FROM chamados_anexos WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados_status_log WHERE chamado_id = ANY($1)', [chs]);
    await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [chs]);
    await pool.query('DELETE FROM conector_log_producao WHERE licenca_id = ANY($1)', [lics]);
    await pool.query('DELETE FROM licencas_ativacoes WHERE licenca_id = ANY($1)', [lics]);
    await pool.query('DELETE FROM licencas WHERE id = ANY($1)', [lics]);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
