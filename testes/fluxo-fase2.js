require('./_ambiente-local');
// Fluxo novo — fase 2 (docs/plano-fluxo-novo.md): administradores corporativos, convites com estado e histórico.
// Cenários 4, 5, 6 e 16 do documento: distribuição de 100 licenças, bloqueio da 101ª (convites simultâneos),
// convite e cadastro do usuário, isolamento entre empresas. Mais: cancelar/expirar convite, revogar sem
// apagar a conta, vários administradores (nunca zero) e administrador não consome licença.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const senhas = require('../backend/services/senhas');
const cc = require('../backend/services/contratos-conector');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
const api = async (t, p, m = 'GET', body) => {
  const h = { 'Content-Type': 'application/json' };
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const usuarioPorEmail = async e => (await pool.query('SELECT * FROM usuarios WHERE LOWER(email) = LOWER($1)', [e])).rows[0];
const estadoVaga = async id => (await pool.query('SELECT estado, usuario_id FROM contratos_conector_vagas WHERE id = $1', [id])).rows[0];

(async () => {
  const sufixo = Date.now();
  const clientes = [];
  for (const n of ['A', 'B']) {
    clientes.push((await pool.query(`INSERT INTO clientes (nome, empresa_id, ativo) VALUES ($1, 1, TRUE) RETURNING id`, [`TESTE F2 ${n} ${sufixo}`])).rows[0].id);
  }
  const [cliA, cliB] = clientes;
  const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  try {
    // --- Contrato com 100 licenças ABAP + 2 Funcional; quem compra vira administrador ---
    const k = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cliA, gestor_nome: 'Admin A', gestor_email: `adm-a-f2-${sufixo}@teste.com`,
      vagas: { abap: 100, funcional: 2 }, data_fim: fim });
    ok(k.status === 201, `contrato com 102 licenças (${k.status} ${k.body?.erro || ''})`);
    const kid = k.body.id;
    const admA = await usuarioPorEmail(`adm-a-f2-${sufixo}@teste.com`);
    const tokAdmA = tok({ id: admA.id, tipo: 'cliente', cliente_id: cliA });
    ok(await cc.ehAdminCorporativo(admA.id, cliA), 'quem compra é administrador da empresa');
    let meus = (await api(tokAdmA, '/contratos-conector/meus')).body;
    ok(meus.length === 1 && meus[0].vagas.every(v => !v.usuario_id), 'administrador vê o contrato e não ocupa licença por ser administrador');

    // --- Cenário 16: outra empresa não vê nem mexe ---
    const kB = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cliB, gestor_nome: 'Admin B', gestor_email: `adm-b-f2-${sufixo}@teste.com`, vagas: { abap: 1 }, data_fim: fim });
    const admB = await usuarioPorEmail(`adm-b-f2-${sufixo}@teste.com`);
    const tokAdmB = tok({ id: admB.id, tipo: 'cliente', cliente_id: cliB });
    ok((await api(tokAdmB, '/contratos-conector/meus')).body.every(x => x.id !== kid), 'empresa B não vê o contrato da A');
    ok((await api(tokAdmB, `/contratos-conector/meus/${kid}/convidar`, 'POST', { perfil: 'abap', nome: 'X', email: `x-f2-${sufixo}@teste.com` })).status === 404, 'empresa B não convida no contrato da A');
    ok((await api(tokAdmB, `/contratos-conector/meus/${kid}/historico`)).status === 404, 'empresa B não lê o histórico da A');
    const comum = await pool.query(`INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo) VALUES ('Comum A', $1, 'x', 1, 'cliente', $2, TRUE) RETURNING id`, [`comum-f2-${sufixo}@teste.com`, cliA]);
    const tokComum = tok({ id: comum.rows[0].id, tipo: 'cliente', cliente_id: cliA });
    ok((await api(tokComum, '/contratos-conector/meus')).body.length === 0, 'usuário da empresa que não é administrador não vê as licenças');
    ok((await api(tokComum, '/contratos-conector/meus-admins')).status === 403, 'nem a lista de administradores');

    // --- Cenários 4 e 5: 101 convites ABAP ao mesmo tempo para 100 licenças ---
    const convites = Array.from({ length: 101 }, (_, i) => api(tokAdmA, `/contratos-conector/meus/${kid}/convidar`, 'POST',
      { perfil: 'abap', nome: `Pessoa ${i}`, email: `p${i}-f2-${sufixo}@teste.com` }));
    const res = await Promise.all(convites);
    const aceitos = res.filter(r => r.status === 200).length;
    const recusados = res.filter(r => r.status === 400 && /Não há licença ABAP disponível/.test(r.body?.erro || ''));
    const ocupadas = (await pool.query(`SELECT COUNT(*)::int AS n FROM contratos_conector_vagas WHERE contrato_id = $1 AND perfil = 'abap' AND usuario_id IS NOT NULL`, [kid])).rows[0].n;
    ok(aceitos === 100 && recusados.length === 1 && ocupadas === 100, `100 convites aceitos, o 101º recusado (${aceitos}/${recusados.length}, ocupadas ${ocupadas})`);
    ok((await pool.query(`SELECT COUNT(*)::int AS n FROM contratos_conector_vagas WHERE contrato_id = $1 AND estado = 'convidada'`, [kid])).rows[0].n === 100,
      'as 100 ficam como convite pendente (reservadas)');

    // --- Cenário 6: convite → cadastro → licença ativa ---
    const p0 = await usuarioPorEmail(`p0-f2-${sufixo}@teste.com`);
    const vagaP0 = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE usuario_id = $1', [p0.id])).rows[0].id;
    const { link } = await senhas.enviarLink(p0, 'convite');
    const t = new URL(link).searchParams.get('t');
    const def = await api(null, '/auth/definir-senha', 'POST', { token: t, senha: 'Senha1234' });
    ok(def.status === 200 && (await estadoVaga(vagaP0)).estado === 'ativa', 'pessoa cria a senha pelo convite e a licença fica ativa');
    ok((await api(null, '/auth/definir-senha', 'POST', { token: t, senha: 'Outra1234' })).status === 400, '! o mesmo link de convite não vale duas vezes');
    const login = await api(null, '/auth/login', 'POST', { email: p0.email, senha: 'Senha1234' });
    ok(login.status === 200, 'pessoa entra no portal');
    const eu = (await api(login.body.token, '/contratos-conector/eu')).body;
    ok(eu.vagas.length === 1 && eu.vagas[0].perfil === 'abap' && eu.papel === 'aluno', 'portal mostra a licença ABAP da pessoa');

    // --- Cancelar convite: link deixa de valer, licença volta a ficar disponível ---
    const p1 = await usuarioPorEmail(`p1-f2-${sufixo}@teste.com`);
    const vagaP1 = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE usuario_id = $1', [p1.id])).rows[0].id;
    const { link: link1 } = await senhas.enviarLink(p1, 'convite');
    const canc = await api(tokAdmA, `/contratos-conector/meus/${kid}/vagas/${vagaP1}/liberar`, 'POST');
    ok(canc.status === 200 && (await estadoVaga(vagaP1)).estado === 'livre', 'convite cancelado: licença disponível de novo');
    ok(!(await senhas.lerToken(new URL(link1).searchParams.get('t'))), 'link do convite cancelado deixa de valer');

    // 101ª pessoa agora entra na licença liberada
    const r101 = await api(tokAdmA, `/contratos-conector/meus/${kid}/convidar`, 'POST', { perfil: 'abap', nome: 'Pessoa 101', email: `p101-f2-${sufixo}@teste.com` });
    ok(r101.status === 200, 'com uma licença liberada, o próximo convite entra');

    // --- Expiração: convite sem aceite e sem link válido libera a licença ---
    const p2 = await usuarioPorEmail(`p2-f2-${sufixo}@teste.com`);
    const vagaP2 = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE usuario_id = $1', [p2.id])).rows[0].id;
    await pool.query(`UPDATE contratos_conector_vagas SET convidado_em = NOW() - INTERVAL '4 days' WHERE id = $1`, [vagaP2]);
    await pool.query(`UPDATE usuarios_tokens SET expira_em = NOW() - INTERVAL '1 hour' WHERE usuario_id = $1`, [p2.id]);
    const p3 = await usuarioPorEmail(`p3-f2-${sufixo}@teste.com`);
    const vagaP3 = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE usuario_id = $1', [p3.id])).rows[0].id;
    await pool.query(`UPDATE contratos_conector_vagas SET convidado_em = NOW() - INTERVAL '4 days' WHERE id = $1`, [vagaP3]);
    await senhas.enviarLink(p3, 'convite'); // reenviado: link novo válido, não expira
    await cc.expirarConvites();
    ok((await estadoVaga(vagaP2)).estado === 'livre', 'convite vencido sem aceite: licença liberada pela rotina');
    ok((await estadoVaga(vagaP3)).estado === 'convidada', 'convite reenviado (link válido) continua reservado');

    // --- Revogar licença ativa: perde o acesso, mantém a conta ---
    const rev = await api(tokAdmA, `/contratos-conector/meus/${kid}/vagas/${vagaP0}/liberar`, 'POST');
    ok(rev.status === 200 && (await usuarioPorEmail(p0.email)).ativo === true, 'licença revogada; a conta da pessoa continua ativa');
    ok((await api(login.body.token, '/contratos-conector/eu')).body.vagas.length === 0, 'sem a licença no portal (efeito imediato)');
    ok((await api(null, '/auth/login', 'POST', { email: p0.email, senha: 'Senha1234' })).status === 200, 'a pessoa ainda consegue entrar');

    // --- Histórico ---
    const hist = (await api(tokAdmA, `/contratos-conector/meus/${kid}/historico`)).body;
    const acoes = new Set(hist.map(h => h.acao));
    ok(['vaga.ocupada', 'vaga.convite_aceito', 'vaga.convite_cancelado', 'vaga.convite_expirado', 'vaga.liberada'].every(a => acoes.has(a)),
      `histórico registra convite, aceite, cancelamento, expiração e revogação (${[...acoes].join(', ')})`);
    ok(hist.some(h => h.acao === 'vaga.convite_expirado' && !h.feito_por), 'expiração aparece como automática');

    // --- Vários administradores, nunca zero ---
    const add = await api(tokAdmA, '/contratos-conector/meus-admins', 'POST', { nome: 'Admin A2', email: `adm-a2-f2-${sufixo}@teste.com` });
    ok(add.status === 201, 'administrador convida outro administrador');
    const admA2 = await usuarioPorEmail(`adm-a2-f2-${sufixo}@teste.com`);
    ok((await api(tokAdmA, '/contratos-conector/meus-admins')).body.length === 2, 'empresa com 2 administradores');
    ok((await api(tokAdmA, '/contratos-conector/meus-admins', 'POST', { email: admA2.email })).status === 400, '! não duplica administrador');
    ok((await api(tokAdmA, '/contratos-conector/meus-admins', 'POST', { nome: 'B', email: admB.email })).status === 400, '! não vira administrador quem é de outra empresa');
    const rem = await api(tokAdmA, `/contratos-conector/meus-admins/${admA2.id}`, 'DELETE');
    ok(rem.status === 200 && (await usuarioPorEmail(admA2.email)).portal_papel === 'aluno', 'removido: perde o acesso de administrador');
    ok((await api(tokAdmA, `/contratos-conector/meus-admins/${admA.id}`, 'DELETE')).status === 400, '! não remove o último administrador');
    const viaMarsh = await api(tokAdmin, `/contratos-conector/clientes/${cliA}/admins`);
    ok(viaMarsh.status === 200 && viaMarsh.body.length === 1, 'painel da Marsh lista os administradores do cliente');
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = ANY($1)', [clientes])).rows.map(u => u.id);
    const ks = (await pool.query('SELECT id FROM contratos_conector WHERE cliente_id = ANY($1)', [clientes])).rows.map(r => r.id);
    const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks])).rows.map(r => r.id);
    await pool.query(`DELETE FROM auditoria WHERE (entidade = 'vaga_conector' AND entidade_id = ANY($1)) OR (entidade = 'cliente' AND entidade_id = ANY($2))`, [vagas, clientes]);
    await pool.query('DELETE FROM licencas WHERE vaga_id = ANY($1)', [vagas]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [ks]);
    await pool.query('DELETE FROM contratos_conector WHERE id = ANY($1)', [ks]);
    await pool.query('DELETE FROM clientes_admins WHERE cliente_id = ANY($1)', [clientes]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [clientes]);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    process.exit(falhas ? 1 : 0);
  }
})();
