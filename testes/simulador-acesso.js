// Simulador de acesso: o administrador entra como um usuário só para ver (POST /api/usuarios/:id/simular).
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
  const chamar = (token, metodo, url, corpo) => fetch(API + url, {
    method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  try {
    const cliente = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1')).rows[0];
    const adminId = await usuarioTeste(pool, { tipo: 'admin_empresa' });
    const adminSisId = await usuarioTeste(pool, { tipo: 'admin_sistema' });
    const clienteId = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: cliente ? cliente.id : null });
    const tecnicoId = await usuarioTeste(pool, { tipo: 'tecnico' });
    const tAdmin = tok(adminId, 'admin_empresa');

    // Inicia a simulação
    let r = await chamar(tAdmin, 'POST', `/usuarios/${clienteId}/simular`);
    const d = await r.json();
    ok(r.ok && d.token && d.usuario.tipo === 'cliente' && d.usuario.simulado_por === adminId, 'admin simula o cliente e recebe token do cliente');
    const p = jwt.decode(d.token);
    ok(p.id === clienteId && p.simulado_por === adminId && p.exp - p.iat === 3600, 'token simulado: do cliente, marcado e vale 1 h');

    // Só leitura
    r = await chamar(d.token, 'GET', '/usuarios/me');
    ok(r.ok && (await r.json()).id === clienteId, 'GET com token simulado responde como o cliente');
    r = await chamar(d.token, 'PUT', '/usuarios/me/tema', { tema: 'dark' });
    ok(r.status === 403, 'PUT com token simulado é recusado (somente visualização)');
    r = await chamar(d.token, 'POST', '/chamados', { titulo: 'TESTE simulação' });
    ok(r.status === 403, 'abrir chamado durante a simulação é recusado');

    // Técnico (vai para o sistema) também pode ser simulado; não pode simular a si mesmo
    r = await chamar(tAdmin, 'POST', `/usuarios/${tecnicoId}/simular`);
    ok(r.ok, 'admin simula um técnico');
    r = await chamar(tAdmin, 'POST', `/usuarios/${adminId}/simular`);
    ok(r.status === 400, 'não simula a si mesmo');

    // Hierarquia: admin comum não simula Admin Sistema; Admin Sistema sim; ninguém simula o super usuário
    r = await chamar(tAdmin, 'POST', `/usuarios/${adminSisId}/simular`);
    ok(r.status === 403, 'administrador comum não simula Admin Sistema');
    r = await chamar(tok(adminSisId, 'admin_sistema'), 'POST', `/usuarios/${adminId}/simular`);
    ok(r.ok, 'Admin Sistema simula um administrador');
    await pool.query('UPDATE usuarios SET super_usuario = TRUE WHERE id = $1', [tecnicoId]);
    r = await chamar(tok(adminSisId, 'admin_sistema'), 'POST', `/usuarios/${tecnicoId}/simular`);
    ok(r.status === 403, 'super usuário não pode ser simulado');
    await pool.query('UPDATE usuarios SET super_usuario = FALSE WHERE id = $1', [tecnicoId]);

    // Quem não é administrador não simula
    r = await chamar(tok(tecnicoId, 'tecnico'), 'POST', `/usuarios/${clienteId}/simular`);
    ok(r.status === 403, 'técnico não usa o simulador');
    r = await chamar(d.token, 'POST', `/usuarios/${tecnicoId}/simular`);
    ok(r.status === 403, 'token simulado não abre outra simulação');

    // Auditoria
    const a = (await pool.query(`SELECT 1 FROM auditoria WHERE acao = 'simular_acesso' AND usuario_id = $1 AND entidade_id = $2`, [adminId, clienteId])).rows;
    ok(a.length === 1, 'simulação registrada na auditoria');

    // Administrador desativado: a simulação cai na hora
    await pool.query('UPDATE usuarios SET ativo = FALSE WHERE id = $1', [adminId]);
    r = await chamar(d.token, 'GET', '/usuarios/me');
    ok(r.status === 401, 'administrador desativado encerra a simulação');

    await pool.query(`DELETE FROM auditoria WHERE acao = 'simular_acesso' AND usuario_id IN ($1, $2)`, [adminId, adminSisId]);
  } catch (err) {
    falhas++;
    console.error('FAIL erro:', err);
  } finally {
    await apagarUsuariosTeste(pool);
    await pool.end();
    console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
    process.exit(falhas ? 1 : 0);
  }
})();
