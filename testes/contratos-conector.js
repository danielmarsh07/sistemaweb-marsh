require('./_ambiente-local');
// Contratos do Conector por vagas: admin cria contrato com gestor e vagas por perfil; o gestor passa vagas
// no portal; o aluno vê só os cursos das trilhas do perfil, só os próprios chamados e fica fora de financeiro/licenças;
// SIDs do contrato até o limite; liberar vaga e suspender contrato cortam o acesso.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { incluirNoBeneficioPelaTrilha } = require('../backend/services/acessos');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const { ativarConvites } = require('../backend/services/contratos-conector'); // simula a pessoa aceitando o convite
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });

(async () => {
  const sufixo = Date.now();
  const cliA = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, cpf_cnpj, email, empresa_id, ativo)
     VALUES ('TESTE Vagas A', 'TESTE VAGAS A LTDA', '98765001000121', 'vagas-a@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const cliB = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
     VALUES ('TESTE Vagas B', 'TESTE VAGAS B LTDA', 'vagas-b@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  // Um curso de teste por trilha, publicado, com 2 aulas
  const cursos = {};
  const aulas = {};
  for (const t of ['abap', 'funcional', 'portal', 'conector']) {
    cursos[t] = (await pool.query(
      `INSERT INTO cursos (empresa_id, titulo, status, trilha, ordem) VALUES (1, $1, 'publicado', $2, 999) RETURNING id`,
      [`TESTE vagas ${t} ${sufixo}`, t])).rows[0].id;
    await incluirNoBeneficioPelaTrilha(cursos[t], t); // como a tela faz ao criar curso com trilha
    aulas[t] = [];
    for (let i = 0; i < 2; i++) {
      aulas[t].push((await pool.query(
        `INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, $2, $3) RETURNING id`,
        [cursos[t], `Aula ${i + 1}`, i])).rows[0].id);
    }
  }

  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
  const tokTecnico = tok({ id: 1, tipo: 'tecnico' });
  const api = async (t, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = `Bearer ${t}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const usuarioPorEmail = async e => (await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [e])).rows[0];
  const meusCursos = async t => ((await api(t, '/treinamentos/meus')).body || []).map(c => c.id);
  const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const emailGestor = `gestor-${sufixo}@teste.com`;
  const emailAluno = `aluno-${sufixo}@teste.com`;
  const emailAluno2 = `aluno2-${sufixo}@teste.com`;

  try {
    // --- Admin: validações e criação ---
    const base = { cliente_id: cliA, gestor_nome: 'Gestor Teste', gestor_email: emailGestor,
                   vagas: { abap: 1, funcional: 1, ambos: 1 }, data_fim: fim };
    ok((await api(tokTecnico, '/contratos-conector')).status === 403, 'técnico não lista contratos (403)');
    for (const [nome, extra] of [
      ['sem vagas', { vagas: { abap: 0 } }], ['vaga negativa', { vagas: { abap: -1 } }],
      ['sem cliente', { cliente_id: null }], ['sem data de fim', { data_fim: '' }],
      ['e-mail inválido', { gestor_email: 'x@' }], ['fim antes do início', { data_inicio: fim, data_fim: '2020-01-01' }],
      ['e-mail de usuário da equipe', { gestor_email: (await pool.query('SELECT email FROM usuarios WHERE id = 1')).rows[0].email }]
    ]) {
      const r = await api(tokAdmin, '/contratos-conector', 'POST', { ...base, ...extra });
      ok(r.status === 400, `! admin recusa ${nome} (${r.status} ${r.body?.erro || ''})`);
    }
    const cria = await api(tokAdmin, '/contratos-conector', 'POST', base);
    ok(cria.status === 201, `admin cria contrato com 3 vagas (${cria.status} ${cria.body?.mensagem || cria.body?.erro})`);
    const kid = cria.body.id;
    const gestor = await usuarioPorEmail(emailGestor);
    ok(gestor && gestor.tipo === 'cliente' && gestor.cliente_id === cliA && gestor.portal_papel === 'gestor', 'gestor criado como usuário do portal do cliente');
    const tokGestor = tok({ id: gestor.id, tipo: 'cliente', cliente_id: cliA });

    // --- Gestor no portal ---
    const eu = await api(tokGestor, '/contratos-conector/eu');
    ok(eu.body?.gestor === true && eu.body?.papel === 'gestor', '/eu: gestor');
    const meus = await api(tokGestor, '/contratos-conector/meus');
    ok(meus.status === 200 && meus.body.length === 1 && meus.body[0].vagas.length === 3, 'gestor vê o contrato com 3 vagas');
    const vaga = p => meus.body[0].vagas.find(v => v.perfil === p);
    ok(vaga('abap').cursos.includes('IA no ABAP') && !vaga('abap').cursos.includes('IA para Funcionais'), 'vaga ABAP lista os cursos do perfil');

    const tokOutro = tok({ id: await usuarioTeste(pool, { cliente_id: cliB }), tipo: 'cliente', cliente_id: cliB });
    ok((await api(tokOutro, '/contratos-conector/meus')).body.length === 0, 'outro cliente não vê o contrato');
    ok((await api(tokOutro, `/contratos-conector/meus/${kid}/vagas/${vaga('abap').id}/ocupar`, 'POST', { nome: 'X', email: 'x@x.com' })).status === 404,
      'outro cliente não ocupa vaga do contrato (404)');

    // Passar a vaga ABAP para um aluno novo
    let r = await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('abap').id}/ocupar`, 'POST', { email: emailAluno });
    ok(r.status === 400, `! sem nome para pessoa nova (${r.body?.erro})`);
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('abap').id}/ocupar`, 'POST', { nome: 'Aluno ABAP', email: emailAluno });
    ok(r.status === 200, `gestor passa a vaga ABAP (${r.body?.mensagem || r.body?.erro})`);
    const aluno = await usuarioPorEmail(emailAluno);
    ok(aluno && aluno.portal_papel === 'aluno' && aluno.cliente_id === cliA, 'aluno criado com papel aluno');
    ok((await pool.query('SELECT estado FROM contratos_conector_vagas WHERE id = $1', [vaga('abap').id])).rows[0].estado === 'convidada', 'pessoa nova: licença reservada como convite pendente');
    ok((await meusCursos(tok({ id: aluno.id, tipo: 'cliente', cliente_id: cliA }))).length === 0, 'convite pendente ainda não libera os cursos');
    await ativarConvites(aluno.id);
    const tokAluno = tok({ id: aluno.id, tipo: 'cliente', cliente_id: cliA });
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('abap').id}/ocupar`, 'POST', { nome: 'Outro', email: 'outro@x.com' });
    ok(r.status === 400, `! vaga já ocupada (${r.body?.erro})`);
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('funcional').id}/ocupar`, 'POST', { nome: 'Aluno ABAP', email: emailAluno });
    ok(r.status === 400, `! mesma pessoa em duas vagas do contrato (${r.body?.erro})`);

    // --- O que o aluno vê ---
    let ids = await meusCursos(tokAluno);
    ok(ids.includes(cursos.abap) && ids.includes(cursos.portal) && ids.includes(cursos.conector) && !ids.includes(cursos.funcional),
      'aluno ABAP vê ABAP + Portal + Conector, não Funcional');
    ok((await api(tokAluno, `/treinamentos/meus/${cursos.funcional}`)).status === 404, 'aluno não abre curso fora do perfil');
    ok((await api(tokAluno, `/treinamentos/meus/${cursos.abap}`)).status === 200, 'aluno abre curso do perfil');
    ok((await api(tokAluno, `/treinamentos/aulas/${aulas.funcional[0]}/concluir`, 'POST', {})).status === 404, 'aluno não conclui aula fora do perfil');
    ok((await api(tokAluno, `/treinamentos/aulas/${aulas.abap[0]}/concluir`, 'POST', {})).status === 200, 'aluno conclui aula do perfil');
    for (const p of ['/licencas/minhas', '/licencas/download']) {
      ok((await api(tokAluno, p)).status === 403, `aluno bloqueado em ${p}`);
    }
    // Chamados: o aluno entra, mas só vê os próprios (detalhes em testes/chamados-sap.js)
    const chAluno = await api(tokAluno, '/chamados');
    ok(chAluno.status === 200 && (chAluno.body.chamados || chAluno.body).length === 0, 'aluno acessa chamados e não vê os da empresa');
    // Financeiro: faturas da empresa só para o gestor; aluno e usuário comum do cliente (cadastrado pela equipe) não veem
    const fatId = (await pool.query(
      `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, status)
       VALUES (1, $1, date_trunc('month', CURRENT_DATE)::date, 'TESTE fatura da empresa', 100, CURRENT_DATE, 'aberta') RETURNING id`, [cliA])).rows[0].id;
    const faturasDe = async t => ((await api(t, '/financeiro/minhas-faturas')).body?.faturas || []).map(f => f.id);
    const tokComum = tok({ id: await usuarioTeste(pool, { cliente_id: cliA }), tipo: 'cliente', cliente_id: cliA });
    ok((await faturasDe(tokGestor)).includes(fatId), 'gestor vê as faturas da empresa');
    ok(!(await faturasDe(tokAluno)).includes(fatId), 'aluno da vaga não vê as faturas da empresa');
    ok(!(await faturasDe(tokComum)).includes(fatId), 'usuário comum do cliente não vê as faturas da empresa');
    ok((await api(tokAluno, '/contratos-conector/meus')).body.length === 0, 'aluno não vê o contrato');
    const euAluno = (await api(tokAluno, '/contratos-conector/eu')).body;
    ok(euAluno.papel === 'aluno' && !euAluno.gestor && euAluno.vagas.length === 1 && euAluno.vagas[0].perfil === 'abap', '/eu: aluno com a vaga ABAP');
    const meus2 = (await api(tokGestor, '/contratos-conector/meus')).body[0];
    ok(meus2.vagas.find(v => v.perfil === 'abap').aulas_concluidas === 1, 'gestor vê o progresso do aluno');
    const prog = (await api(tokAdmin, `/treinamentos/cursos/${cursos.abap}/progresso`)).body || [];
    ok(prog.some(p => p.nome === 'Aluno ABAP' && p.concluidas === 1), 'painel: progresso do curso inclui o aluno da vaga');

    // Gestor ocupa a vaga Ambos: passa a ver os 4 cursos e continua vendo o resto do portal
    ok((await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('ambos').id}/ocupar`, 'POST', { eu: true })).status === 200, 'gestor ocupa a vaga Ambos');
    ids = await meusCursos(tokGestor);
    ok(['abap', 'funcional', 'portal', 'conector'].every(t => ids.includes(cursos[t])), 'gestor na vaga Ambos vê os 4 cursos');
    ok((await api(tokGestor, '/chamados')).status === 200, 'gestor continua acessando chamados');

    // --- Sistemas SAP do contrato ---
    const cx = s => ({ sid: s, descricao: s, url: `https://${s.toLowerCase()}.exemplo:8000/`, mandante: '100', idioma: 'pt', usuario: 'NAO', senha: 'NAO' });
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/conexoes`, 'PUT', { conexoes: ['DEV', 'QAS', 'TST', 'HML'].map(cx) });
    ok(r.status === 400, `! mais SIDs que o limite (${r.body?.erro})`);
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/conexoes`, 'PUT', { conexoes: [cx('DEV'), { ...cx('QAS'), mandante: '1' }] });
    ok(r.status === 400, `! mandante inválido (${r.body?.erro})`);
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/conexoes`, 'PUT', { conexoes: [cx('DEV'), cx('QAS')] });
    ok(r.status === 200, 'gestor salva 2 sistemas SAP');
    const gravado = (await pool.query('SELECT conexoes FROM contratos_conector WHERE id = $1', [kid])).rows[0].conexoes;
    ok(gravado.length === 2 && !('senha' in gravado[0]) && gravado[0].idioma === 'PT' && !gravado[0].url.endsWith('/'), 'SIDs gravados sem usuário/senha, normalizados');
    ok((await api(tokAluno, `/contratos-conector/meus/${kid}/conexoes`, 'PUT', { conexoes: [] })).status === 404, 'aluno não edita SIDs');

    // --- Admin: vagas ---
    r = await api(tokAdmin, `/contratos-conector/${kid}/vagas`, 'POST', { funcional: 2 });
    ok(r.status === 201, 'admin acrescenta 2 vagas Funcional');
    let det = (await api(tokAdmin, `/contratos-conector/${kid}`)).body;
    ok(det.vagas.length === 5, 'contrato com 5 vagas');
    const livre = det.vagas.find(v => !v.usuario_id && v.id !== vaga('funcional').id);
    const ocupada = det.vagas.find(v => v.usuario_id && !v.eh_gestor);
    ok((await api(tokAdmin, `/contratos-conector/${kid}/vagas/${ocupada.id}`, 'DELETE')).status === 400, '! não remove vaga ocupada');
    ok((await api(tokAdmin, `/contratos-conector/${kid}/vagas/${livre.id}`, 'DELETE')).status === 200, 'admin remove vaga livre');
    r = await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { max_sids: 1 });
    ok(r.status === 400, `! limite de SIDs abaixo do já cadastrado (${r.body?.erro})`);

    // --- Liberar vaga: o aluno perde o acesso ---
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('abap').id}/liberar`, 'POST');
    ok(r.status === 200, 'gestor libera a vaga ABAP');
    ok((await meusCursos(tokAluno)).length === 0, 'aluno sem vaga não vê cursos');
    ok((await usuarioPorEmail(emailAluno)).ativo === true, 'aluno sem vaga mantém a conta (só perde o que vinha da vaga)');
    // Volta para a mesma pessoa: reativa e o progresso continua
    r = await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${vaga('abap').id}/ocupar`, 'POST', { email: emailAluno });
    ok(r.status === 200 && (await pool.query('SELECT estado FROM contratos_conector_vagas WHERE id = $1', [vaga('abap').id])).rows[0].estado === 'ativa', 'pessoa que já tem conta volta direto como ativa');
    const det2 = (await api(tokAdmin, `/contratos-conector/${kid}`)).body;
    ok(det2.vagas.find(v => v.id === vaga('abap').id).aulas_concluidas === 1, 'progresso guardado ao voltar');

    // Admin ocupa vaga Funcional com outra pessoa; contrato suspenso corta o acesso
    r = await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vaga('funcional').id}/ocupar`, 'POST', { nome: 'Aluno Func', email: emailAluno2 });
    ok(r.status === 200, 'admin passa a vaga Funcional');
    const aluno2 = await usuarioPorEmail(emailAluno2);
    await ativarConvites(aluno2.id);
    const tokAluno2 = tok({ id: aluno2.id, tipo: 'cliente', cliente_id: cliA });
    ids = await meusCursos(tokAluno2);
    ok(ids.includes(cursos.funcional) && !ids.includes(cursos.abap), 'aluno Funcional vê Funcional, não ABAP');
    ok((await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'suspenso' })).status === 200, 'admin suspende o contrato');
    ok((await meusCursos(tokAluno2)).length === 0, 'contrato suspenso: aluno sem cursos');
    ok((await api(tokGestor, `/contratos-conector/meus/${kid}/vagas/${det.vagas.find(v => !v.usuario_id && v.id !== livre.id).id}/ocupar`, 'POST',
      { nome: 'Z', email: `z-${sufixo}@teste.com` })).status === 400, '! contrato suspenso não aceita ocupar vaga');
    ok((await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'ativo', data_fim: '2020-01-01', data_inicio: '2019-01-01' })).status === 200, 'admin põe validade no passado');
    ok((await meusCursos(tokAluno2)).length === 0, 'contrato vencido: aluno sem cursos');

    // Curso com trilha inválida
    ok((await api(tokAdmin, `/treinamentos/cursos/${cursos.abap}`, 'PUT', { trilha: 'xyz' })).status === 400, '! trilha inválida no curso');
  } finally {
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id IN ($1, $2)', [cliA, cliB])).rows.map(u => u.id);
    const cids = Object.values(cursos);
    await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = ANY($1) OR aula_id IN (SELECT id FROM cursos_aulas WHERE curso_id = ANY($2))', [users, cids]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id IN (SELECT id FROM contratos_conector WHERE cliente_id IN ($1, $2))', [cliA, cliB]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id IN ($1, $2)', [cliA, cliB]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = ANY($1)', [cids]);
    await pool.query('DELETE FROM cursos WHERE id = ANY($1)', [cids]);
    await apagarUsuariosTeste(pool);
    await pool.query(`DELETE FROM faturas WHERE cliente_id IN ($1, $2) AND descricao = 'TESTE fatura da empresa'`, [cliA, cliB]);
    await pool.query('DELETE FROM clientes WHERE id IN ($1, $2)', [cliA, cliB]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
