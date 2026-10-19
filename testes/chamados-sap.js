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

    // Equipe: escolhe pelo cliente; servidor opcional; edição mantém SID antigo mesmo com contrato vencido
    r = await chamar(tAdmin, 'GET', `/chamados/sistemas-sap?cliente_id=${cli}`);
    ok(r.body.sistemas.length === 2, 'equipe vê os servidores do cliente escolhido');
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
      await pool.query('DELETE FROM contratos_conector WHERE cliente_id = ANY($1)', [clientes]);
    }
    await apagarUsuariosTeste(pool);
    if (clientes.length) await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [clientes]).catch(e => console.error('limpeza clientes:', e.message));
    await pool.end();
    console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
    process.exit(falhas ? 1 : 0);
  }
})();
