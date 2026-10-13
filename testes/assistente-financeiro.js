// Tools financeiras do assistente de voz, chamadas direto (sem a OpenAI): lançar, listar, dar baixa, permissões.
require('./_ambiente-local');
const pool = require('../backend/db');
const { runTool, getToolDefinitionsParaContexto } = require('../backend/services/assistente-tools');

(async () => {
  const u = (await pool.query(`SELECT id FROM usuarios ORDER BY id LIMIT 1`)).rows[0];
  const admin = { empresa_id: 1, usuario_id: u.id, tipo: 'admin_empresa', nome: 'Teste' };
  const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
  const nomes = ctx => getToolDefinitionsParaContexto(ctx).map(d => d.function.name);

  // Permissões
  ok(nomes(admin).includes('lancar_conta_pagar'), 'admin vê as tools do financeiro');
  ok(!nomes({ ...admin, tipo: 'tecnico' }).includes('consultar_saldo'), 'técnico não vê o financeiro');
  ok((await runTool('consultar_saldo', { ...admin, tipo: 'tecnico' }, {})).erro, 'técnico não executa o financeiro');
  ok(!nomes({ ...admin, tipo: 'cliente', cliente_id: 1 }).includes('listar_faturas'), 'cliente não vê o financeiro');

  const saldo0 = await runTool('consultar_saldo', admin, {});
  ok(typeof saldo0.saldo_em_caixa === 'number', `saldo em caixa: ${saldo0.saldo_em_caixa}`);

  // Lançar: categoria por nome aproximado, já paga
  const l1 = await runTool('lancar_conta_pagar', admin, { descricao: 'TESTE VOZ internet', valor: 120, categoria: 'internet', ja_paga: true });
  ok(l1.sucesso && l1.categoria === 'Telefonia e internet', `lançada e paga: ${l1.mensagem || l1.erro} (${l1.categoria})`);
  const saldo1 = await runTool('consultar_saldo', admin, {});
  ok(Math.abs(saldo0.saldo_em_caixa - saldo1.saldo_em_caixa - 120) < 0.01, `saldo caiu 120: ${saldo1.saldo_em_caixa}`);

  // Categoria inexistente devolve as disponíveis
  const l2 = await runTool('lancar_conta_pagar', admin, { descricao: 'TESTE VOZ x', valor: 10, categoria: 'Astronomia' });
  ok(l2.erro && Array.isArray(l2.categorias_disponiveis) && l2.categorias_disponiveis.length > 5, `categoria inexistente: ${l2.erro}`);

  // Recorrente exige confirmação
  const l3 = await runTool('lancar_conta_pagar', admin, { descricao: 'TESTE VOZ assinatura', valor: 50, categoria: 'Softwares e assinaturas', tipo: 'recorrente' });
  ok(!!l3.erro, 'recorrente sem confirmação é recusada');
  const l4 = await runTool('lancar_conta_pagar', admin, { descricao: 'TESTE VOZ assinatura', valor: 50, categoria: 'Softwares e assinaturas', tipo: 'recorrente', usuario_confirmou: true });
  ok(l4.sucesso && l4.lancamentos === 12, `recorrente confirmada: ${l4.lancamentos} meses`);

  // Em aberto → listar → pagar
  const l5 = await runTool('lancar_conta_pagar', admin, { descricao: 'TESTE VOZ conta de luz', valor: 230.5, categoria: 'Outras despesas', data_vencimento: '2026-10-20' });
  ok(l5.sucesso && l5.primeiro_vencimento === '2026-10-20' && l5.competencia === '2026-10', 'conta em aberto com vencimento e competência');
  const lst = await runTool('listar_contas_pagar', admin, { busca: 'TESTE VOZ conta de luz' });
  ok(lst.total_real === 1 && lst.contas[0].status === 'aberta', `listar por busca: ${lst.total_real}`);
  const pg = await runTool('pagar_conta', admin, { conta_id: lst.contas[0].id });
  ok(pg.sucesso && pg.valor_pago === 230.5, 'baixa com o valor da conta');
  ok((await runTool('pagar_conta', admin, { conta_id: lst.contas[0].id })).erro, 'segunda baixa recusada');

  const desp = await runTool('resumo_despesas', admin, { mes_de: '2026-10' });
  ok(desp.por_categoria.some(c => c.categoria === 'Telefonia e internet'), `resumo de despesas: total ${desp.total}`);
  const mes = await runTool('resumo_financeiro_mes', admin, {});
  ok(mes.contas_a_pagar && mes.faturamento, `resumo do mês ${mes.mes}: pago ${mes.contas_a_pagar.pago_no_mes}`);
  const fats = await runTool('listar_faturas', admin, { status: 'aberta' });
  ok(typeof fats.total_real === 'number', `faturas em aberto: ${fats.total_real}`);

  // Limpeza
  const del = await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = 1 AND descricao LIKE 'TESTE VOZ%'`);
  ok(del.rowCount === 14, `limpeza: ${del.rowCount} lançamentos apagados`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
