// Tools de gestão da Ivy (comercial, contratos, DRE, caixa, marketing, alertas, licenças), chamadas direto (sem a OpenAI).
// Confere permissões, que os números batem com os das telas (mesmos serviços) e os filtros principais. Apaga o que cria.
require('./_ambiente-local');
const pool = require('../backend/db');
const { runTool, getToolDefinitionsParaContexto } = require('../backend/services/assistente-tools');
const com = require('../backend/services/comercial');
const relatorios = require('../backend/services/relatorios-financeiros');

const GESTAO = ['resumo_comercial', 'listar_propostas', 'simular_preco_conector', 'listar_contratos', 'consultar_dre',
  'projecao_caixa', 'resumo_marketing', 'listar_alertas', 'resumo_licencas'];

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const admin = { empresa_id: 1, usuario_id: u.id, tipo: 'admin_empresa', nome: 'Teste' };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const nomes = ctx => getToolDefinitionsParaContexto(ctx).map(d => d.function.name);
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const criados = { oportunidade: null, post: null, alerta: null };

  try {
    // Permissões: só administradores
    ok(GESTAO.every(n => nomes(admin).includes(n)), 'admin vê as 9 tools de gestão');
    ok(!GESTAO.some(n => nomes({ ...admin, tipo: 'tecnico' }).includes(n)), 'técnico não vê nenhuma');
    ok(!GESTAO.some(n => nomes({ ...admin, tipo: 'cliente', cliente_id: 1 }).includes(n)), 'cliente não vê nenhuma');
    ok((await runTool('resumo_marketing', { ...admin, tipo: 'tecnico' }, {})).erro, 'técnico não executa');

    // Todas respondem sem erro
    for (const n of GESTAO) {
      const r = await runTool(n, admin, n === 'simular_preco_conector' ? { funcionais: 3, abaps: 1 } : {});
      ok(r && !r.erro, `${n} responde${r && r.erro ? ': ' + r.erro : ''}`);
    }

    // Comercial: oportunidade em negociação aparece no funil, no filtro por etapa e na busca
    const funil0 = await com.resumoFunil(1);
    criados.oportunidade = (await pool.query(
      `INSERT INTO oportunidades (empresa_id, titulo, empresa_nome, etapa, valor_mensal, valor_unico, probabilidade)
       VALUES (1, 'TESTE IVY oportunidade', 'TESTE IVY Ltda', 'negociacao', 2000, 5000, 75) RETURNING id`)).rows[0].id;
    const rc = await runTool('resumo_comercial', admin, { etapa: 'negociacao', busca: 'TESTE IVY' });
    ok(rc.resumo.abertas === funil0.abertas + 1, `funil: abertas ${funil0.abertas} → ${rc.resumo.abertas}`);
    ok(Math.abs(rc.resumo.ponderado_mensal - funil0.ponderado_mensal - 1500) < 0.01, 'ponderado soma 2000 × 75%');
    ok(rc.oportunidades.length === 1 && rc.oportunidades[0].empresa === 'TESTE IVY Ltda', 'filtro por etapa + busca acha a oportunidade');
    ok((await runTool('resumo_comercial', admin, { etapa: 'lead', busca: 'TESTE IVY' })).oportunidades.length === 0, 'outra etapa não traz');

    // Simulador: mesmo resultado da tela
    const sim = await runTool('simular_preco_conector', admin, { funcionais: 5, abaps: 2, ciclo: 'anual' });
    const tela = await com.simularConector({ funcionais: 5, abaps: 2, ciclo: 'anual' }, 1);
    ok(sim.totais.total_mensal === tela.resultado.totais.total_mensal && sim.totais.total_unico === tela.resultado.totais.total_unico,
      `simulador igual à tela: ${sim.totais.total_mensal}/mês + ${sim.totais.total_unico}`);
    ok(!!(await runTool('simular_preco_conector', admin, { funcionais: 0, abaps: 0 })).erro, 'simulador sem usuários é recusado');

    // DRE: o mês e o acumulado batem com a tela
    const ano = Number(hoje.slice(0, 4)), mes = Number(hoje.slice(5, 7));
    const dreTela = await relatorios.montarDre(1, ano);
    const liqTela = dreTela.linhas.find(l => l.chave === 'resultado_liquido').valores;
    const dreMes = await runTool('consultar_dre', admin, { mes });
    const linhaLiq = d => d.linhas.find(l => l.linha === 'Resultado líquido').valor;
    ok(Math.abs(linhaLiq(dreMes) - liqTela[mes - 1]) < 0.01, `DRE do mês igual à tela: ${linhaLiq(dreMes)}`);
    const dreAcum = await runTool('consultar_dre', admin, {});
    ok(Math.abs(linhaLiq(dreAcum) - liqTela.slice(0, mes).reduce((s, v) => s + v, 0)) < 0.01, 'DRE acumulado igual à soma da tela');
    ok(!!(await runTool('consultar_dre', admin, { mes: 13 })).erro, 'mês 13 recusado');

    // Caixa: saldos iguais à tela
    const pc = await runTool('projecao_caixa', admin, { meses: 4 });
    const fluxoTela = await relatorios.montarFluxoCaixa(1, hoje.slice(0, 7), 4);
    ok(pc.meses.length === 4 && pc.meses.every((m, i) => m.saldo_fim === fluxoTela.meses[i].saldo_final), 'projeção igual ao fluxo de caixa da tela');

    // Contratos: MRR igual ao do resumo financeiro
    const lc = await runTool('listar_contratos', admin, {});
    const mrr = await runTool('resumo_financeiro_mes', admin, {});
    ok(Math.abs(lc.mrr_total - mrr.contratos.mrr) < 0.01, `MRR igual ao resumo do mês: ${lc.mrr_total}`);

    // Marketing: post agendado aparece nos próximos, com horário de Brasília
    criados.post = (await pool.query(
      `INSERT INTO marketing_posts (empresa_id, titulo, status, data_agendada)
       VALUES (1, 'TESTE IVY post', 'agendado', '2030-01-02T12:30:00-03:00') RETURNING id`)).rows[0].id;
    const rm = await runTool('resumo_marketing', admin, { proximos: 10 });
    const p = rm.proximos_agendados.find(x => x.titulo === 'TESTE IVY post');
    ok(p && p.quando === '2030-01-02 12:30', `post agendado em Brasília: ${p && p.quando}`);

    // Alertas: não lido aparece, lido some
    criados.alerta = (await pool.query(
      `INSERT INTO alertas_sistema (chave, titulo, detalhe) VALUES ('teste_ivy', 'TESTE IVY alerta', 'detalhe') RETURNING id`)).rows[0].id;
    ok((await runTool('listar_alertas', admin, {})).alertas.some(a => a.titulo === 'TESTE IVY alerta'), 'alerta não lido aparece');
    await pool.query('UPDATE alertas_sistema SET lido = TRUE WHERE id = $1', [criados.alerta]);
    ok(!(await runTool('listar_alertas', admin, {})).alertas.some(a => a.titulo === 'TESTE IVY alerta'), 'alerta resolvido some');

    // Chamados do conector: filtro novo do listar_chamados
    const lch = await runTool('listar_chamados', admin, { origem: 'conector', aprovacao: 'pendente', busca: 'x' });
    ok(!lch.erro && lch.filtros_aplicados.origem === 'conector', 'listar_chamados filtra origem e aprovação');
  } catch (e) {
    ok(false, `exceção: ${e.message}`);
  } finally {
    if (criados.oportunidade) await pool.query('DELETE FROM oportunidades WHERE id = $1', [criados.oportunidade]);
    if (criados.post) await pool.query('DELETE FROM marketing_posts WHERE id = $1', [criados.post]);
    if (criados.alerta) await pool.query('DELETE FROM alertas_sistema WHERE id = $1', [criados.alerta]);
    console.log('OK   limpeza');
    await pool.end();
  }
})();
