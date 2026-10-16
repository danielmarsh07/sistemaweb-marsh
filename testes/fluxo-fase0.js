require('./_ambiente-local');
// Fluxo novo — fase 0 (docs/plano-fluxo-novo.md): isolamento, revogação imediata de sessão, webhook sem
// repetição, NFS-e sem regressão de status, vagas sem duplicidade em concorrência, tipo de pessoa,
// CPF/CNPJ único, oportunidade → contrato sem corrida e auditoria.
// Cenários 16, 17 e 18 do documento. Servidor local com ASAAS_WEBHOOK_TOKEN=token-teste-local-123.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';
const WEBHOOK_TOKEN = 'token-teste-local-123';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const api = async (t, p, m = 'GET', body, headers = {}) => {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// CPF/CNPJ válidos e aleatórios (não colidem com clientes que já existam no banco local)
const dv = (nums, pesos) => { const r = nums.reduce((s, n, i) => s + n * pesos[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const aleatorios = n => Array.from({ length: n }, () => Math.floor(Math.random() * 10));
function cpfAleatorio() {
  const b = aleatorios(9); b.push(dv(b, [10, 9, 8, 7, 6, 5, 4, 3, 2])); b.push(dv(b, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]));
  return b.join('');
}
function cnpjAleatorio() {
  const b = [...aleatorios(8), 0, 0, 0, 1]; b.push(dv(b, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])); b.push(dv(b, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]));
  return b.join('');
}
const webhook = body => api(null, '/asaas/webhook', 'POST', body, { 'asaas-access-token': WEBHOOK_TOKEN });

(async () => {
  const sufixo = Date.now();
  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
  const limpar = { clientes: [], faturas: [], contratosConector: [], oportunidades: [], contratos: [], eventos: [], chamados: [] };

  try {
    // --- Cliente: tipo de pessoa calculado e documento único (formatado ou não) ---
    const cpf = cpfAleatorio(), cnpj = cnpjAleatorio();
    const cpfFmt = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    const cnpjFmt = cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    const pf = (await pool.query(`INSERT INTO clientes (nome, cpf_cnpj, empresa_id, ativo) VALUES ('TESTE F0 PF', $1, 1, TRUE) RETURNING id, tipo_pessoa`, [cpfFmt])).rows[0];
    const pj = (await pool.query(`INSERT INTO clientes (nome, cpf_cnpj, empresa_id, ativo) VALUES ('TESTE F0 PJ', $1, 1, TRUE) RETURNING id, tipo_pessoa`, [cnpj])).rows[0];
    limpar.clientes.push(pf.id, pj.id);
    ok(pf.tipo_pessoa === 'PF' && pj.tipo_pessoa === 'PJ', `tipo de pessoa calculado do documento (${pf.tipo_pessoa}/${pj.tipo_pessoa})`);
    const dup = await api(tokAdmin, '/clientes', 'POST', { nome: 'TESTE F0 dup', razao_social: 'TESTE F0 DUP', cpf_cnpj: cnpjFmt, email: 'f0dup@exemplo.com' });
    ok(dup.status === 400, `! CNPJ já cadastrado em outro formato é recusado (${dup.status} ${dup.body?.erro || ''})`);
    if (dup.body?.id) limpar.clientes.push(dup.body.id);
    let banco = null;
    try { await pool.query(`INSERT INTO clientes (nome, cpf_cnpj, empresa_id, ativo) VALUES ('TESTE F0 dup2', $1, 1, TRUE)`, [cpf]); }
    catch (e) { banco = e.code; }
    ok(banco === '23505', `banco recusa CPF duplicado mesmo sem passar pela tela (${banco})`);

    // --- Cenário 16: cliente sem empresa vinculada não vê chamados de ninguém ---
    limpar.chamados.push((await pool.query(
      `INSERT INTO chamados (empresa_id, cliente_id, titulo, descricao, status, prioridade, ativo)
       VALUES (1, $1, 'TESTE F0 chamado', 'x', 'aberto', 'media', TRUE) RETURNING id`, [pj.id])).rows[0].id);
    const semEmpresa = tok({ id: await usuarioTeste(pool, { cliente_id: null }), tipo: 'cliente', cliente_id: null });
    const lista = await api(semEmpresa, '/chamados');
    const itens = lista.body?.chamados || lista.body?.dados || lista.body || [];
    ok(lista.status === 200 && Array.isArray(itens) && itens.length === 0, `cliente sem empresa vê 0 chamados (${lista.status}, ${Array.isArray(itens) ? itens.length : '?'})`);
    const outroCli = tok({ id: await usuarioTeste(pool, { cliente_id: pf.id }), tipo: 'cliente', cliente_id: pf.id });
    const lista2 = await api(outroCli, '/chamados');
    const itens2 = lista2.body?.chamados || lista2.body?.dados || lista2.body || [];
    ok(Array.isArray(itens2) && !itens2.some(c => c.cliente_id === pj.id), 'cliente A não vê chamado do cliente B');
    ok((await api(outroCli, `/chamados/${limpar.chamados[0]}`)).status >= 400, 'cliente A não abre chamado do cliente B pelo id');

    // --- Cenário 18: revogação vale na hora (sem esperar o token de 8 h vencer) ---
    const email = `f0-login-${sufixo}@teste.local`;
    const uid = (await pool.query(
      `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo) VALUES ('TESTE F0 Login', $1, $2, 1, 'cliente', $3, TRUE) RETURNING id`,
      [email, await bcrypt.hash('Senha1234', 10), pj.id])).rows[0].id;
    const login = await api(null, '/auth/login', 'POST', { email, senha: 'Senha1234' });
    ok(login.status === 200 && jwt.decode(login.body.token).sv === 0, 'login devolve token com versão da sessão');
    const t1 = login.body.token;
    ok((await api(t1, '/treinamentos/meus')).status === 200, 'token novo funciona');
    ok((await api(tok({ id: uid, tipo: 'cliente', cliente_id: pj.id }), '/treinamentos/meus')).status === 200, 'token antigo (sem versão) segue valendo para quem não mudou nada');
    await api(tokAdmin, `/usuarios/${uid}`, 'PUT', { ativo: false });
    ok((await api(t1, '/treinamentos/meus')).status === 401, 'usuário desativado perde o acesso na hora (401)');
    await api(tokAdmin, `/usuarios/${uid}`, 'PUT', { ativo: true });
    ok((await api(t1, '/treinamentos/meus')).status === 200, 'reativado volta a acessar');
    await api(tokAdmin, `/usuarios/${uid}`, 'PUT', { tipo: 'cliente', cliente_id: pf.id });
    ok((await api(t1, '/treinamentos/meus')).status === 401, 'trocar a empresa do usuário encerra a sessão antiga');
    const t2 = (await api(null, '/auth/login', 'POST', { email, senha: 'Senha1234' })).body.token;
    ok(jwt.decode(t2).cliente_id === pf.id && (await api(t2, '/treinamentos/meus')).status === 200, 'novo login já vem com a empresa nova');
    await api(tokAdmin, `/usuarios/${uid}/senha`, 'PUT', { nova_senha: 'Outra1234' });
    ok((await api(t2, '/treinamentos/meus')).status === 401, 'senha redefinida pelo admin encerra a sessão');
    ok((await api(tok({ id: 99999999, tipo: 'cliente', cliente_id: pf.id }), '/treinamentos/meus')).status === 401, 'token de usuário inexistente é recusado');
    const aud = (await pool.query(`SELECT acao FROM auditoria WHERE entidade = 'usuario' AND entidade_id = $1`, [uid])).rows.map(r => r.acao);
    ok(aud.includes('usuario.alterado') && aud.includes('usuario.senha_redefinida'), `auditoria registra as mudanças do usuário (${aud.join(', ')})`);
    await pool.query('DELETE FROM auditoria WHERE entidade = $1 AND entidade_id = $2', ['usuario', uid]);
    await pool.query('DELETE FROM usuarios WHERE id = $1', [uid]);

    // --- Cenário 17: webhook repetido não reprocessa ---
    const evIgnorado = `evt_teste_f0_${sufixo}`;
    limpar.eventos.push(evIgnorado);
    const w1 = await webhook({ id: evIgnorado, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_inexistente', externalReference: 'cobranca-fatura-0' } });
    const w2 = await webhook({ id: evIgnorado, event: 'PAYMENT_RECEIVED', payment: { id: 'pay_inexistente', externalReference: 'cobranca-fatura-0' } });
    const ev = (await pool.query('SELECT * FROM asaas_eventos WHERE id = $1', [evIgnorado])).rows[0];
    ok(w1.status === 200 && w2.body?.repetido === true && ev?.tentativas === 2 && ev?.processado_em, `evento repetido só é confirmado (${JSON.stringify(w2.body)}, tentativas ${ev?.tentativas})`);

    // NFS-e: evento atrasado da mesma nota não volta "emitida" para "processando"
    const fid = (await pool.query(
      `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, status, nfse_status, nfse_asaas_id, nfse_numero)
       VALUES (1, $1, '2026-01-01', 'TESTE F0 fatura', 100, '2026-02-10', 'rascunho', 'emitida', $2, '123') RETURNING id`,
      [pj.id, `inv_f0_${sufixo}`])).rows[0].id;
    limpar.faturas.push(fid);
    const evNota = `evt_teste_f0_nota_${sufixo}`;
    limpar.eventos.push(evNota);
    await webhook({ id: evNota, event: 'INVOICE_SYNCHRONIZED', invoice: { id: `inv_f0_${sufixo}`, status: 'SYNCHRONIZED', externalReference: `fatura-${fid}` } });
    let f = (await pool.query('SELECT nfse_status, nfse_numero FROM faturas WHERE id = $1', [fid])).rows[0];
    ok(f.nfse_status === 'emitida' && f.nfse_numero === '123', `evento atrasado não regride a nota (${f.nfse_status})`);
    const evCancel = `evt_teste_f0_cancel_${sufixo}`;
    limpar.eventos.push(evCancel);
    await webhook({ id: evCancel, event: 'INVOICE_CANCELED', invoice: { id: `inv_f0_${sufixo}`, status: 'CANCELED', externalReference: `fatura-${fid}` } });
    f = (await pool.query('SELECT nfse_status FROM faturas WHERE id = $1', [fid])).rows[0];
    ok(f.nfse_status === 'cancelada', 'cancelamento da nota é aplicado');

    // --- Vagas: a mesma pessoa não ocupa duas vagas do contrato, nem com cliques simultâneos ---
    const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const cria = await api(tokAdmin, '/contratos-conector', 'POST', {
      cliente_id: pj.id, gestor_nome: 'Gestor F0', gestor_email: `gestor-f0-${sufixo}@teste.com`, vagas: { abap: 2, funcional: 1 }, data_fim: fim });
    ok(cria.status === 201, `contrato do Conector criado (${cria.status} ${cria.body?.erro || ''})`);
    const kid = cria.body.id;
    limpar.contratosConector.push(kid);
    const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = $1 ORDER BY id', [kid])).rows.map(v => v.id);
    const pessoa = { nome: 'Aluno Concorrente', email: `concorrente-f0-${sufixo}@teste.com` };
    const simultaneos = await Promise.all(vagas.slice(0, 3).map(v => api(tokAdmin, `/contratos-conector/${kid}/vagas/${v}/ocupar`, 'POST', pessoa)));
    const ocupadas = (await pool.query('SELECT COUNT(*)::int AS n FROM contratos_conector_vagas WHERE contrato_id = $1 AND usuario_id IS NOT NULL', [kid])).rows[0].n;
    ok(ocupadas === 1 && simultaneos.filter(r => r.status === 200).length === 1 && simultaneos.every(r => [200, 400].includes(r.status)),
      `3 pedidos simultâneos para a mesma pessoa: 1 vaga ocupada (${simultaneos.map(r => r.status).join('/')})`);
    if (ocupadas !== 1) throw new Error('sem vaga ocupada, o resto do teste de vagas não faz sentido');
    const vagaOcupada = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = $1 AND usuario_id IS NOT NULL', [kid])).rows[0].id;
    const lib = await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vagaOcupada}/liberar`, 'POST');
    ok(lib.status === 200, 'vaga liberada');
    const audVaga = (await pool.query(`SELECT acao, usuario_id FROM auditoria WHERE entidade = 'vaga_conector' AND entidade_id = $1 ORDER BY id`, [vagaOcupada])).rows;
    // A pessoa era nova (convite ainda não aceito): liberar = cancelar o convite (fase 2)
    ok(audVaga.map(a => a.acao).join(',') === 'vaga.ocupada,vaga.convite_cancelado' && audVaga.every(a => a.usuario_id === 1),
      `auditoria da vaga com quem fez (${audVaga.map(a => a.acao).join(', ')})`);

    // --- Oportunidade → contrato: dois cliques simultâneos geram um contrato só ---
    const oid = (await pool.query(
      `INSERT INTO oportunidades (empresa_id, cliente_id, titulo, etapa) VALUES (1, $1, 'TESTE F0 oportunidade', 'negociacao') RETURNING id`, [pj.id])).rows[0].id;
    limpar.oportunidades.push(oid);
    const corpo = { dia_vencimento: 10, data_inicio: '2026-11-01', descricao: 'TESTE F0 contrato', descricao_servico: 'Consultoria SAP', valor: 1000 };
    const dois = await Promise.all([1, 2].map(() => api(tokAdmin, `/comercial/oportunidades/${oid}/gerar-contrato`, 'POST', corpo)));
    const contratos = (await pool.query(`SELECT id FROM contratos WHERE observacoes LIKE $1`, [`Gerado da oportunidade #${oid} %`])).rows.map(r => r.id);
    limpar.contratos.push(...contratos);
    ok(contratos.length === 1 && dois.filter(r => r.status === 201).length === 1, `um contrato só (${dois.map(r => r.status).join('/')})`);
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    await pool.query('DELETE FROM asaas_eventos WHERE id = ANY($1)', [limpar.eventos]);
    await pool.query('DELETE FROM faturas WHERE id = ANY($1)', [limpar.faturas]);
    await pool.query('DELETE FROM oportunidades_historico WHERE oportunidade_id = ANY($1)', [limpar.oportunidades]);
    await pool.query('DELETE FROM oportunidades WHERE id = ANY($1)', [limpar.oportunidades]);
    await pool.query('DELETE FROM contratos WHERE id = ANY($1)', [limpar.contratos]);
    if (limpar.contratosConector.length) {
      const k = limpar.contratosConector;
      const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [k])).rows.map(v => v.id);
      await pool.query(`DELETE FROM auditoria WHERE entidade = 'vaga_conector' AND entidade_id = ANY($1)`, [vagas]);
      const pessoas = (await pool.query(`SELECT id FROM usuarios WHERE email LIKE $1`, ['%-f0-%@teste.com'])).rows.map(u => u.id);
      await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = ANY($1)', [k]);
      await pool.query('DELETE FROM contratos_conector WHERE id = ANY($1)', [k]);
      await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [pessoas]);
      await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [pessoas]);
    }
    await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [limpar.chamados]);
    await apagarUsuariosTeste(pool);
    await pool.query(`DELETE FROM clientes WHERE nome LIKE 'TESTE F0%'`);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    process.exit(falhas ? 1 : 0);
  }
})().catch(async e => { console.error(e); process.exit(1); });
