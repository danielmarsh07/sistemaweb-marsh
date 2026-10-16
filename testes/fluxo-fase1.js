require('./_ambiente-local');
// Fluxo novo — fase 1 (docs/plano-fluxo-novo.md): contratos unificados.
// Cenários 1, 2 e 3 do documento: empresa com vários contratos independentes, cobranças mensais por contrato,
// contrato anual do Conector. Mais: rascunhos sem duplicidade (manual e automático), histórico, reajuste,
// cobrança do Conector pela tabela de preços e proposta aceita → contrato com itens + fatura do valor único.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const fat = require('../backend/services/faturamento');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tokAdmin = jwt.sign({ id: 1, tipo: 'admin_empresa', empresa_id: 1 }, process.env.JWT_SECRET, { expiresIn: '10m' });
const api = async (p, m = 'GET', body) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokAdmin}` }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const contrato = (extra) => ({ descricao_servico: 'Serviço de teste', dia_vencimento: 10, data_inicio: '2027-01-01', emitir_nfse: false, ...extra });

(async () => {
  const sufixo = Date.now();
  const clientes = [];
  const novoCliente = async nome => {
    const id = (await pool.query(`INSERT INTO clientes (nome, empresa_id, ativo) VALUES ($1, 1, TRUE) RETURNING id`, [`TESTE F1 ${nome} ${sufixo}`])).rows[0].id;
    clientes.push(id); return id;
  };
  try {
    const cli = await novoCliente('Cloud CCM');
    const outro = await novoCliente('Outro');

    // --- Cenário 1: vários contratos independentes do mesmo cliente ---
    const sap = await api('/financeiro/contratos', 'POST', contrato({ cliente_id: cli, descricao: 'Consultoria SAP', valor: 10000 }));
    const cpi = await api('/financeiro/contratos', 'POST', contrato({ cliente_id: cli, descricao: 'Consultoria CPI', valor: 6000 }));
    const lic = await api('/financeiro/contratos', 'POST', contrato({ cliente_id: cli, descricao: 'Conector — 100 licenças', valor: 120000, tipo: 'produto', periodicidade: 'anual', mes_cobranca: 3, data_fim: '2028-03-15' }));
    ok([sap, cpi, lic].every(r => r.status === 201), `3 contratos do mesmo cliente (${[sap, cpi, lic].map(r => r.status).join('/')})`);
    const ids = [sap.body.id, cpi.body.id, lic.body.id];
    const lista = (await api('/financeiro/contratos')).body.filter(c => ids.includes(c.id));
    const anual = lista.find(c => c.id === lic.body.id);
    ok(anual.tipo === 'produto' && anual.periodicidade === 'anual' && anual.mes_cobranca === 3, 'contrato anual de produto gravado com o mês da cobrança');
    ok((await api('/financeiro/contratos', 'POST', contrato({ cliente_id: cli, descricao: 'x', valor: 1, periodicidade: 'semanal' }))).status === 400, '! periodicidade inválida recusada');

    // --- Cenário 2 e 3: cobranças por contrato; anual só no mês da cobrança ---
    const elegiveis = async comp => (await api(`/financeiro/fechamento?competencia=${comp}`)).body.filter(c => ids.includes(c.id)).map(c => c.id).sort();
    ok(JSON.stringify(await elegiveis('2027-03')) === JSON.stringify([...ids].sort()), 'março/2027: os 2 mensais + a anuidade');
    ok(JSON.stringify(await elegiveis('2027-04')) === JSON.stringify([sap.body.id, cpi.body.id].sort()), 'abril/2027: só os mensais');
    ok(!(await elegiveis('2028-03')).includes(lic.body.id), 'março/2028: contrato anual que vence em 15/03/2028 não gera nova anuidade');

    // Gerar em uma competência isolada só com contratos deste teste não é possível (o fechamento é da empresa),
    // então confere pelas faturas destes contratos
    const faturasDe = async comp => (await pool.query(
      `SELECT id, contrato_id, descricao, status FROM faturas WHERE contrato_id = ANY($1) AND competencia = $2::date ORDER BY contrato_id`, [ids, `${comp}-01`])).rows;
    await api('/financeiro/fechamento', 'POST', { competencia: '2027-03' });
    let f = await faturasDe('2027-03');
    ok(f.length === 3 && f.every(x => x.status === 'rascunho'), `fechamento gera 1 rascunho por contrato (${f.length})`);
    ok(f.find(x => x.contrato_id === lic.body.id).descricao.includes('Anuidade: 03/2027 a 02/2028'), 'fatura anual traz o período coberto');
    await api('/financeiro/fechamento', 'POST', { competencia: '2027-03' });
    ok((await faturasDe('2027-03')).length === 3, 'rodar o fechamento de novo não duplica');

    // Automático: não recria o que o admin cancelou; o manual recria
    const cancelada = f.find(x => x.contrato_id === cpi.body.id).id;
    await pool.query(`UPDATE faturas SET status = 'cancelada' WHERE id = $1`, [cancelada]);
    await fat.gerarRascunhos({ empresa_id: 1, competencia: '2027-03', automatico: true });
    f = await faturasDe('2027-03');
    ok(f.length === 3 && f.filter(x => x.status === 'rascunho').length === 2, 'rotina automática não recria fatura cancelada pelo admin');
    await fat.gerarRascunhos({ empresa_id: 1, competencia: '2027-04', automatico: true });
    ok((await faturasDe('2027-04')).length === 2, 'rotina automática gera os mensais do mês seguinte');
    await Promise.all([1, 2, 3].map(() => fat.gerarRascunhos({ empresa_id: 1, competencia: '2027-05', automatico: true })));
    ok((await faturasDe('2027-05')).length === 2, 'três rotinas ao mesmo tempo: sem duplicidade');

    // --- Histórico e reajuste ---
    const atual = lista.find(c => c.id === sap.body.id);
    await api(`/financeiro/contratos/${sap.body.id}`, 'PUT', { ...atual, valor: 11000, data_inicio: '2024-01-01', indice_reajuste: 'IPCA', mes_reajuste: 1 });
    let hist = (await api(`/financeiro/contratos/${sap.body.id}/historico`)).body;
    const alt = hist.find(h => h.acao === 'contrato.alterado');
    ok(alt && alt.antes.valor === '10000.00' && alt.depois.valor === '11000.00', 'histórico guarda o valor antes → depois');
    ok(hist.some(h => h.acao === 'contrato.criado'), 'histórico tem a criação');
    let c = (await api('/financeiro/contratos')).body.find(x => x.id === sap.body.id);
    ok(c.reajuste_pendente === true, 'contrato com reajuste IPCA em janeiro aparece como reajuste pendente');
    const rj = await api(`/financeiro/contratos/${sap.body.id}/reajuste`, 'POST', { percentual: 4.5, observacao: 'IPCA 12m' });
    c = (await api('/financeiro/contratos')).body.find(x => x.id === sap.body.id);
    ok(rj.status === 200 && c.valor === 11495 && c.reajuste_pendente === false, `reajuste de 4,5%: 11.000 → ${c.valor}, pendência some`);
    hist = (await api(`/financeiro/contratos/${sap.body.id}/historico`)).body;
    ok(hist[0].acao === 'contrato.reajustado' && hist[0].depois.percentual === 4.5, 'reajuste registrado no histórico');
    ok((await api(`/financeiro/contratos/${sap.body.id}/reajuste`, 'POST', {})).status === 400, '! reajuste sem valor recusado');

    // --- Conector: cobrança anual pela tabela de preços ---
    const sug = (await api('/contratos-conector/preco-sugerido?abap=2&funcional=1&ambos=0')).body.valor_anual;
    ok(sug > 0, `preço sugerido pela tabela (R$ ${sug})`);
    const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const k = await api('/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'Gestor F1', gestor_email: `gestor-f1-${sufixo}@teste.com`,
      vagas: { abap: 2, funcional: 1 }, data_fim: fim, cobranca: { gerar: true, dia_vencimento: 15 } });
    ok(k.status === 201 && k.body.contrato_financeiro_id, `contrato do Conector já nasce com cobrança (${k.body?.mensagem || k.body?.erro})`);
    const cob = (await pool.query('SELECT * FROM contratos WHERE id = $1', [k.body.contrato_financeiro_id])).rows[0];
    ok(cob.tipo === 'produto' && cob.periodicidade === 'anual' && Number(cob.valor) === sug && cob.contrato_conector_id === k.body.id && cob.dia_vencimento === 15,
      'cobrança: produto anual, valor da tabela, ligada às vagas');
    ok(Array.isArray(cob.itens) && cob.itens.length === 2, 'cobrança lista os itens por perfil');
    ok((await api(`/contratos-conector/${k.body.id}/cobranca`, 'POST', {})).status === 400, '! segunda cobrança para o mesmo contrato do Conector recusada');
    const det = (await api(`/contratos-conector/${k.body.id}`)).body;
    ok(det.cobranca && det.cobranca.id === cob.id, 'detalhe do contrato do Conector mostra a cobrança');
    const k2 = await api('/contratos-conector', 'POST', { cliente_id: outro, gestor_nome: 'Gestor F1b', gestor_email: `gestor-f1b-${sufixo}@teste.com`, vagas: { funcional: 1 }, data_fim: fim });
    ok(!(await api('/contratos-conector')).body.find(x => x.id === k2.body.id).contrato_financeiro_id, 'contrato sem cobrança aparece sem vínculo');
    const vincErrado = await api('/financeiro/contratos', 'POST', contrato({ cliente_id: cli, descricao: 'x', valor: 1, tipo: 'produto', contrato_conector_id: k2.body.id }));
    ok(vincErrado.status === 400, `! não liga cobrança a Conector de outro cliente (${vincErrado.body?.erro})`);
    const depois = await api(`/contratos-conector/${k2.body.id}/cobranca`, 'POST', { valor_anual: 5000 });
    ok(depois.status === 201, 'cobrança criada depois, para contrato antigo');

    // --- Proposta aceita → contrato com itens e fatura do valor único ---
    const oid = (await pool.query(`INSERT INTO oportunidades (empresa_id, cliente_id, titulo, etapa) VALUES (1, $1, 'TESTE F1 op', 'negociacao') RETURNING id`, [cli])).rows[0].id;
    const itens = [{ descricao: 'Sustentação SAP', tipo: 'mensal', quantidade: 1, valor_unitario: 8000 }, { descricao: 'Implantação', tipo: 'unico', quantidade: 1, valor_unitario: 15000 }];
    await pool.query(`INSERT INTO propostas (empresa_id, oportunidade_id, numero, titulo, itens, total_mensal, total_unico, validade, status, data_resposta)
      VALUES (1, $1, $2, 'Proposta F1', $3, 8000, 15000, CURRENT_DATE + 30, 'aceita', NOW())`, [oid, `P-F1-${sufixo}`.slice(0, 20), JSON.stringify(itens)]);
    const gc = await api(`/comercial/oportunidades/${oid}/gerar-contrato`, 'POST', { dia_vencimento: 10, data_inicio: '2027-02-01', descricao: 'TESTE F1 da proposta', descricao_servico: 'Sustentação', valor: 8000 });
    ok(gc.status === 201 && gc.body.fatura_unica_id, `contrato gerado da proposta (${gc.body?.mensagem || gc.body?.erro})`);
    const ctp = (await pool.query('SELECT itens, proposta_id FROM contratos WHERE id = $1', [gc.body.contrato_id])).rows[0];
    ok(ctp.proposta_id && ctp.itens.length === 2, 'itens da proposta copiados para o contrato');
    const fu = (await pool.query(`SELECT valor::float AS valor, status, contrato_id, to_char(competencia, 'YYYY-MM') AS comp FROM faturas WHERE id = $1`, [gc.body.fatura_unica_id])).rows[0];
    ok(fu.valor === 15000 && fu.status === 'rascunho' && !fu.contrato_id && fu.comp === '2027-02', 'valor único virou fatura avulsa em rascunho');
    ids.push(gc.body.contrato_id, cob.id, depois.body.contrato_financeiro_id);
    await pool.query('DELETE FROM faturas WHERE id = $1', [gc.body.fatura_unica_id]);
    await pool.query('UPDATE oportunidades SET contrato_id = NULL WHERE id = $1', [oid]);
    await pool.query('DELETE FROM oportunidades_historico WHERE oportunidade_id = $1', [oid]);
    await pool.query('DELETE FROM oportunidades WHERE id = $1', [oid]);

    // --- Aprovar duas vezes ao mesmo tempo: uma aprovação só ---
    const rasc = (await faturasDe('2027-04'))[0].id;
    const dupla = await Promise.all([1, 2].map(() => fat.aprovarFatura({ id: rasc, empresa_id: 1, emitir_nfse: false }, 1)));
    ok(dupla.filter(d => d.ja_aprovada).length === 1, 'aprovar a mesma fatura duas vezes: só a primeira processa');

    // limpeza dos contratos do Conector
    for (const kk of [k.body.id, k2.body.id]) {
      const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = $1', [kk])).rows.map(v => v.id);
      await pool.query(`DELETE FROM auditoria WHERE entidade = 'vaga_conector' AND entidade_id = ANY($1)`, [vagas]);
    }
    await pool.query('DELETE FROM faturas WHERE contrato_id = ANY($1)', [ids]);
    await pool.query(`DELETE FROM auditoria WHERE entidade = 'contrato' AND entidade_id = ANY($1)`, [ids]);
    await pool.query('DELETE FROM contratos WHERE id = ANY($1)', [ids]);
    for (const kk of [k.body.id, k2.body.id]) {
      await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = $1', [kk]);
      await pool.query('DELETE FROM contratos_conector WHERE id = $1', [kk]);
    }
    const gestores = (await pool.query(`SELECT id FROM usuarios WHERE email LIKE $1`, [`%-f1%-${sufixo}@teste.com`])).rows.map(u => u.id);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [gestores]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [gestores]);
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [clientes]).catch(e => console.error('limpeza clientes:', e.message));
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    process.exit(falhas ? 1 : 0);
  }
})();
