// Chamado SAP no portal: o servidor (SID) é escolhido entre os sistemas do contrato vigente do Conector do cliente.
// Precisa do servidor local rodando (npm run dev:local).
require('./_ambiente-local');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');

const API = process.env.API_TESTE || 'http://localhost:3000/api';

(async () => {
  let falhas = 0;
  const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
  const tok = (id, tipo, extra = {}) => jwt.sign({ id, nome: 'TESTE', empresa_id: 1, tipo, sv: 0, ...extra }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const chamar = async (token, metodo, url, corpo) => {
    const r = await fetch(API + url, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const clientes = [];
  try {
    const novoCliente = async nome => {
      const id = (await pool.query(`INSERT INTO clientes (nome, razao_social, empresa_id, ativo) VALUES ($1, $1, 1, TRUE) RETURNING id`, [nome])).rows[0].id;
      clientes.push(id); return id;
    };
    const cli = await novoCliente('TESTE Chamado SAP');
    const semContrato = await novoCliente('TESTE Sem contrato');
    const gestor = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: cli });
    const pessoa = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: cli });
    const pessoaSem = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: semContrato });
    const admin = await usuarioTeste(pool, { tipo: 'admin_empresa' });
    const conex = (...sids) => JSON.stringify(sids.map(sid => ({ sid, descricao: `Sistema ${sid}`, url: 'https://sap.exemplo.com', mandante: '100', idioma: 'PT' })));
    // Vigente com DEV e QAS; vencido com PRD; suspenso com HML
    await pool.query(`INSERT INTO contratos_conector (cliente_id, gestor_usuario_id, status, data_inicio, data_fim, conexoes)
      VALUES ($1, $2, 'ativo', CURRENT_DATE - 30, CURRENT_DATE + 300, $3),
             ($1, $2, 'ativo', CURRENT_DATE - 400, CURRENT_DATE - 1, $4),
             ($1, $2, 'suspenso', CURRENT_DATE - 30, CURRENT_DATE + 300, $5)`,
      [cli, gestor, conex('QAS', 'DEV'), conex('PRD'), conex('HML')]);

    const tPessoa = tok(pessoa, 'cliente', { cliente_id: cli });
    const tSem = tok(pessoaSem, 'cliente', { cliente_id: semContrato });
    const tAdmin = tok(admin, 'admin_empresa');

    let r = await chamar(tPessoa, 'GET', '/chamados/sistemas-sap');
    ok(r.status === 200 && r.body.sistemas.map(s => s.sid).join() === 'DEV,QAS', 'portal lista só os servidores do contrato vigente (DEV, QAS)');
    ok(r.body.sistemas[0].descricao === 'Sistema DEV' && r.body.modulos.includes('FI') && r.body.tipos.includes('erro'), 'traz descrição, módulos e tipos');
    r = await chamar(tPessoa, 'GET', `/chamados/sistemas-sap?cliente_id=${semContrato}`);
    ok(r.body.sistemas.length === 2, 'cliente não consegue ver servidores de outra empresa (cliente_id da URL ignorado)');

    // Licenças (tela Licenças) são a fonte principal: ativa entra (inclusive SID sem dados de conexão); vencida e suspensa não
    const novaLicenca = (sids, conexoes, status, fim) => pool.query(`INSERT INTO licencas (cliente_id, sids, conexoes, status, data_fim, chave_hash, chave_prefixo)
      VALUES ($1, $2, $3, $4, CURRENT_DATE + $5::int, $6, 'TESTE')`, [cli, sids, conexoes, status, fim, `teste-${Date.now()}-${Math.random()}`]);
    await novaLicenca('DEV,PID,PRX', JSON.stringify([{ sid: 'DEV', descricao: 'S4 DEV', mandante: '200' }, { sid: 'PID', descricao: 'PI', mandante: '001' }]), 'ativa', 300);
    await novaLicenca('OLD', '[]', 'ativa', -1);
    await novaLicenca('SUS', '[]', 'suspensa', 300);
    r = await chamar(tPessoa, 'GET', '/chamados/sistemas-sap');
    ok(r.body.sistemas.map(s => s.sid).join() === 'DEV,PID,PRX,QAS', 'servidores = licenças ativas + contrato vigente (sem vencida/suspensa): ' + r.body.sistemas.map(s => s.sid).join());
    const dev = r.body.sistemas.find(s => s.sid === 'DEV');
    ok(dev.descricao === 'S4 DEV' && dev.mandante === '200', 'dados do servidor vêm da licença (S4 DEV, mandante 200)');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE PI', sid: 'PID', tipo_demanda: 'erro' });
    ok(r.status === 201 && r.body.chamado.sid === 'PID', 'chamado no servidor PI da licença');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE licença vencida', sid: 'OLD' });
    ok(r.status === 400, 'servidor de licença vencida é recusado');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE licença suspensa', sid: 'SUS' });
    ok(r.status === 400, 'servidor de licença suspensa é recusado');

    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE sem servidor', tipo_demanda: 'erro' });
    ok(r.status === 400 && /servidor/i.test(r.body.erro), 'cliente com servidor habilitado precisa escolher o servidor');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE servidor vencido', sid: 'PRD' });
    ok(r.status === 400 && /PRD/.test(r.body.erro), 'servidor de contrato vencido é recusado');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE servidor suspenso', sid: 'HML' });
    ok(r.status === 400, 'servidor de contrato suspenso é recusado');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE módulo', sid: 'DEV', modulo: 'XYZ' });
    ok(r.status === 400, 'módulo inválido é recusado');
    r = await chamar(tPessoa, 'POST', '/chamados', { titulo: 'TESTE MIGO', sid: 'qas', modulo: 'mm', tipo_demanda: 'erro', prioridade: 'alta',
      descricao: 'Transação/programa: MIGO\n\nErro M7 021' });
    ok(r.status === 201 && r.body.chamado.sid === 'QAS' && r.body.chamado.modulo === 'MM' && r.body.chamado.tipo_demanda === 'erro',
      'chamado aberto com servidor QAS, módulo MM e tipo Erro');
    const idCh = r.body.chamado.id;
    r = await chamar(tPessoa, 'GET', `/chamados/${idCh}`);
    ok(r.body.sid === 'QAS' && !r.body.origem, 'detalhe do portal traz o servidor (chamado do portal, não do Conector)');

    r = await chamar(tSem, 'POST', '/chamados', { titulo: 'TESTE geral', tipo_demanda: 'duvida' });
    ok(r.status === 201 && r.body.chamado.sid === null, 'empresa sem contrato com servidor abre chamado sem servidor');
    r = await chamar(tSem, 'POST', '/chamados', { titulo: 'TESTE geral', sid: 'DEV' });
    ok(r.status === 400, 'empresa sem contrato não usa servidor de outra');

    // Consultor com vaga do Conector (papel aluno): abre e acompanha só os próprios chamados
    const aluno = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: cli, papel: 'aluno' });
    const tAluno = tok(aluno, 'cliente', { cliente_id: cli });
    const tGestor = tok(gestor, 'cliente', { cliente_id: cli });
    await pool.query(`UPDATE usuarios SET portal_papel = 'gestor' WHERE id = $1`, [gestor]);
    r = await chamar(tAluno, 'GET', '/chamados/sistemas-sap');
    ok(r.status === 200 && r.body.sistemas.length === 4, 'aluno vê os servidores habilitados da empresa');
    r = await chamar(tAluno, 'POST', '/chamados', { titulo: 'TESTE do aluno', sid: 'DEV', tipo_demanda: 'duvida' });
    ok(r.status === 201, 'aluno abre chamado');
    const idAluno = r.body.chamado.id;
    const lic = (await pool.query(`INSERT INTO licencas (cliente_id, usuario_id, data_fim, chave_hash, chave_prefixo)
      VALUES ($1, $2, CURRENT_DATE + 30, $3, 'TESTE') RETURNING id`, [cli, aluno, `teste-hash-${aluno}`])).rows[0].id;
    const idConector = (await pool.query(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, licenca_id, sid, aprovacao_cliente)
      VALUES (1, $1, 'TESTE pelo Conector', 'aberto', TRUE, 'conector', $2, 'DEV', 'pendente') RETURNING id`, [cli, lic])).rows[0].id;
    r = await chamar(tAluno, 'GET', '/chamados');
    const idsAluno = (r.body.chamados || r.body).map(c => c.id).sort();
    ok(idsAluno.join() === [idAluno, idConector].sort().join(), 'aluno lista só o dele e o do Conector pela licença dele');
    r = await chamar(tAluno, 'GET', `/chamados/${idCh}`);
    ok(r.status === 404, 'aluno não abre chamado de outra pessoa da empresa');
    r = await chamar(tAluno, 'GET', `/atendimentos/chamado/${idCh}`);
    ok(r.status === 404, 'aluno não lê comentários de chamado de outra pessoa');
    r = await chamar(tAluno, 'POST', '/atendimentos', { chamado_id: idCh, descricao: 'intruso' });
    ok(r.status === 404, 'aluno não comenta chamado de outra pessoa');
    r = await chamar(tAluno, 'POST', '/atendimentos', { chamado_id: idAluno, descricao: 'mais detalhes' });
    ok(r.status === 201 || r.status === 200, 'aluno comenta o próprio chamado');
    r = await chamar(tAluno, 'GET', `/chamados/${idCh}/anexos/1/download`);
    ok(r.status === 404, 'aluno não baixa anexo de chamado de outra pessoa');
    r = await chamar(tAluno, 'POST', `/chamados/${idConector}/aprovacao`, { decisao: 'aprovado' });
    ok(r.status === 403, 'aluno não aprova chamado do Conector (é do gestor)');
    r = await chamar(tGestor, 'GET', '/chamados');
    const idsGestor = (r.body.chamados || r.body).map(c => c.id);
    ok([idCh, idAluno, idConector].every(id => idsGestor.includes(id)), 'gestor vê todos os chamados da empresa, inclusive os do aluno');
    // Ficha do usuário (tela Usuários): dados, cursos liberados e os chamados da pessoa
    r = await chamar(tAdmin, 'GET', `/usuarios/${aluno}/ficha`);
    const fichaIds = (r.body.chamados?.lista || []).map(c => c.id).sort();
    ok(r.status === 200 && r.body.usuario.portal_papel === 'aluno' && Array.isArray(r.body.cursos) && Array.isArray(r.body.vagas),
      'ficha do usuário traz dados, licenças/vagas e cursos');
    ok(fichaIds.join() === [idAluno, idConector].sort().join() && r.body.chamados.total === 2, 'ficha lista os chamados da pessoa (portal + Conector)');
    r = await chamar(tAluno, 'GET', `/usuarios/${aluno}/ficha`);
    ok(r.status === 403, 'cliente não abre ficha de usuário');
    await pool.query('DELETE FROM chamados WHERE id = $1', [idConector]);
    await pool.query('DELETE FROM licencas WHERE id = $1', [lic]);

    // Equipe: escolhe pelo cliente; servidor opcional; edição mantém SID antigo mesmo com contrato vencido
    r = await chamar(tAdmin, 'GET', `/chamados/sistemas-sap?cliente_id=${cli}`);
    ok(r.body.sistemas.length === 4, 'equipe vê os servidores do cliente escolhido');
    r = await chamar(tAdmin, 'POST', '/chamados', { titulo: 'TESTE equipe', cliente_id: cli });
    ok(r.status === 201, 'equipe abre chamado sem servidor');
    r = await chamar(tAdmin, 'PUT', `/chamados/${idCh}`, { sid: 'DEV', modulo: 'FI' });
    ok(r.status === 200 && r.body.chamado.sid === 'DEV' && r.body.chamado.modulo === 'FI' && r.body.chamado.tipo_demanda === 'erro', 'equipe troca o servidor e o módulo (tipo mantido)');
    await pool.query(`UPDATE chamados SET sid = 'PRD' WHERE id = $1`, [idCh]);
    r = await chamar(tAdmin, 'PUT', `/chamados/${idCh}`, { sid: 'PRD', status: 'em_andamento' });
    ok(r.status === 200 && r.body.chamado.sid === 'PRD', 'editar chamado antigo mantém o SID de contrato vencido');
    r = await chamar(tAdmin, 'PUT', `/chamados/${idCh}`, { sid: 'HML' });
    ok(r.status === 400, 'equipe não troca para servidor fora do contrato vigente');
  } catch (err) {
    falhas++;
    console.error('FAIL erro:', err);
  } finally {
    if (clientes.length) {
      const chs = (await pool.query('SELECT id FROM chamados WHERE cliente_id = ANY($1)', [clientes])).rows.map(c => c.id);
      for (const t of ['chamados_status_log', 'atendimentos']) await pool.query(`DELETE FROM ${t} WHERE chamado_id = ANY($1)`, [chs]).catch(() => {});
      await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [chs]);
      await pool.query('DELETE FROM licencas WHERE cliente_id = ANY($1)', [clientes]);
      await pool.query('DELETE FROM contratos_conector WHERE cliente_id = ANY($1)', [clientes]);
    }
    await apagarUsuariosTeste(pool);
    if (clientes.length) await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [clientes]).catch(e => console.error('limpeza clientes:', e.message));
    await pool.end();
    console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
    process.exit(falhas ? 1 : 0);
  }
})();
