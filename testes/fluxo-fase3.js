require('./_ambiente-local');
// Fluxo novo — fase 3 (docs/plano-fluxo-novo.md): direitos de acesso com origem e benefícios do Conector.
// Cenários 10 a 15, 18 e 19 do documento: curso gratuito pela licença, revogação bloqueia o curso gratuito,
// histórico acadêmico preservado, curso comprado continua, renovação restabelece, contrato vencido, revogação
// concorrente com acesso, mesmo curso por duas origens. Mais: cadastro de benefícios e liberação individual.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const senhas = require('../backend/services/senhas');
const acessos = require('../backend/services/acessos');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokAdmin = tok({ id: 1, tipo: 'admin_empresa', nome: 'Admin Teste' });
const api = async (t, p, m = 'GET', body) => {
  const h = { 'Content-Type': 'application/json' };
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const sufixo = Date.now();
  const cli = (await pool.query(`INSERT INTO clientes (nome, empresa_id, ativo) VALUES ($1, 1, TRUE) RETURNING id`, [`TESTE F3 Cloud CCM ${sufixo}`])).rows[0].id;
  const cursos = {};
  const novoCurso = async (nome, trilha) => {
    const id = (await pool.query(`INSERT INTO cursos (empresa_id, titulo, status, trilha, ordem) VALUES (1, $1, 'publicado', $2, 997) RETURNING id`,
      [`TESTE F3 ${nome} ${sufixo}`, trilha])).rows[0].id;
    await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, 'Aula 1', 0), ($1, 'Aula 2', 1)`, [id]);
    await acessos.incluirNoBeneficioPelaTrilha(id, trilha);
    return id;
  };
  cursos.cpi = await novoCurso('SAP CPI', 'abap');          // gratuito pela licença ABAP
  cursos.cloud = await novoCurso('Integrações Cloud', 'abap'); // gratuito pela licença ABAP
  cursos.abapAv = await novoCurso('ABAP Avançado', null);    // fora do benefício: só comprando
  cursos.extra = await novoCurso('Workshop', null);          // para a liberação individual
  const beneficiosAntes = (await api(tokAdmin, '/treinamentos/beneficios')).body.marcados;
  const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const meus = async t => {
    const r = await api(t, '/treinamentos/meus');
    return Object.fromEntries((r.body || []).filter(c => Object.values(cursos).includes(c.id)).map(c => [c.id, c]));
  };
  const direito = async (uid, curso, origem) => (await pool.query(
    'SELECT * FROM direitos_acesso WHERE usuario_id = $1 AND curso_id = $2 AND origem = $3', [uid, curso, origem])).rows[0];

  try {
    // Contrato com 1 licença ABAP; João recebe o convite e cria a senha (fluxo real: o aceite libera os cursos)
    const k = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'Admin F3', gestor_email: `adm-f3-${sufixo}@teste.com`, vagas: { abap: 1 }, data_fim: fim });
    const kid = k.body.id;
    const admin = (await pool.query('SELECT id FROM usuarios WHERE email = $1', [`adm-f3-${sufixo}@teste.com`])).rows[0];
    const tokAdm = tok({ id: admin.id, tipo: 'cliente', cliente_id: cli });
    const conv = await api(tokAdm, `/contratos-conector/meus/${kid}/convidar`, 'POST', { perfil: 'abap', nome: 'João', email: `joao-f3-${sufixo}@teste.com` });
    const vagaId = conv.body.vaga_id;
    const joao = (await pool.query('SELECT * FROM usuarios WHERE email = $1', [`joao-f3-${sufixo}@teste.com`])).rows[0];
    ok(Object.keys(await meus(tok({ id: joao.id, tipo: 'cliente', cliente_id: cli }))).length === 0, 'convite pendente: nenhum curso ainda');
    const { link } = await senhas.enviarLink(joao, 'convite');
    await api(null, '/auth/definir-senha', 'POST', { token: new URL(link).searchParams.get('t'), senha: 'Senha1234' });
    // Criar a senha encerra sessões antigas (fase 0): entra de novo, como a pessoa faria
    const tokJoao = (await api(null, '/auth/login', 'POST', { email: joao.email, senha: 'Senha1234' })).body.token;

    // --- Cenário 10: cursos gratuitos pela licença ---
    let m = await meus(tokJoao);
    ok(m[cursos.cpi]?.via_beneficio && m[cursos.cloud]?.via_beneficio && !m[cursos.abapAv], 'licença ativa: SAP CPI e Integrações Cloud liberados, ABAP Avançado não');
    let d = await direito(joao.id, cursos.cpi, 'beneficio');
    ok(d && d.status === 'ativo' && d.origem_id === vagaId && /Licença do Conector abap/.test(d.origem_descricao), 'direito registrado com origem: licença do Conector (vaga e contrato)');
    ok((await pool.query('SELECT 1 FROM matriculas WHERE usuario_id = $1 AND curso_id = $2', [joao.id, cursos.cloud])).rows.length === 1, 'matrícula criada');
    // Progresso no curso gratuito
    const aulaCloud = (await pool.query('SELECT id FROM cursos_aulas WHERE curso_id = $1 ORDER BY ordem LIMIT 1', [cursos.cloud])).rows[0].id;
    ok((await api(tokJoao, `/treinamentos/aulas/${aulaCloud}/concluir`, 'POST', {})).status === 200, 'João conclui uma aula do curso gratuito');

    // --- Compra individual (fase 4 grava por aqui) e o mesmo curso por duas origens ---
    await acessos.conceder({ usuarioId: joao.id, cursoId: cursos.abapAv, origem: 'compra', origemId: 900000 + (sufixo % 1000), descricao: 'Pedido de teste' });
    await acessos.conceder({ usuarioId: joao.id, cursoId: cursos.cpi, origem: 'compra', origemId: 900001, descricao: 'Pedido de teste 2' });
    m = await meus(tokJoao);
    ok(m[cursos.abapAv]?.via_compra && !m[cursos.abapAv]?.via_beneficio, 'curso comprado aparece como próprio');
    ok(m[cursos.cpi]?.via_compra && m[cursos.cpi]?.via_beneficio, 'SAP CPI com duas origens: licença e compra');

    // --- Cenário 18: revogação concorrente com acesso; Cenário 11: revogação bloqueia o gratuito ---
    const [lib] = await Promise.all([
      api(tokAdm, `/contratos-conector/meus/${kid}/vagas/${vagaId}/liberar`, 'POST'),
      api(tokJoao, `/treinamentos/meus/${cursos.cloud}`)
    ]);
    ok(lib.status === 200, 'administrador revoga a licença do João');
    ok((await api(tokJoao, `/treinamentos/meus/${cursos.cloud}`)).status === 404, 'logo depois: curso gratuito bloqueado (sem esperar sessão expirar)');
    ok((await api(tokJoao, `/treinamentos/aulas/${aulaCloud}/concluir`, 'POST', {})).status === 404, 'nem marcar aula do curso gratuito');
    m = await meus(tokJoao);
    ok(!m[cursos.cloud], 'Integrações Cloud some de "Meus cursos"');
    // Cenário 19 e 13: o que tem outra origem continua
    ok(m[cursos.cpi]?.via_compra && !m[cursos.cpi]?.via_beneficio, 'SAP CPI continua pela compra (perder a licença não tira a outra origem)');
    ok(m[cursos.abapAv]?.via_compra, 'ABAP Avançado comprado continua');
    d = await direito(joao.id, cursos.cloud, 'beneficio');
    ok(d.status === 'revogado' && d.motivo === 'Licença do Conector revogada' && d.revogado_em, `direito gratuito revogado com motivo (${d.motivo})`);
    // Cenário 12: histórico acadêmico preservado
    ok((await pool.query('SELECT 1 FROM cursos_progresso WHERE usuario_id = $1 AND aula_id = $2', [joao.id, aulaCloud])).rows.length === 1, 'progresso guardado');
    ok((await pool.query('SELECT 1 FROM matriculas WHERE usuario_id = $1 AND curso_id = $2', [joao.id, cursos.cloud])).rows.length === 1, 'matrícula guardada');
    const prog = (await api(tokAdmin, `/treinamentos/cursos/${cursos.cloud}/progresso`)).body.find(p => p.nome === 'João');
    ok(prog && prog.acesso_atual === false && prog.concluidas === 1, 'painel: João aparece com o progresso e sem acesso');

    // --- Cenário 14: a licença volta e o benefício é restabelecido ---
    ok((await api(tokAdm, `/contratos-conector/meus/${kid}/vagas/${vagaId}/ocupar`, 'POST', { email: joao.email })).status === 200, 'João recebe a licença de novo');
    m = await meus(tokJoao);
    ok(m[cursos.cloud]?.via_beneficio, 'Integrações Cloud volta');
    d = await direito(joao.id, cursos.cloud, 'beneficio');
    ok(d.status === 'ativo' && !d.motivo, 'mesmo direito reativado');
    const aud = (await pool.query(`SELECT acao FROM auditoria WHERE entidade = 'direito_acesso' AND entidade_id = $1 ORDER BY id`, [d.id])).rows.map(r => r.acao);
    ok(aud.join(',') === 'acesso.concedido,acesso.revogado,acesso.restabelecido', `rastro completo (${aud.join(', ')})`);
    ok((await api(tokJoao, '/treinamentos/meus')).body.find(c => c.id === cursos.cloud)?.concluidas === 1, 'progresso continua de onde parou');

    // --- Cenário 15: contrato vencido; suspenso; renovado ---
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { data_inicio: '2025-01-01', data_fim: '2026-01-01' });
    ok(!(await meus(tokJoao))[cursos.cloud], 'contrato vencido: curso gratuito bloqueado');
    d = await direito(joao.id, cursos.cloud, 'beneficio');
    ok(d.status === 'expirado' && d.motivo === 'Contrato do Conector vencido', `marcado como expirado (${d.status}: ${d.motivo})`);
    ok((await meus(tokJoao))[cursos.abapAv]?.via_compra, 'curso comprado não depende do contrato');
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { data_fim: fim });
    ok((await meus(tokJoao))[cursos.cloud]?.via_beneficio, 'contrato renovado: curso gratuito de volta');
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'suspenso' });
    d = await direito(joao.id, cursos.cloud, 'beneficio');
    ok(!(await meus(tokJoao))[cursos.cloud] && d.motivo === 'Contrato do Conector suspenso', 'contrato suspenso: bloqueado com motivo');
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'ativo' });

    // --- Cadastro de benefícios: retirar um curso do perfil vale na hora ---
    const semCloud = beneficiosAntes.filter(b => !(b.curso_id === cursos.cloud)).concat(
      [{ perfil: 'abap', curso_id: cursos.cpi }, { perfil: 'abap', curso_id: cursos.extra }]);
    const put = await api(tokAdmin, '/treinamentos/beneficios', 'PUT', { itens: semCloud });
    ok(put.status === 200, `benefícios salvos (${put.body?.mensagem})`);
    m = await meus(tokJoao);
    ok(!m[cursos.cloud] && m[cursos.extra]?.via_beneficio, 'Integrações Cloud saiu do benefício e Workshop entrou');
    await acessos.sincronizarUsuario(joao.id);
    d = await direito(joao.id, cursos.cloud, 'beneficio');
    ok(d.status === 'revogado' && d.motivo === 'Curso retirado do benefício da licença', `motivo: ${d.motivo}`);
    ok((await api(tokAdmin, '/treinamentos/beneficios', 'PUT', { itens: [{ perfil: 'xyz', curso_id: cursos.cpi }] })).status === 400, '! perfil inválido recusado');

    // --- Liberação individual (outra autorização válida) ---
    const maria = (await pool.query(`INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo, portal_papel)
      VALUES ('Maria', $1, 'x', 1, 'cliente', $2, TRUE, 'aluno') RETURNING id, email`, [`maria-f3-${sufixo}@teste.com`, cli])).rows[0];
    const tokMaria = tok({ id: maria.id, tipo: 'cliente', cliente_id: cli });
    ok((await api(tokAdmin, `/treinamentos/cursos/${cursos.abapAv}/acessos`, 'POST', { email: maria.email, fim })).status === 201, 'admin libera o curso para uma pessoa');
    ok((await meus(tokMaria))[cursos.abapAv]?.compra_fim === fim, 'Maria vê o curso com a validade');
    const lista = (await api(tokAdmin, `/treinamentos/cursos/${cursos.abapAv}/acessos`)).body;
    const dm = lista.find(x => x.email === maria.email);
    ok(dm && dm.origem === 'manual' && lista.some(x => x.origem === 'compra'), 'painel lista os acessos do curso com a origem');
    ok((await api(tokAdmin, `/treinamentos/acessos/${dm.id}`, 'DELETE')).status === 200 && !(await meus(tokMaria))[cursos.abapAv], 'revogar a liberação individual tira o curso');
    const db = lista.find(x => x.origem === 'compra');
    const dben = (await pool.query(`SELECT id FROM direitos_acesso WHERE origem = 'beneficio' AND usuario_id = $1 LIMIT 1`, [joao.id])).rows[0];
    ok((await api(tokAdmin, `/treinamentos/acessos/${dben.id}`, 'DELETE')).status === 400, '! benefício não se revoga por aqui (acaba pela licença)');
    ok(db, 'compra listada');
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    await api(tokAdmin, '/treinamentos/beneficios', 'PUT', { itens: beneficiosAntes }).catch(() => {});
    const ids = Object.values(cursos);
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(r => r.id);
    const ks = (await pool.query('SELECT id FROM contratos_conector WHERE cliente_id = $1', [cli])).rows.map(r => r.id);
    const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks])).rows.map(r => r.id);
    const dirs = (await pool.query('SELECT id FROM direitos_acesso WHERE usuario_id = ANY($1)', [users])).rows.map(r => r.id);
    await pool.query(`DELETE FROM auditoria WHERE (entidade = 'direito_acesso' AND entidade_id = ANY($1)) OR (entidade = 'vaga_conector' AND entidade_id = ANY($2))`, [dirs, vagas]);
    await pool.query('DELETE FROM licencas WHERE vaga_id = ANY($1)', [vagas]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks]);
    await pool.query('DELETE FROM contratos_conector WHERE id = ANY($1)', [ks]);
    await pool.query('DELETE FROM cursos_progresso WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM cursos WHERE id = ANY($1)', [ids]);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    process.exit(falhas ? 1 : 0);
  }
})();
