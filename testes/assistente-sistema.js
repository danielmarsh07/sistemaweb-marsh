// Ivy exclusiva do super usuário + tools de sistema (estrutura do banco, SELECT livre só leitura, documentação).
// Precisa do servidor local rodando (npm run dev:local) para os testes de acesso pela API.
require('./_ambiente-local');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { runTool, getToolDefinitionsParaContexto } = require('../backend/services/assistente-tools');
const { validarSql } = require('../backend/services/assistente-tools-sistema');

const API = process.env.API_TESTE || 'http://localhost:3000/api';
const SISTEMA = ['estrutura_banco', 'consultar_banco', 'documentacao_sistema'];

(async () => {
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const nomes = ctx => getToolDefinitionsParaContexto(ctx).map(d => d.function.name);
  const superU = (await pool.query(
    `SELECT id, nome, email, empresa_id, tipo, super_usuario FROM usuarios WHERE ativo = TRUE AND tipo IN ('admin_empresa','admin_sistema') ORDER BY id LIMIT 1`)).rows[0];
  // Administrador comum temporário (apagado no fim)
  const comum = (await pool.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, ativo)
     VALUES ('TESTE IVY admin comum', 'teste-ivy-admin@exemplo.local', 'x', $1, 'admin_empresa', TRUE)
     ON CONFLICT (email) DO UPDATE SET ativo = TRUE RETURNING id, nome, email, empresa_id, tipo, super_usuario`, [superU.empresa_id])).rows[0];
  const users = [superU, comum];
  const original = [[superU.id, superU.super_usuario]];
  const token = u => jwt.sign({ id: u.id, nome: u.nome, email: u.email, empresa_id: u.empresa_id, tipo: u.tipo }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const chamar = async (u, caminho, body) => {
    const r = await fetch(`${API}/assistente${caminho}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(u)}` },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  };

  try {
    await pool.query('UPDATE usuarios SET super_usuario = (id = $1) WHERE id = ANY($2)', [superU.id, users.map(u => u.id)]);

    // Acesso pela API
    ok((await chamar(superU, '/acesso')).corpo.permitido === true, 'super usuário: botão da Ivy liberado');
    ok((await chamar(comum, '/acesso')).corpo.permitido === false, 'administrador comum: botão escondido');
    ok((await chamar(comum, '/chat', { texto: 'oi' })).status === 403, 'administrador comum: chat recusado (403)');
    ok((await chamar(comum, '/tts', { texto: 'oi' })).status === 403, 'administrador comum: voz recusada (403)');
    const sup = await chamar(superU, '/tts', {});
    // Sem texto: 400 (ou 503 se o servidor local não tiver OPENAI_API_KEY) — o que importa é não ser 403
    ok([400, 503].includes(sup.status), `super usuário passa pela trava (não é 403): ${sup.status}`);
    await pool.query('UPDATE usuarios SET super_usuario = FALSE WHERE id = $1', [superU.id]);
    ok((await chamar(superU, '/acesso')).corpo.permitido === false, 'revogar a marca vale na hora, mesmo com o token antigo');
    await pool.query('UPDATE usuarios SET super_usuario = TRUE WHERE id = $1', [superU.id]);

    // Permissões das tools
    const ctxSuper = { empresa_id: superU.empresa_id, usuario_id: superU.id, tipo: superU.tipo, super_usuario: true };
    const ctxAdmin = { empresa_id: comum.empresa_id, usuario_id: comum.id, tipo: comum.tipo };
    ok(SISTEMA.every(n => nomes(ctxSuper).includes(n)), 'super usuário vê as tools de sistema');
    ok(!SISTEMA.some(n => nomes(ctxAdmin).includes(n)), 'administrador comum não vê');
    ok(!!(await runTool('consultar_banco', ctxAdmin, { sql: 'SELECT 1' })).erro, 'administrador comum não executa consultar_banco');

    // Validação do SQL
    const recusa = sql => !!validarSql(sql).erro;
    ok(recusa('DELETE FROM clientes'), 'DELETE recusado');
    ok(recusa('SELECT 1; DROP TABLE clientes'), 'dois comandos recusados');
    ok(recusa('SELECT 1 -- x'), 'comentário recusado');
    ok(recusa('WITH x AS (DELETE FROM clientes RETURNING id) SELECT * FROM x'), 'DELETE escondido em WITH recusado');
    ok(recusa("SELECT pg_sleep(10)"), 'pg_sleep recusado');
    ok(!recusa("SELECT nome FROM clientes WHERE nome ILIKE '%update%'"), 'palavra "update" dentro de texto é aceita');

    // Execução
    const c1 = await runTool('consultar_banco', ctxSuper, { sql: 'SELECT COUNT(*)::int AS n FROM clientes WHERE empresa_id = 1' });
    ok(!c1.erro && typeof c1.linhas[0].n === 'number', `SELECT agregado: ${c1.erro || c1.linhas[0].n + ' clientes'}`);
    const c2 = await runTool('consultar_banco', ctxSuper, { sql: 'SELECT id, email, senha FROM usuarios' });
    ok(!c2.erro && c2.linhas.every(l => l.senha === '[oculto]') && c2.colunas_mascaradas.includes('senha'), 'coluna senha mascarada');
    const c3 = await runTool('consultar_banco', ctxSuper, { sql: "SELECT nextval('clientes_id_seq')" });
    ok(!!c3.erro && /read-only/i.test(c3.erro), 'transação só leitura barra escrita escondida em função');
    const c4 = await runTool('consultar_banco', ctxSuper, { sql: 'SELECT generate_series(1, 500) AS n' });
    ok(c4.quantidade === 50 && c4.cortado_em_50, 'limite de 50 linhas');
    const c5 = await runTool('consultar_banco', ctxSuper, { sql: 'SELECT coluna_que_nao_existe FROM clientes' });
    ok(!!c5.erro, 'erro do banco volta como mensagem');

    // Estrutura e documentação
    const e1 = await runTool('estrutura_banco', ctxSuper, {});
    ok(e1.total_tabelas > 20 && e1.tabelas.some(t => t.tabela === 'chamados'), `lista ${e1.total_tabelas} tabelas`);
    const e2 = await runTool('estrutura_banco', ctxSuper, { tabela: 'contratos' });
    ok(e2.tabela === 'contratos' && e2.ligacoes.some(l => l.referencia_tabela === 'clientes'), 'detalhe de contratos com a ligação a clientes');
    const d1 = await runTool('documentacao_sistema', ctxSuper, {});
    ok(d1.indice.length > 20, `índice da documentação: ${d1.indice.length} seções`);
    const d2 = await runTool('documentacao_sistema', ctxSuper, { busca: 'fluxo de caixa' });
    ok(!d2.erro && d2.secoes.length > 0, `busca "fluxo de caixa": ${d2.secoes && d2.secoes[0].titulo}`);
  } catch (e) {
    ok(false, `exceção: ${e.message}`);
  } finally {
    for (const [id, valor] of original) await pool.query('UPDATE usuarios SET super_usuario = $2 WHERE id = $1', [id, valor]);
    await pool.query('DELETE FROM usuarios WHERE id = $1', [comum.id]);
    console.log('OK   marca de super usuário restaurada e administrador temporário apagado');
    await pool.end();
  }
})();
