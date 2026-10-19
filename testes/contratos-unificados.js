require('./_ambiente-local');
// Contratos unificados (docs/plano-contratos-unificados.md):
//   fase 1 — preço negociado por contrato do Conector (a tabela é só a lista), licenças a mais = fatura proporcional
//            e anuidade nova, a menos = anuidade menor, contrato antigo sem preço guardado mantém o desconto;
//   fase 2 — contrato de cursos POR PESSOAS (cortesia, pagamento único, mensal): só quem está numa vaga vê os cursos,
//            o gestor preenche/libera vagas no portal, não sai pela tela de Treinamentos e encerrar tira o acesso;
//   visão mensal — contrato anual estimado só no mês da cobrança.
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const { usuarioTeste, apagarUsuariosTeste } = require('./_usuarios-teste');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '5m' });
const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const maisDias = n => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

(async () => {
  const sufixo = Date.now();
  const cli = (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ('TESTE Unificado', 'TESTE UNIFICADO LTDA', 'unificado@exemplo.com', 1, TRUE) RETURNING id`)).rows[0].id;
  const curso = (await pool.query(
    `INSERT INTO cursos (empresa_id, titulo, status, ordem) VALUES (1, $1, 'publicado', 999) RETURNING id`, [`TESTE curso empresa ${sufixo}`])).rows[0].id;
  const curso2 = (await pool.query(
    `INSERT INTO cursos (empresa_id, titulo, status, ordem) VALUES (1, $1, 'publicado', 999) RETURNING id`, [`TESTE curso empresa B ${sufixo}`])).rows[0].id;
  const tokAdmin = tok({ id: 1, tipo: 'admin_empresa' });
  const api = async (t, p, m = 'GET', body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const financeiro = async kid => (await pool.query('SELECT * FROM contratos WHERE contrato_conector_id = $1', [kid])).rows[0];
  const fim = maisDias(365);

  try {
    // ===== Fase 1: preço por contrato =====
    const lista = (await api(tokAdmin, '/contratos-conector/preco-sugerido?abap=1&funcional=0&ambos=0')).body;
    ok(lista.origem === 'tabela' && lista.linhas[0].preco_lista > 0 && lista.linhas[0].preco_mensal === lista.linhas[0].preco_lista,
      'sem cliente: preço sugerido = tabela de lista');

    const cria = await api(tokAdmin, '/contratos-conector', 'POST', {
      cliente_id: cli, gestor_nome: 'Gestor Unificado', gestor_email: `gestor-unif-${sufixo}@teste.com`,
      vagas: { abap: 2, funcional: 1 }, precos: { abap: 500, funcional: 300, ambos: 600 }, data_fim: fim,
      cobranca: { gerar: true, dia_vencimento: 15 } });
    ok(cria.status === 201, `cria contrato com preço negociado (${cria.body?.mensagem || cria.body?.erro})`);
    const kid = cria.body.id;
    let cob = await financeiro(kid);
    ok(cob && Number(cob.valor) === (2 * 500 + 300) * 12, `cobrança anual = licenças × preço do contrato × 12 (${cob && cob.valor})`);
    ok(Array.isArray(cob.itens) && cob.itens.find(i => i.perfil === 'abap').valor_unitario === 6000, 'itens da cobrança com o preço por licença no ano');
    const k = (await pool.query('SELECT precos FROM contratos_conector WHERE id = $1', [kid])).rows[0];
    ok(k.precos && k.precos.abap === 500 && k.precos.ambos === 600, 'preço negociado guardado no contrato');

    const sug = (await api(tokAdmin, `/contratos-conector/preco-sugerido?abap=1&funcional=0&ambos=0&cliente_id=${cli}`)).body;
    ok(sug.origem === 'cliente' && sug.linhas[0].preco_mensal === 500 && sug.contrato_referencia === kid, 'próximo contrato do cliente sugere o preço do último');

    const det = (await api(tokAdmin, `/contratos-conector/${kid}`)).body;
    ok(det.preco && det.preco.origem === 'contrato' && det.preco.precos.funcional === 300 && det.preco.lista.abap === lista.linhas[0].preco_lista,
      'detalhe traz preço do contrato e preço de lista');

    // Licenças a mais: prévia e aplicação
    const previa = (await api(tokAdmin, `/contratos-conector/${kid}/licencas/previa?abap=1&funcional=0&ambos=0`)).body;
    ok(previa.meses === 12 && previa.valor_proporcional === 500 * 12 && previa.valor_anual_novo === 15600 + 6000,
      `prévia: proporcional ${previa.valor_proporcional} (${previa.meses} meses), anuidade ${previa.valor_anual_atual} → ${previa.valor_anual_novo}`);
    const mais = await api(tokAdmin, `/contratos-conector/${kid}/vagas`, 'POST', { abap: 1 });
    ok(mais.status === 201 && mais.body.fatura_id, `acrescenta licença com fatura proporcional (${mais.body?.mensagem || mais.body?.erro})`);
    const fat = (await pool.query('SELECT * FROM faturas WHERE id = $1', [mais.body.fatura_id])).rows[0];
    ok(fat && fat.status === 'rascunho' && Number(fat.valor) === 6000 && fat.contrato_id === null && fat.cliente_id === cli,
      'fatura proporcional em rascunho, fora da competência da anuidade');
    cob = await financeiro(kid);
    ok(Number(cob.valor) === 21600 && /3 ABAP/.test(cob.descricao_servico), `anuidade e descrição atualizadas (${cob.valor})`);

    // Licença a menos: anuidade menor, sem fatura
    const livre = (await api(tokAdmin, `/contratos-conector/${kid}`)).body.vagas.find(v => v.perfil === 'funcional' && !v.usuario_id);
    const menos = await api(tokAdmin, `/contratos-conector/${kid}/vagas/${livre.id}`, 'DELETE');
    cob = await financeiro(kid);
    ok(menos.status === 200 && Number(cob.valor) === 21600 - 3600, `remove licença livre: anuidade ${cob.valor}`);
    ok((await api(tokAdmin, `/contratos-conector/${kid}/licencas/previa?abap=0&funcional=0&ambos=0`)).body.novo.funcional === 0, 'prévia reflete a remoção');

    // Mudar o preço do contrato
    const p2 = await api(tokAdmin, `/contratos-conector/${kid}/precos`, 'PUT', { precos: { abap: 400 } });
    cob = await financeiro(kid);
    ok(p2.status === 200 && Number(cob.valor) === 3 * 400 * 12, `novo preço vale para a anuidade (${cob.valor})`);
    ok((await api(tokAdmin, `/contratos-conector/${kid}/precos`, 'PUT', { precos: { abap: -1 } })).status === 400, '! recusa preço negativo');

    // Mudar o perfil de uma licença: ABAP (400) → ABAP + Funcional (600) cobra só a diferença nos meses que faltam
    const vagaTroca = (await api(tokAdmin, `/contratos-conector/${kid}`)).body.vagas.find(v => v.perfil === 'abap');
    const pvT = (await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vagaTroca.id}/perfil/previa?para=ambos`)).body;
    ok(pvT.valor_proporcional === 200 * 12 && pvT.valor_anual_novo === (2 * 400 + 600) * 12,
      `prévia da troca: diferença ${pvT.valor_proporcional}, anuidade ${pvT.valor_anual_atual} → ${pvT.valor_anual_novo}`);
    ok((await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vagaTroca.id}/perfil/previa?para=abap`)).status === 400, '! troca para o mesmo perfil');
    const troca = await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vagaTroca.id}/perfil`, 'POST', { perfil: 'ambos' });
    const fatT = troca.body.fatura_id && (await pool.query('SELECT * FROM faturas WHERE id = $1', [troca.body.fatura_id])).rows[0];
    ok(troca.status === 200 && fatT && Number(fatT.valor) === 2400 && /mudança de perfil/.test(fatT.descricao), `troca gera fatura da diferença (${troca.body?.mensagem || troca.body?.erro})`);
    cob = await financeiro(kid);
    ok(Number(cob.valor) === 16800 && (await pool.query('SELECT perfil FROM contratos_conector_vagas WHERE id = $1', [vagaTroca.id])).rows[0].perfil === 'ambos',
      `licença virou ABAP + Funcional e a anuidade subiu (${cob.valor})`);
    const volta = await api(tokAdmin, `/contratos-conector/${kid}/vagas/${vagaTroca.id}/perfil`, 'POST', { perfil: 'abap' });
    cob = await financeiro(kid);
    ok(volta.status === 200 && !volta.body.fatura_id && Number(cob.valor) === 3 * 400 * 12, `troca para perfil mais barato: sem fatura, anuidade menor (${cob.valor})`);

    // Mudar a tabela de lista não mexe no contrato
    const tabelaAntes = (await pool.query('SELECT prop_precos_conector FROM financeiro_config WHERE empresa_id = 1')).rows[0];
    await pool.query(`UPDATE financeiro_config SET prop_precos_conector = COALESCE(prop_precos_conector, '{}'::jsonb) || '{"dev_anual": 1234}'::jsonb WHERE empresa_id = 1`);
    const det2 = (await api(tokAdmin, `/contratos-conector/${kid}`)).body;
    ok(det2.preco.precos.abap === 400 && det2.preco.lista.abap === 1234, 'tabela mudou: contrato segue com o preço dele');
    await pool.query('UPDATE financeiro_config SET prop_precos_conector = $1 WHERE empresa_id = 1', [tabelaAntes ? tabelaAntes.prop_precos_conector : null]);

    // Contrato antigo (sem preço guardado, valor anual digitado): preço sai do valor cobrado, mantendo o desconto
    const antigo = await api(tokAdmin, '/contratos-conector', 'POST', {
      cliente_id: cli, gestor_nome: 'Gestor Unificado', gestor_email: `gestor-unif-${sufixo}@teste.com`,
      vagas: { abap: 1 }, data_fim: fim, cobranca: { gerar: true, valor_anual: 100 } });
    const detA = (await api(tokAdmin, `/contratos-conector/${antigo.body.id}`)).body;
    ok(detA.preco.origem === 'cobranca' && Math.abs(detA.preco.precos.abap * 12 - 100) < 0.1, `contrato sem preço guardado: preço pelo valor cobrado (${detA.preco.precos.abap}/mês)`);

    // ===== Visão mensal: anual só no mês da cobrança (antes de existir contrato mensal do cliente) =====
    const vm = (await api(tokAdmin, `/financeiro/visao-mensal?inicio=${hoje().slice(0, 7)}&meses=12`)).body;
    const linha = vm.receitas.find(l => l.chave === `cli:${cli}`);
    const mesesEstimados = linha ? Object.values(linha.celulas).filter(c => c.estimado).length : 0;
    ok(linha && mesesEstimados === 1, `visão mensal: contratos anuais estimados em 1 mês só (${mesesEstimados})`);

    // ===== Fase 3: pacote Empresa, ciclo mensal e proposta que vira contrato =====
    const gestorBase = { cliente_id: cli, gestor_nome: 'Gestor Unificado', gestor_email: `gestor-unif-${sufixo}@teste.com`, data_fim: fim };
    const emp = await api(tokAdmin, '/contratos-conector', 'POST', { ...gestorBase, vagas: { abap: 4, funcional: 3 }, modalidade: 'empresa',
      precos: { empresa_ate5: 3000, empresa_ate10: 5000, empresa_excedente: 400 }, cobranca: { gerar: true } });
    let cobE = emp.status === 201 && await financeiro(emp.body.id);
    ok(cobE && Number(cobE.valor) === 5000 * 12 && /pacote Empresa/.test(cobE.descricao_servico),
      `pacote Empresa: 7 usuários = faixa até 10 × 12 (${cobE && cobE.valor} ${emp.body?.erro || ''})`);
    const prevE = (await api(tokAdmin, `/contratos-conector/${emp.body.id}/licencas/previa?abap=4&funcional=0&ambos=0`)).body;
    ok(prevE.valor_anual_novo === (5000 + 400) * 12 && prevE.valor_proporcional === 400 * prevE.meses,
      `pacote: 11 usuários = faixa + 1 excedente; proporcional = diferença × meses (${prevE.valor_proporcional})`);
    await api(tokAdmin, `/contratos-conector/${emp.body.id}/vagas`, 'POST', { abap: 4 });
    cobE = await financeiro(emp.body.id);
    ok(Number(cobE.valor) === 5400 * 12 && cobE.itens.length === 2, 'pacote: anuidade e itens (pacote + excedente) atualizados');
    ok((await api(tokAdmin, `/contratos-conector/${emp.body.id}/licencas/previa?abap=1&funcional=0&ambos=0`)).body.valor_proporcional === 400 * prevE.meses,
      'pacote acima de 10: cada usuário a mais custa o excedente');

    const men = await api(tokAdmin, '/contratos-conector', 'POST', { ...gestorBase, vagas: { abap: 2 }, ciclo: 'mensal',
      precos: { abap: 990 }, cobranca: { gerar: true } });
    let cobM = await financeiro(men.body.id);
    ok(cobM && cobM.periodicidade === 'mensal' && Number(cobM.valor) === 1980 && cobM.mes_cobranca === null, `ciclo mensal: cobrança mensal de ${cobM && cobM.valor}`);
    const maisM = await api(tokAdmin, `/contratos-conector/${men.body.id}/vagas`, 'POST', { abap: 1 });
    cobM = await financeiro(men.body.id);
    ok(!maisM.body.fatura_id && Number(cobM.valor) === 2970, 'ciclo mensal: licença a mais muda a mensalidade, sem fatura proporcional');
    ok((await api(tokAdmin, '/contratos-conector', 'POST', { ...gestorBase, vagas: { abap: 1 }, ciclo: 'semanal' })).status === 400, '! recusa ciclo inválido');

    // Proposta pelo simulador → aceita → gerar contrato do Conector
    const op = await api(tokAdmin, '/comercial/oportunidades', 'POST', { titulo: `TESTE Conector ${sufixo}`, cliente_id: cli,
      contato_nome: 'Comprador Teste', contato_email: `comprador-${sufixo}@teste.com` });
    const prop = await api(tokAdmin, `/comercial/oportunidades/${op.body.id}/propostas`, 'POST',
      { simulador_conector: { funcionais: 2, abaps: 3, ciclo: 'anual', modalidade: 'individual', porte: 'nenhum' } });
    const pc = (await pool.query('SELECT conector FROM propostas WHERE id = $1', [prop.body.id])).rows[0].conector;
    ok(pc && pc.abaps === 3 && pc.funcionais === 2 && pc.modalidade === 'licenca' && pc.ciclo === 'anual' && pc.precos.abap > 0,
      'proposta do simulador guarda a simulação');
    await api(tokAdmin, `/comercial/propostas/${prop.body.id}/enviar`, 'POST', { enviar_email: false });
    await api(tokAdmin, `/comercial/propostas/${prop.body.id}/status`, 'POST', { status: 'aceita' });
    const gc = await api(tokAdmin, `/comercial/oportunidades/${op.body.id}/gerar-contrato`, 'POST', {
      dia_vencimento: 12, data_inicio: hoje(),
      conector: { vagas: { abap: 3, funcional: 2 }, modalidade: pc.modalidade, ciclo: pc.ciclo, precos: { ...pc.precos, abap: 700 },
        gestor_email: `comprador-${sufixo}@teste.com`, gestor_nome: 'Comprador Teste' } });
    ok(gc.status === 201 && gc.body.contrato_conector_id, `gerar contrato cria o contrato do Conector (${gc.body?.mensagem || gc.body?.erro})`);
    const kp = (await pool.query('SELECT * FROM contratos_conector WHERE id = $1', [gc.body.contrato_conector_id])).rows[0];
    const vagasP = (await pool.query('SELECT perfil, COUNT(*)::int n FROM contratos_conector_vagas WHERE contrato_id = $1 AND ativo GROUP BY perfil', [kp.id])).rows;
    ok(kp.precos.abap === 700 && vagasP.find(v => v.perfil === 'abap').n === 3 && vagasP.find(v => v.perfil === 'funcional').n === 2,
      'licenças e preço da proposta no contrato');
    const cobP = await financeiro(kp.id);
    ok(cobP && cobP.id === gc.body.contrato_id && Number(cobP.valor) === (3 * 700 + 2 * pc.precos.funcional) * 12 && cobP.dia_vencimento === 12 && cobP.proposta_id === prop.body.id,
      `cobrança anual ligada à proposta (${cobP && cobP.valor})`);
    const opDepois = (await pool.query('SELECT etapa, contrato_id FROM oportunidades WHERE id = $1', [op.body.id])).rows[0];
    ok(opDepois.etapa === 'ganha' && opDepois.contrato_id === cobP.id, 'oportunidade ganha e ligada ao contrato');
    ok((await api(tokAdmin, `/comercial/oportunidades/${op.body.id}/gerar-contrato`, 'POST', { dia_vencimento: 10, data_inicio: hoje(),
      conector: { vagas: { abap: 1 } } })).status === 400, '! não gera duas vezes');
    await pool.query('DELETE FROM oportunidades WHERE id = $1', [op.body.id]).catch(() => {});


    // ===== Fase 2: contrato de cursos =====
    const aluno = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: cli, papel: 'aluno' });
    const tokAluno = tok({ id: aluno, tipo: 'cliente', cliente_id: cli });
    const meus = async () => ((await api(tokAluno, '/treinamentos/meus')).body || []).map(c => c.id);
    ok(!(await meus()).includes(curso), 'antes do contrato: aluno sem o curso');
    ok((await api(tok({ id: 1, tipo: 'tecnico' }), '/contratos-cursos')).status === 403, '! técnico não vê contratos de cursos');
    ok((await api(tokAdmin, '/contratos-cursos', 'POST', { cliente_id: cli, curso_ids: [], cobranca: 'cortesia' })).status === 400, '! recusa sem curso');
    ok((await api(tokAdmin, '/contratos-cursos', 'POST', { cliente_id: cli, curso_ids: [curso], cobranca: 'mensal' })).status === 400, '! recusa cobrança sem valor');

    // Contrato por pessoas: só quem está numa vaga vê os cursos (o resto da empresa não)
    const emailAluno = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [aluno])).rows[0].email;
    const outro = await usuarioTeste(pool, { tipo: 'cliente', cliente_id: cli });
    const tokOutro = tok({ id: outro, tipo: 'cliente', cliente_id: cli });
    const meusOutro = async () => ((await api(tokOutro, '/treinamentos/meus')).body || []).map(c => c.id);
    ok((await api(tokAdmin, '/contratos-cursos', 'POST', { cliente_id: cli, curso_ids: [curso], vagas: 1,
      pessoas: [{ email: 'a@x.com', nome: 'A' }, { email: 'b@x.com', nome: 'B' }] })).status === 400, '! recusa mais pessoas que vagas');
    const cort = await api(tokAdmin, '/contratos-cursos', 'POST', { cliente_id: cli, curso_ids: [curso], cobranca: 'cortesia', data_fim: maisDias(30),
      vagas: 2, pessoas: [{ email: emailAluno }] });
    ok(cort.status === 201 && !cort.body.contrato_financeiro_id && !cort.body.fatura_id, `cortesia sem cobrança (${cort.body?.mensagem || cort.body?.erro})`);
    ok((await meus()).includes(curso), 'pessoa colocada na vaga (já tinha acesso, mesmo sendo aluno de licença) vê o curso');
    ok(!(await meusOutro()).includes(curso), 'quem não está numa vaga NÃO vê o curso do contrato');
    let detV = (await api(tokAdmin, `/contratos-cursos/${cort.body.id}`)).body;
    ok(detV.total_vagas === 2 && detV.ocupadas === 1, 'contrato com 2 vagas, 1 ocupada');
    const vagaAluno = detV.vagas.find(v => v.usuario_id === aluno);
    ok((await api(tokAdmin, `/contratos-cursos/${cort.body.id}/convidar`, 'POST', { email: emailAluno })).status === 400, '! mesma pessoa em duas vagas');

    // Tela de Treinamentos (lista de empresas) não mexe no contrato
    await api(tokAdmin, `/treinamentos/cursos/${curso}/liberacoes`, 'PUT', { cliente_ids: [] });
    ok((await meus()).includes(curso), 'contrato de cursos não sai pela tela de Treinamentos');

    // Gestor da empresa no portal: vê o contrato e coloca pessoas nas vagas
    await pool.query('INSERT INTO clientes_admins (cliente_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cli, outro]);
    const meusContratos = (await api(tokOutro, '/contratos-cursos/meus')).body;
    ok(Array.isArray(meusContratos) && meusContratos.some(k => k.id === cort.body.id), 'gestor vê o contrato de cursos no portal');
    ok((await api(tokAluno, '/contratos-cursos/meus')).body.length === 0, 'quem não é gestor não vê o contrato');
    ok((await api(tokAluno, `/contratos-cursos/meus/${cort.body.id}/convidar`, 'POST', { eu: true })).status === 404, '! não gestor não convida');
    const euMesmo = await api(tokOutro, `/contratos-cursos/meus/${cort.body.id}/convidar`, 'POST', { eu: true });
    ok(euMesmo.status === 200 && (await meusOutro()).includes(curso), `gestor ocupa a última vaga e passa a ver o curso (${euMesmo.body?.mensagem || euMesmo.body?.erro})`);
    ok((await api(tokOutro, `/contratos-cursos/meus/${cort.body.id}/convidar`, 'POST', { nome: 'X', email: `x-${sufixo}@teste.com` })).status === 400,
      '! sem vaga livre');
    ok((await api(tokAdmin, `/contratos-cursos/${cort.body.id}`, 'PUT', { curso_ids: [curso], vagas: 1 })).status === 400, '! não diminui abaixo das ocupadas');

    // Liberar a vaga tira o curso só daquela pessoa
    ok((await api(tokOutro, `/contratos-cursos/meus/${cort.body.id}/vagas/${vagaAluno.id}/liberar`, 'POST')).status === 200, 'gestor libera a vaga');
    ok(!(await meus()).includes(curso) && (await meusOutro()).includes(curso), 'quem saiu perde o curso; quem ficou continua');
    const dir = (await pool.query(`SELECT status, motivo FROM direitos_acesso WHERE usuario_id = $1 AND curso_id = $2 AND origem = 'contrato'`, [aluno, curso])).rows[0];
    ok(dir && dir.status === 'revogado' && /liberada/.test(dir.motivo), `rastro do acesso registra a saída (${dir && dir.motivo})`);

    const unica = await api(tokAdmin, '/contratos-cursos', 'POST', { cliente_id: cli, curso_ids: [curso2], cobranca: 'unica', valor: 900 });
    const fatU = unica.body.fatura_id && (await pool.query('SELECT * FROM faturas WHERE id = $1', [unica.body.fatura_id])).rows[0];
    ok(unica.status === 201 && fatU && fatU.status === 'rascunho' && Number(fatU.valor) === 900, 'pagamento único = fatura avulsa em rascunho');

    const mensal = await api(tokAdmin, '/contratos-cursos', 'POST', { cliente_id: cli, curso_ids: [curso2], cobranca: 'mensal', valor: 250, dia_vencimento: 5 });
    const ctM = mensal.body.contrato_financeiro_id && (await pool.query('SELECT * FROM contratos WHERE id = $1', [mensal.body.contrato_financeiro_id])).rows[0];
    ok(mensal.status === 201 && ctM && ctM.periodicidade === 'mensal' && Number(ctM.valor) === 250 && ctM.contrato_cursos_id === mensal.body.id,
      'mensal = contrato financeiro ligado');

    // Editar: troca de curso e validade
    const ed = await api(tokAdmin, `/contratos-cursos/${cort.body.id}`, 'PUT', { curso_ids: [curso, curso2], data_fim: maisDias(60), vagas: 3 });
    const detC = (await api(tokAdmin, `/contratos-cursos/${cort.body.id}`)).body;
    ok(ed.status === 200 && detC.cursos.length === 2 && detC.data_fim === maisDias(60) && detC.total_vagas === 3, 'edita cursos, validade e vagas');
    ok((await meusOutro()).includes(curso2), 'curso acrescentado ao contrato aparece para quem está na vaga');

    const ficha = (await api(tokAdmin, `/clientes/${cli}/ficha`)).body;
    ok(Array.isArray(ficha.contratos_cursos) && ficha.contratos_cursos.length === 3, 'ficha do cliente lista os contratos de cursos');

    // Encerrar: cursos saem, cobrança recorrente para
    for (const id of [cort.body.id, unica.body.id, mensal.body.id]) await api(tokAdmin, `/contratos-cursos/${id}/encerrar`, 'POST');
    ok(!(await meusOutro()).includes(curso) && !(await meusOutro()).includes(curso2), 'encerrar tira os cursos de quem estava nas vagas');
    ok((await pool.query('SELECT status FROM contratos WHERE id = $1', [ctM.id])).rows[0].status === 'encerrado', 'encerrar para a cobrança mensal');
    ok((await api(tokAdmin, `/contratos-cursos/${cort.body.id}/encerrar`, 'POST')).status === 400, '! não encerra duas vezes');
  } finally {
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(u => u.id);
    await pool.query('DELETE FROM direitos_acesso WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM matriculas WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_liberacoes WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM faturas WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM oportunidades WHERE cliente_id = $1', [cli]).catch(err => console.log('(oportunidade de teste ficou:', err.message, ')'));
    await pool.query('DELETE FROM contratos_cursos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id IN (SELECT id FROM contratos_conector WHERE cliente_id = $1)', [cli]);
    await pool.query('DELETE FROM contratos_conector WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM clientes_admins WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]).catch(() => {});
    await apagarUsuariosTeste(pool);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]).catch(() => {});
    await pool.query('DELETE FROM cursos WHERE id = ANY($1)', [[curso, curso2]]).catch(() => {});
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]).catch(err => console.log('(cliente de teste ficou:', err.message, ')'));
    await pool.end();
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
