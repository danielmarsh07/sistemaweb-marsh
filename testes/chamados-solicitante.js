require('./_ambiente-local');
// Filtro "Quem abriu" na lista de chamados (equipe Marsh): GET /chamados/solicitantes junta o usuário do
// portal (aberto_por_usuario_id) e o solicitante do Conector (aberto_por NULL) pelo e-mail, com abertos e
// fechados; GET /chamados?solicitante=<e-mail> filtra. Cliente não vê a lista nem usa o filtro.
// Servidor local: npm run dev:local (PORT opcional: BASE_TESTE=http://localhost:3107/api)
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = process.env.BASE_TESTE || 'http://localhost:3000/api';

let falhas = 0;
let licencaTeste = null;
let licencaTeste2 = null;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };

(async () => {
  const cli = (await pool.query(`INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo)
    VALUES ('TESTE Solicitante', 'TESTE SOLICITANTE LTDA', 'solic@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const api = async (tok, p) => {
    const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${tok}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const usu = await usuarioTeste(pool, { cliente_id: cli });
    const emailUsu = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [usu])).rows[0].email;
    const tokCli = jwt.sign({ id: usu, tipo: 'cliente', empresa_id: 1, cliente_id: cli }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const emailConector = `conector-${Date.now()}@teste.local`;

    const novo = (sql, params) => pool.query(sql, params).then(r => r.rows[0].id);
    // Pessoa 1: usuário do portal - 1 aberto + 1 fechado; e 1 pelo Conector com o MESMO e-mail (maiúsculo)
    const a1 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, aberto_por_usuario_id, titulo, status, ativo)
      VALUES (1, $1, $2, 'TESTE portal aberto', 'aberto', TRUE) RETURNING id`, [cli, usu]);
    const a2 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, aberto_por_usuario_id, titulo, status, ativo)
      VALUES (1, $1, $2, 'TESTE portal fechado', 'fechado', TRUE) RETURNING id`, [cli, usu]);
    const a3 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, solicitante_nome, solicitante_email)
      VALUES (1, $1, 'TESTE conector mesmo e-mail', 'em_andamento', TRUE, 'conector', 'Nome no Conector', $2) RETURNING id`,
      [cli, emailUsu.toUpperCase()]);
    // Pessoa 2: só pelo Conector (sem usuário) - 1 resolvido
    const b1 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, solicitante_nome, solicitante_email)
      VALUES (1, $1, 'TESTE conector outra pessoa', 'resolvido', TRUE, 'conector', 'Pessoa Conector', $2) RETURNING id`,
      [cli, emailConector]);

    const ls = await api(tokAdmin, '/chamados/solicitantes');
    ok(ls.status === 200 && Array.isArray(ls.body), `lista de pessoas para a equipe (${ls.status})`);
    const p1 = (ls.body || []).find(p => p.email === emailUsu.toLowerCase());
    ok(p1 && p1.abertos === 2 && p1.fechados === 1 && p1.total === 3,
      `portal + Conector com o mesmo e-mail viram uma pessoa (2 abertos, 1 fechado): ${JSON.stringify(p1)}`);
    ok(p1 && p1.nome === 'Nome no Conector', 'nome da pessoa = o do chamado mais recente');
    const p2 = (ls.body || []).find(p => p.email === emailConector);
    ok(p2 && p2.abertos === 0 && p2.fechados === 1 && p2.nome === 'Pessoa Conector',
      'pessoa só do Conector, com chamado já resolvido, aparece na lista');

    const f1 = await api(tokAdmin, `/chamados?limit=200&solicitante=${encodeURIComponent(emailUsu.toUpperCase())}`);
    const ids1 = (f1.body?.chamados || []).map(c => c.id).sort((x, y) => x - y);
    ok(f1.status === 200 && JSON.stringify(ids1) === JSON.stringify([a1, a2, a3].sort((x, y) => x - y)),
      `filtro pela pessoa 1 traz os 3 chamados dela (${ids1})`);
    const f2 = await api(tokAdmin, `/chamados?limit=200&solicitante=${encodeURIComponent(emailConector)}&status=resolvido`);
    ok((f2.body?.chamados || []).map(c => c.id).join() === String(b1), 'filtro pela pessoa 2 + status');
    ok((f2.body?.paginacao?.total) === 1, 'paginação conta só os filtrados');

    ok((await api(tokCli, '/chamados/solicitantes')).status === 403, '! cliente não vê a lista de pessoas -> 403');
    const fc = await api(tokCli, `/chamados?limit=200&solicitante=${encodeURIComponent(emailConector)}`);
    ok(fc.status === 200 && (fc.body?.chamados || []).length === 4, 'cliente: parâmetro solicitante é ignorado (vê os 4 do cliente)');

    // Caso real (Renan/Gabriel): Conector sem e-mail do solicitante -> pessoa = usuário da vaga da licença
    const vaga = await usuarioTeste(pool, { cliente_id: cli });
    await pool.query(`UPDATE usuarios SET nome = 'TESTE Vaga Completo' WHERE id = $1`, [vaga]);
    const emailVaga = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [vaga])).rows[0].email;
    const lic = (await pool.query(`INSERT INTO licencas (cliente_id, usuario_id, data_fim, chave_hash, chave_prefixo)
      VALUES ($1, $2, CURRENT_DATE + 30, $3, 'TESTE') RETURNING id`, [cli, vaga, `teste-hash-sol-${vaga}`])).rows[0].id;
    licencaTeste = lic;
    const c1 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, licenca_id, solicitante_nome)
      VALUES (1, $1, 'TESTE conector pela vaga', 'aberto', TRUE, 'conector', $2, 'Apelido') RETURNING id`, [cli, lic]);
    const c2 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, licenca_id, solicitante_nome)
      VALUES (1, $1, 'TESTE conector pela vaga 2', 'fechado', TRUE, 'conector', $2, 'Apelido') RETURNING id`, [cli, lic]);
    // Caso real (Marcos): licença sem usuário e sem e-mail -> pessoa pelo nome do solicitante
    const lic2 = (await pool.query(`INSERT INTO licencas (cliente_id, data_fim, chave_hash, chave_prefixo)
      VALUES ($1, CURRENT_DATE + 30, $2, 'TESTE') RETURNING id`, [cli, `teste-hash-sol2-${vaga}`])).rows[0].id;
    licencaTeste2 = lic2;
    const d1 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, licenca_id, solicitante_nome)
      VALUES (1, $1, 'TESTE conector só nome', 'aberto', TRUE, 'conector', $2, '  TESTE Só Nome ') RETURNING id`, [cli, lic2]);

    const ls2 = (await api(tokAdmin, '/chamados/solicitantes')).body || [];
    const pv = ls2.find(p => p.email === emailVaga.toLowerCase());
    ok(pv && pv.nome === 'TESTE Vaga Completo' && pv.abertos === 1 && pv.fechados === 1,
      `Conector sem e-mail entra pela vaga da licença, com o nome da vaga: ${JSON.stringify(pv)}`);
    const pn = ls2.find(p => p.email === 'nome:teste só nome');
    ok(pn && pn.nome === 'TESTE Só Nome' && pn.abertos === 1, `sem e-mail nenhum, entra pelo nome: ${JSON.stringify(pn)}`);
    const fv = await api(tokAdmin, `/chamados?limit=200&solicitante=${encodeURIComponent(emailVaga)}`);
    ok((fv.body?.chamados || []).map(c => c.id).sort((x, y) => x - y).join() === [c1, c2].sort((x, y) => x - y).join(),
      'filtro pela pessoa da vaga traz os 2 chamados');
    const fn = await api(tokAdmin, `/chamados?limit=200&solicitante=${encodeURIComponent('nome:teste só nome')}`);
    ok((fn.body?.chamados || []).map(c => c.id).join() === String(d1), 'filtro pela pessoa só com nome');

    // Caso real (Marcos): licença sem vaga, mas há UM usuário do cliente com o mesmo nome -> junta nele;
    // com dois homônimos no cliente, não junta (fica pelo nome)
    const marcos = await usuarioTeste(pool, { cliente_id: cli });
    await pool.query(`UPDATE usuarios SET nome = 'TESTE Marcos Unico' WHERE id = $1`, [marcos]);
    const emailMarcos = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [marcos])).rows[0].email;
    const m1 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, aberto_por_usuario_id, titulo, status, ativo)
      VALUES (1, $1, $2, 'TESTE portal Marcos', 'fechado', TRUE) RETURNING id`, [cli, marcos]);
    const m2 = await novo(`INSERT INTO chamados (empresa_id, cliente_id, titulo, status, ativo, origem, licenca_id, solicitante_nome)
      VALUES (1, $1, 'TESTE conector Marcos', 'aberto', TRUE, 'conector', $2, 'teste marcos unico ') RETURNING id`, [cli, lic2]);
    const pm = ((await api(tokAdmin, '/chamados/solicitantes')).body || []).filter(p => /marcos unico/i.test(p.nome || p.email));
    ok(pm.length === 1 && pm[0].nome === 'TESTE Marcos Unico' && pm[0].email === emailMarcos.toLowerCase() && pm[0].abertos === 1 && pm[0].fechados === 1,
      `só nome + usuário único do cliente com o mesmo nome = uma pessoa: ${JSON.stringify(pm)}`);
    const homo = await usuarioTeste(pool, { cliente_id: cli });
    await pool.query(`UPDATE usuarios SET nome = 'TESTE Só Nome' WHERE id = $1`, [homo]);
    const homo2 = await usuarioTeste(pool, { cliente_id: cli });
    await pool.query(`UPDATE usuarios SET nome = 'TESTE Só Nome' WHERE id = $1`, [homo2]);
    ok(((await api(tokAdmin, '/chamados/solicitantes')).body || []).some(p => p.email === 'nome:teste só nome'),
      'com dois homônimos no cliente não junta: continua pelo nome');
    void m1; void m2;

    // Grid: quem abriu vem em cada chamado (quem_abriu_nome)
    const g = (await api(tokAdmin, '/chamados?limit=200')).body?.chamados || [];
    const nomeDe = id => (g.find(c => c.id === id) || {}).quem_abriu_nome;
    ok(nomeDe(a1) === 'TESTE usuário' && nomeDe(a3) === 'Nome no Conector' && nomeDe(c1) === 'TESTE Vaga Completo'
      && nomeDe(d1) === 'TESTE Só Nome', `quem_abriu_nome no grid: ${[a1, a3, c1, d1].map(nomeDe)}`);
  } catch (e) {
    falhas++;
    console.error('ERRO', e);
  } finally {
    await pool.query(`DELETE FROM chamados_status_log WHERE chamado_id IN (SELECT id FROM chamados WHERE cliente_id = $1)`, [cli]);
    await pool.query(`DELETE FROM chamados WHERE cliente_id = $1`, [cli]);
    if (licencaTeste) await pool.query('DELETE FROM licencas WHERE id = $1', [licencaTeste]);
    if (licencaTeste2) await pool.query('DELETE FROM licencas WHERE id = $1', [licencaTeste2]);
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.end();
    console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo OK');
    process.exit(falhas ? 1 : 0);
  }
})();
