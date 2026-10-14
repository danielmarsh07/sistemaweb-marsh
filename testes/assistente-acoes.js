// Ações por voz da Ivy (oportunidades, posts) e consultas de treinamentos, chamadas direto (sem a OpenAI).
// Confere que nada grava sem usuario_confirmou, as mesmas regras das telas e as permissões. Apaga o que cria.
require('./_ambiente-local');
const pool = require('../backend/db');
const { runTool, getToolDefinitionsParaContexto } = require('../backend/services/assistente-tools');

const ACOES = ['criar_oportunidade', 'mover_oportunidade', 'anotar_oportunidade', 'agendar_post', 'cancelar_post',
  'resumo_treinamentos', 'progresso_treinamento'];

(async () => {
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const u = (await pool.query(`SELECT id, empresa_id FROM usuarios WHERE tipo IN ('admin_empresa','admin_sistema') ORDER BY id LIMIT 1`)).rows[0];
  const admin = { empresa_id: u.empresa_id, usuario_id: u.id, tipo: 'admin_empresa', nome: 'Teste' };
  const nomes = ctx => getToolDefinitionsParaContexto(ctx).map(d => d.function.name);
  const criados = { oportunidades: [], posts: [], curso: null };
  const futuro = new Date(Date.now() + 3 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) + 'T12:30';

  try {
    ok(ACOES.every(n => nomes(admin).includes(n)), 'admin vê as 7 tools');
    ok(!ACOES.some(n => nomes({ ...admin, tipo: 'tecnico' }).includes(n)), 'técnico não vê');
    ok(!!(await runTool('criar_oportunidade', { ...admin, tipo: 'tecnico' }, { titulo: 'x', empresa: 'y', usuario_confirmou: true })).erro, 'técnico não executa');

    // ---- Oportunidades
    const conta = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM oportunidades WHERE titulo LIKE 'TESTE IVY%'`)).rows[0].n;
    const p1 = await runTool('criar_oportunidade', admin, { titulo: 'TESTE IVY AMS', empresa: 'TESTE IVY Prospect Ltda', valor_mensal: 5000 });
    ok(p1.precisa_confirmar && /5\.000/.test(p1.resumo) && (await conta()) === 0, `sem confirmar não grava: "${p1.resumo}"`);
    const c1 = await runTool('criar_oportunidade', admin, { titulo: 'TESTE IVY AMS', empresa: 'TESTE IVY Prospect Ltda', valor_mensal: 5000, usuario_confirmou: true });
    ok(c1.sucesso && (await conta()) === 1, `criada com confirmação: ${c1.mensagem || c1.erro}`);
    const op = (await pool.query(`SELECT id, etapa, probabilidade, criado_por_usuario_id FROM oportunidades WHERE titulo = 'TESTE IVY AMS'`)).rows[0];
    criados.oportunidades.push(op.id);
    ok(op.etapa === 'lead' && op.probabilidade === 10 && op.criado_por_usuario_id === u.id, 'etapa lead, probabilidade padrão 10% e autor registrado');

    const cli = (await pool.query(`SELECT COALESCE(NULLIF(nome_fantasia,''), razao_social, nome) AS n FROM clientes WHERE empresa_id = $1 AND ativo ORDER BY id LIMIT 1`, [u.empresa_id])).rows[0];
    if (cli) {
      const c2 = await runTool('criar_oportunidade', admin, { titulo: 'TESTE IVY Conector', cliente: cli.n, usuario_confirmou: true });
      const o2 = (await pool.query(`SELECT id, cliente_id, empresa_nome FROM oportunidades WHERE titulo = 'TESTE IVY Conector'`)).rows[0];
      if (o2) criados.oportunidades.push(o2.id);
      ok(c2.sucesso && o2 && o2.cliente_id && !o2.empresa_nome, `oportunidade de cliente cadastrado (${cli.n})`);
    }
    ok(!!(await runTool('criar_oportunidade', admin, { titulo: 'x', cliente: 'Cliente Que Nao Existe 123' })).erro, 'cliente inexistente é recusado');

    const m0 = await runTool('mover_oportunidade', admin, { oportunidade: 'TESTE IVY AMS', etapa: 'perdida' });
    ok(!!m0.erro && /motivo/i.test(m0.erro), 'perdida sem motivo é recusada');
    const m1 = await runTool('mover_oportunidade', admin, { oportunidade: 'TESTE IVY AMS', etapa: 'negociacao' });
    ok(m1.precisa_confirmar && (await pool.query('SELECT etapa FROM oportunidades WHERE id = $1', [op.id])).rows[0].etapa === 'lead', 'mover sem confirmar não grava');
    const m2 = await runTool('mover_oportunidade', admin, { oportunidade: 'TESTE IVY AMS', etapa: 'negociacao', usuario_confirmou: true });
    const depois = (await pool.query('SELECT etapa, probabilidade FROM oportunidades WHERE id = $1', [op.id])).rows[0];
    ok(m2.sucesso && depois.etapa === 'negociacao' && depois.probabilidade === 75, 'movida para negociação (75%)');
    const hist = (await pool.query(`SELECT tipo, texto FROM oportunidades_historico WHERE oportunidade_id = $1 ORDER BY id`, [op.id])).rows;
    ok(hist.some(h => h.tipo === 'etapa' && /Lead → Negociação/.test(h.texto)), 'mudança registrada no histórico');

    const n1 = await runTool('anotar_oportunidade', admin, { oportunidade: 'TESTE IVY AMS', nota: 'Pediu proposta até sexta', usuario_confirmou: true });
    ok(n1.sucesso && (await pool.query(`SELECT 1 FROM oportunidades_historico WHERE oportunidade_id = $1 AND tipo = 'nota' AND texto = 'Pediu proposta até sexta'`, [op.id])).rows.length === 1, 'nota registrada');
    ok(!!(await runTool('mover_oportunidade', admin, { oportunidade: 'TESTE IVY', etapa: 'proposta' })).opcoes, 'nome ambíguo devolve as opções');

    // ---- Posts
    const post = (await pool.query(`INSERT INTO marketing_posts (empresa_id, titulo, legenda) VALUES ($1, 'TESTE IVY post', 'legenda') RETURNING id`, [u.empresa_id])).rows[0].id;
    criados.posts.push(post);
    const a0 = await runTool('agendar_post', admin, { post: 'TESTE IVY post', data_hora: futuro, usuario_confirmou: true });
    ok(!!a0.erro && /imagem/i.test(a0.erro), `sem imagem não agenda: ${a0.erro}`);
    await pool.query(`INSERT INTO marketing_midias (post_id, storage_key) VALUES ($1, 'teste/ivy.jpg')`, [post]);
    ok(!!(await runTool('agendar_post', admin, { post: 'TESTE IVY post', data_hora: '2020-01-01T10:00', usuario_confirmou: true })).erro, 'data passada é recusada');
    const a1 = await runTool('agendar_post', admin, { post: 'TESTE IVY post', data_hora: futuro });
    ok(a1.precisa_confirmar && /12:30/.test(a1.resumo), `pede confirmação: "${a1.resumo}"`);
    const a2 = await runTool('agendar_post', admin, { post: 'TESTE IVY post', data_hora: futuro, usuario_confirmou: true });
    const pa = (await pool.query(`SELECT status, to_char(data_agendada AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI') AS q FROM marketing_posts WHERE id = $1`, [post])).rows[0];
    ok(a2.sucesso && pa.status === 'agendado' && pa.q === futuro, `agendado em Brasília: ${pa.q}`);
    const x1 = await runTool('cancelar_post', admin, { post: 'TESTE IVY post', usuario_confirmou: true });
    ok(x1.sucesso && (await pool.query('SELECT status FROM marketing_posts WHERE id = $1', [post])).rows[0].status === 'cancelado', 'post cancelado');

    // ---- Treinamentos
    criados.curso = (await pool.query(`INSERT INTO cursos (empresa_id, titulo, status) VALUES ($1, 'TESTE IVY Curso', 'publicado') RETURNING id`, [u.empresa_id])).rows[0].id;
    const aula1 = (await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, video_url, duracao_min) VALUES ($1, 'Aula 1', 'https://www.youtube-nocookie.com/embed/x', 10) RETURNING id`, [criados.curso])).rows[0].id;
    await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, duracao_min) VALUES ($1, 'Aula 2', 15)`, [criados.curso]);
    await pool.query(`INSERT INTO cursos_progresso (usuario_id, aula_id) VALUES ($1, $2)`, [u.id, aula1]);
    const rt = await runTool('resumo_treinamentos', admin, { curso: 'TESTE IVY' });
    const cur = rt.cursos.find(c => c.titulo === 'TESTE IVY Curso');
    ok(cur && cur.aulas === 2 && cur.aulas_com_video === 1 && cur.minutos === 25, 'resumo: 2 aulas, 1 com vídeo, 25 min');
    ok(rt.aulas_do_curso && rt.aulas_do_curso.some(a => a.titulo === 'Aula 2' && !a.tem_video), 'lista a aula sem vídeo');
    const pt = await runTool('progresso_treinamento', admin, { curso: 'TESTE IVY' });
    ok(pt.alunos && pt.alunos.length === 1 && pt.alunos[0].concluidas === 1 && !pt.alunos[0].concluiu_o_curso, 'progresso: 1 de 2 aulas');
  } catch (e) {
    ok(false, `exceção: ${e.stack}`);
  } finally {
    if (criados.oportunidades.length) {
      await pool.query('DELETE FROM oportunidades_historico WHERE oportunidade_id = ANY($1)', [criados.oportunidades]);
      await pool.query('DELETE FROM oportunidades WHERE id = ANY($1)', [criados.oportunidades]);
    }
    await pool.query(`DELETE FROM oportunidades_historico WHERE oportunidade_id IN (SELECT id FROM oportunidades WHERE titulo LIKE 'TESTE IVY%')`);
    await pool.query(`DELETE FROM oportunidades WHERE titulo LIKE 'TESTE IVY%'`);
    if (criados.posts.length) await pool.query('DELETE FROM marketing_posts WHERE id = ANY($1)', [criados.posts]);
    if (criados.curso) {
      await pool.query('DELETE FROM cursos_progresso WHERE aula_id IN (SELECT id FROM cursos_aulas WHERE curso_id = $1)', [criados.curso]);
      await pool.query('DELETE FROM cursos_aulas WHERE curso_id = $1', [criados.curso]);
      await pool.query('DELETE FROM cursos WHERE id = $1', [criados.curso]);
    }
    console.log('OK   limpeza');
    await pool.end();
  }
})();
