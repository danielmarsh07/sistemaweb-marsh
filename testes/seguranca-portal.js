require('./_ambiente-local');
// Segurança do portal: um usuário do tipo 'cliente' só enxerga o que é dele; a equipe segue enxergando tudo.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';

(async () => {
  const cli = (await pool.query(`SELECT id FROM clientes WHERE ativo ORDER BY id LIMIT 1`)).rows[0].id;
  const idCliente = await usuarioTeste(pool, { cliente_id: cli });
  const tokCliente = jwt.sign({ id: idCliente, tipo: 'cliente', empresa_id: 1, cliente_id: cli }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const tokTecnico = jwt.sign({ id: 1, tipo: 'tecnico', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const get = async (tok, p, m = 'GET', body) => {
    const r = await fetch(BASE + p, { method: m, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);

  // Rotas internas: cliente do portal bloqueado
  for (const p of ['/clientes', `/clientes/${cli}`, `/clientes/${cli}/ficha`, '/fornecedores', '/empresas/resumo', '/empresas/minha',
                   '/transacoes', '/categorias-transacao', '/usuarios', '/financeiro/faturas', '/comercial/oportunidades']) {
    const r = await get(tokCliente, p);
    ok(r.status === 403, `portal bloqueado em GET ${p} (${r.status})`);
  }
  // Tecnologias: só as vinculadas ao cliente, e sem escrita
  const tec = (await pool.query(`INSERT INTO tecnologias (empresa_id, nome, categoria, ativo) VALUES (1, 'TESTE Tec Vinculada', 'SAP', TRUE) RETURNING id`)).rows[0].id;
  const tec2 = (await pool.query(`INSERT INTO tecnologias (empresa_id, nome, categoria, ativo) VALUES (1, 'TESTE Tec Outra', 'SAP', TRUE) RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO cliente_tecnologias (cliente_id, tecnologia_id, status) VALUES ($1, $2, 'ativo')`, [cli, tec]);
  const tc = await get(tokCliente, '/tecnologias');
  const nomes = (tc.body || []).map(t => t.nome);
  ok(tc.status === 200 && nomes.includes('TESTE Tec Vinculada') && !nomes.includes('TESTE Tec Outra'), `portal vê só tecnologias vinculadas (${nomes.join(', ')})`);
  ok((await get(tokCliente, '/tecnologias', 'POST', { nome: 'x' })).status === 403, 'portal não cria tecnologia');
  ok((await get(tokCliente, `/tecnologias/${tec2}`)).status === 403, 'portal não lê tecnologia avulsa');

  // O que o portal usa continua funcionando
  for (const p of ['/chamados', '/financeiro/minhas-faturas', '/licencas/minhas', '/treinamentos/meus']) {
    const r = await get(tokCliente, p);
    ok(r.status === 200, `portal continua acessando GET ${p}`);
  }

  // Equipe segue com acesso
  const adm = await get(tokAdmin, '/clientes');
  ok(adm.status === 200 && adm.body.length >= 1, 'admin lista clientes');
  const tecAll = await get(tokTecnico, '/tecnologias');
  ok(tecAll.status === 200 && tecAll.body.some(t => t.nome === 'TESTE Tec Outra'), 'técnico vê todas as tecnologias');
  ok((await get(tokTecnico, '/clientes')).status === 200, 'técnico lista clientes');

  await pool.query(`DELETE FROM cliente_tecnologias WHERE tecnologia_id IN ($1, $2)`, [tec, tec2]);
  await pool.query(`DELETE FROM tecnologias WHERE id IN ($1, $2)`, [tec, tec2]);
  await apagarUsuariosTeste(pool);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
