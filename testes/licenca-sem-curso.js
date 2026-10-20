require('./_ambiente-local');
// Exceção do contrato do Conector (licenca_sem_curso): quem ocupa a vaga recebe a licença e o instalador
// sem concluir os cursos; o certificado não é emitido. Sem a marcação, nada muda (sem licença antes dos cursos).
// Os sistemas SAP do contrato (até 10) chegam à licença da pessoa.
// Precisa do servidor local: npm run dev:local
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { ativarConvites } = require('../backend/services/contratos-conector'); // simula o aceite do convite
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });

(async () => {
  const sufixo = Date.now();
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
     VALUES ('TESTE SemCurso', 'TESTE SEM CURSO LTDA', 'semcurso@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  // Um curso publicado no perfil Funcional garante que a pessoa NÃO concluiu o perfil
  const curso = (await pool.query(
    `INSERT INTO cursos (empresa_id, titulo, status, trilha, ordem, carga_horaria) VALUES (1, $1, 'publicado', 'funcional', 998, '~1 h') RETURNING id`,
    [`TESTE sem curso ${sufixo}`])).rows[0].id;
  await require('../backend/services/acessos').incluirNoBeneficioPelaTrilha(curso, 'funcional');
  await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, 'Aula 1', 0)`, [curso]);

  const api = async (t, p, m = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = `Bearer ${t}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
  const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const cx = s => ({ sid: s, descricao: s, url: `https://${s.toLowerCase()}.exemplo:8000`, mandante: '100', idioma: 'PT' });

  try {
    const k = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'Gestor SemCurso',
      gestor_email: `gestor-semcurso-${sufixo}@teste.com`, vagas: { funcional: 2 }, data_fim: fim });
    ok(k.status === 201, 'contrato criado');
    const kid = k.body.id;
    await api(tokAdmin, `/contratos-conector/${kid}/conexoes`, 'PUT', { conexoes: [cx('DEV'), cx('QAS'), cx('PRD')] });
    const [v1] = (await api(tokAdmin, `/contratos-conector/${kid}`)).body.vagas;
    await api(tokAdmin, `/contratos-conector/${kid}/vagas/${v1.id}/ocupar`, 'POST', { nome: 'Renan Teste', email: `renan-${sufixo}@teste.com` });
    const renan = (await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [`renan-${sufixo}@teste.com`])).rows[0];
    await ativarConvites(renan.id);
    const tokRenan = tok({ id: renan.id, tipo: 'cliente', cliente_id: cli });

    // Sem a exceção: nada antes dos cursos
    let vaga = (await api(tokRenan, '/contratos-conector/eu')).body.vagas[0];
    ok(vaga && !vaga.certificado && !vaga.licenca, 'sem a exceção: sem certificado nem licença');
    ok((await api(tokRenan, `/contratos-conector/eu/vagas/${v1.id}/pacote`)).status === 403, 'sem a exceção: instalador bloqueado');

    // Com a exceção: licença com o nome da pessoa e os 3 sistemas, sem certificado
    await pool.query('UPDATE contratos_conector SET licenca_sem_curso = TRUE WHERE id = $1', [kid]);
    vaga = (await api(tokRenan, '/contratos-conector/eu')).body.vagas[0];
    ok(vaga.licenca && vaga.licenca.status === 'ativa' && !vaga.certificado, 'com a exceção: licença ativa, sem certificado');
    const l = (await pool.query('SELECT * FROM licencas WHERE vaga_id = $1 AND usuario_id = $2', [v1.id, renan.id])).rows[0];
    ok(l && l.titular_nome === 'Renan Teste' && l.sids === 'DEV,QAS,PRD' && l.conexoes.length === 3,
      `licença no nome da pessoa com DEV, QAS e PRD (${l && l.titular_nome} · ${l && l.sids})`);
    ok(!(await pool.query('SELECT 1 FROM certificados WHERE usuario_id = $1', [renan.id])).rows.length, 'nenhum certificado emitido');
    ok((await api(tokRenan, `/contratos-conector/eu/vagas/${v1.id}/pacote`)).status === 200, 'com a exceção: instalador liberado');

    // Chamar de novo não duplica a licença
    await api(tokRenan, '/contratos-conector/eu');
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM licencas WHERE usuario_id = $1', [renan.id])).rows[0].n;
    ok(n === 1, `uma licença só (${n})`);

    // Contrato ganha sistemas: a licença da pessoa acompanha e a lista de contratos traz os sistemas (licença nova usa)
    const cinco = ['DEV', 'QAS', 'PRD', 'HDV', 'FIO'].map(cx);
    ok((await api(tokAdmin, `/contratos-conector/${kid}/conexoes`, 'PUT', { conexoes: cinco })).status === 200, 'admin salva 5 sistemas no contrato');
    const l2 = (await pool.query('SELECT sids, conexoes FROM licencas WHERE vaga_id = $1 AND usuario_id = $2', [v1.id, renan.id])).rows[0];
    ok(l2.sids === 'DEV,QAS,PRD,HDV,FIO' && l2.conexoes.length === 5, `licença da pessoa com os 5 sistemas (${l2.sids})`);
    const naLista = (await api(tokAdmin, '/contratos-conector')).body.find(c => c.id === kid);
    ok(naLista && naLista.conexoes.length === 5, 'lista de contratos traz os sistemas do contrato');
  } finally {
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(u => u.id);
    const lics = (await pool.query('SELECT id FROM licencas WHERE cliente_id = $1', [cli])).rows.map(l => l.id);
    await pool.query('DELETE FROM licencas_ativacoes WHERE licenca_id = ANY($1)', [lics]);
    await pool.query('DELETE FROM licencas WHERE id = ANY($1)', [lics]);
    await pool.query('DELETE FROM certificados WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id IN (SELECT id FROM contratos_conector WHERE cliente_id = $1)', [cli]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM beneficios WHERE curso_id = $1', [curso]);
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = $1', [curso]);
    await pool.query('DELETE FROM cursos WHERE id = $1', [curso]);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
