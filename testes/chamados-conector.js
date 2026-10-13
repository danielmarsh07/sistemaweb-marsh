require('./_ambiente-local');
// Chamados abertos pelo Conector SAP (ferramenta abrir_chamado): rotas públicas /api/licencas-conector/chamados
// e /chamados/listar (autenticação pela chave + máquina ativada), aprovação do gestor do cliente no portal,
// especificacao.md, fila da fábrica ABAP e regressão dos chamados antigos (origem NULL).
// Atenção: as rotas do conector têm limite de 60 requisições/minuto por IP — este teste usa ~35;
// rodar logo depois do licencas-ativacao.js pode dar 429 "Muitas requisições" (espere 1 minuto).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const BASE = 'http://localhost:3000/api';

const ok = (c, msg) => console.log(c ? 'OK  ' : 'FAIL', msg);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const sufixo = Date.now();
  const novoCliente = async nome => (await pool.query(
    `INSERT INTO clientes (nome, razao_social, email, empresa_id, ativo) VALUES ($1, $2, $3, 1, TRUE) RETURNING id`,
    [`TESTE ${nome}`, `TESTE CONECTOR ${nome} LTDA`, `cc-${nome.toLowerCase()}-${sufixo}@exemplo.com`])).rows[0].id;
  const cliA = await novoCliente('A');
  const cliB = await novoCliente('B');
  const novoUsuario = async (nome, tipo, cliente_id) => (await pool.query(
    `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo)
     VALUES ($1, $2, 'x', 1, $3, $4, TRUE) RETURNING id`,
    [nome, `cc-${nome.toLowerCase().replace(/\s+/g, '-')}-${sufixo}@exemplo.com`, tipo, cliente_id])).rows[0].id;
  const uGestorA = await novoUsuario('Gestor A Teste', 'cliente', cliA);
  const uGestorB = await novoUsuario('Gestor B Teste', 'cliente', cliB);
  const uAdmin = await novoUsuario('Admin Conector Teste', 'admin_empresa', null);
  const usuariosIds = [uGestorA, uGestorB, uAdmin];

  const assinar = p => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '10m' });
  const tokAdmin = assinar({ id: uAdmin, tipo: 'admin_empresa', empresa_id: 1, nome: 'Admin Conector Teste' });
  const tokTecnico = assinar({ id: uAdmin, tipo: 'tecnico', empresa_id: 1 });
  const tokCliA = assinar({ id: uGestorA, tipo: 'cliente', empresa_id: 1, cliente_id: cliA, nome: 'Gestor A Teste' });
  const tokCliB = assinar({ id: uGestorB, tipo: 'cliente', empresa_id: 1, cliente_id: cliB, nome: 'Gestor B Teste' });

  let chamadasConector = 0;
  const api = async (tok, p, m = 'GET', body, cru = false) => {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const r = await fetch(BASE + p, { method: m, headers, body: body && JSON.stringify(body) });
    if (cru) return { status: r.status, headers: r.headers, texto: await r.text() };
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const conector = (p, body) => { chamadasConector++; return api(null, `/licencas-conector${p}`, 'POST', body); };

  try {
    const fim = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    // Licença A exige aprovação (padrão); licença B não exige
    const lA = await api(tokAdmin, '/licencas', 'POST', { cliente_id: cliA, plano: 'leitura', sids: 'DEV, QAS', data_fim: fim });
    const lB = await api(tokAdmin, '/licencas', 'POST', {
      cliente_id: cliB, plano: 'desenvolvimento', sids: 'DEV', data_fim: fim, chamados_exigem_aprovacao: false });
    ok(lA.status === 201 && lB.status === 201, `admin cria as licenças A (padrão) e B (sem aprovação) (${lA.status}/${lB.status})`);
    const licA = lA.body.id, licB = lB.body.id, chaveA = lA.body.chave, chaveB = lB.body.chave;

    const lista = (await api(tokAdmin, '/licencas')).body || [];
    ok(lista.find(l => l.id === licA)?.chamados_exigem_aprovacao === true &&
       lista.find(l => l.id === licB)?.chamados_exigem_aprovacao === false,
      'GET /licencas devolve chamados_exigem_aprovacao (A=true padrão, B=false)');
    ok((await api(tokAdmin, `/licencas/${licA}`, 'PUT', { chamados_exigem_aprovacao: 'sim' })).status === 400,
      '! PUT recusa chamados_exigem_aprovacao não-booleano');

    const M = [1, 2, 3, 4].map(i => hash(`cc-maquina-${sufixo}-${i}`));
    const U1 = hash(`cc-usuario-${sufixo}-1`), U2 = hash(`cc-usuario-${sufixo}-2`);
    for (const [chave, mh, nome] of [[chaveA, M[0], 'NB-FUNC-1'], [chaveA, M[1], 'NB-FUNC-2'], [chaveB, M[2], 'NB-B-1']]) {
      const a = await conector('/ativar', { chave, maquina_hash: mh, nome_maquina: nome, versao: '1.1.0' });
      if (a.status !== 200) throw new Error(`ativar ${nome}: ${a.status} ${JSON.stringify(a.body)}`);
    }

    const espec = '# Ajuste no ZSDR0099\n\n## Contexto\nO relatório **não** mostra o CFOP.\n\n| Campo | Origem |\n|---|---|\n| CFOP | J_1BNFLIN-CFOP |\n\n```abap\nSELECT * FROM j_1bnflin INTO TABLE @DATA(lt).\n```\n\n- item 1\n- item <script>alert(1)</script>\n';
    const base = {
      chave: chaveA, sid: 'dev', usuario_hash: U1, maquina_hash: M[0], nome_maquina: 'NB-FUNC-1', versao: '1.1.0',
      titulo: 'Incluir CFOP no relatório ZSDR0099', tipo: 'melhoria', modulo: 'sd', prioridade: 'alta',
      pedido: 'Preciso ver o CFOP de cada item no ZSDR0099.', especificacao: espec,
      objetos: [{ tipo: 'PROG', nome: 'ZSDR0099' }, { tipo: 'clas', nome: 'zcl_nfe_danfe' }],
      solicitante_nome: 'Fulana Funcional', solicitante_email: 'fulana@cliente.com.br'
    };

    // --- Abrir: com aprovação exigida ---
    const c1 = await conector('/chamados', base);
    ok(c1.status === 201 && c1.body?.numero === `#${c1.body?.id}` && c1.body?.status === 'aberto' &&
       c1.body?.aprovacao_cliente === 'pendente' && /aprova/i.test(c1.body?.mensagem || ''),
      `abrir chamado (licença exige aprovação) -> 201 pendente (${c1.status} ${c1.body?.mensagem || c1.body?.erro})`);
    const id1 = c1.body.id;
    const g1 = (await pool.query('SELECT * FROM chamados WHERE id = $1', [id1])).rows[0];
    ok(g1.origem === 'conector' && g1.categoria === 'Conector SAP' && g1.cliente_id === cliA && g1.licenca_id === licA &&
       g1.aberto_por_usuario_id === null && g1.sid === 'DEV' && g1.modulo === 'SD' && g1.tipo_demanda === 'melhoria' &&
       g1.prioridade === 'alta' && g1.usuario_hash === U1 && g1.maquina_hash === M[0],
      'chamado gravado: origem/categoria/cliente/licença/SID/módulo/tipo/prioridade/hashes');
    ok(g1.objetos_sap.map(o => `${o.tipo} ${o.nome}`).join(',') === 'PROG ZSDR0099,CLAS ZCL_NFE_DANFE',
      `objetos normalizados em maiúsculas (${JSON.stringify(g1.objetos_sap)})`);
    ok(g1.descricao.startsWith(base.pedido) && g1.descricao.includes('Especificação anexa ao chamado (Conector SAP, sistema DEV)') &&
       g1.especificacao === espec.trim() && g1.pedido_original === base.pedido,
      'descricao curta (pedido + aviso da especificação) e textos completos nas colunas novas');
    const log1 = (await pool.query('SELECT * FROM chamados_status_log WHERE chamado_id = $1', [id1])).rows;
    ok(log1.length === 1 && log1[0].status_novo === 'aberto' &&
       log1[0].observacao.startsWith('Chamado aberto pelo Conector SAP (NB-FUNC-1, DEV) por Fulana Funcional'),
      `status log da abertura (${log1[0]?.observacao})`);

    // Segundo chamado do mesmo cliente, outro usuário/máquina (para listar "só os meus")
    const c2 = await conector('/chamados', { ...base, usuario_hash: U2, maquina_hash: M[1], nome_maquina: undefined,
      titulo: 'Corrigir dump na ZMIRO', tipo: 'erro', modulo: 'MM', prioridade: undefined, objetos: undefined, solicitante_email: '' });
    ok(c2.status === 201 && c2.body.aprovacao_cliente === 'pendente', `segundo chamado (outro usuário/máquina) -> 201 (${c2.status})`);
    const id2 = c2.body.id;
    const g2 = (await pool.query('SELECT prioridade, objetos_sap, solicitante_email FROM chamados WHERE id = $1', [id2])).rows[0];
    ok(g2.prioridade === 'media' && Array.isArray(g2.objetos_sap) && g2.objetos_sap.length === 0 && g2.solicitante_email === null,
      'prioridade padrão media, objetos opcionais, e-mail opcional');
    const log2 = (await pool.query('SELECT observacao FROM chamados_status_log WHERE chamado_id = $1', [id2])).rows[0];
    ok(/\(NB-FUNC-2, DEV\)/.test(log2.observacao), `sem nome_maquina no corpo usa o nome da ativação (${log2.observacao})`);

    // Dúvida sem especificação
    const c3 = await conector('/chamados', { ...base, titulo: 'Dúvida sobre a BAPI de estorno', tipo: 'duvida', modulo: 'FI', especificacao: '' });
    ok(c3.status === 201, `tipo duvida sem especificação -> 201 (${c3.status} ${c3.body?.erro || ''})`);
    const id3 = c3.body.id;

    // --- Abrir: licença que NÃO exige aprovação, especificação grande (150 mil caracteres, com acentos) ---
    const grande = '## Especificação técnica\n' + 'Ação: validação de CFOP e alíquota. '.repeat(4200);
    const c4 = await conector('/chamados', { ...base, chave: chaveB, maquina_hash: M[2], nome_maquina: 'NB-B-1',
      titulo: 'Nova rotina de conciliação', tipo: 'nova_funcionalidade', modulo: 'FISCAL', especificacao: grande.slice(0, 150000) });
    ok(c4.status === 201 && c4.body.aprovacao_cliente === 'aprovado' && /liberado/i.test(c4.body.mensagem),
      `licença sem aprovação -> 201 já aprovado, especificação de 150 mil caracteres aceita (${c4.status} ${c4.body?.erro || ''})`);
    const id4 = c4.body.id;

    // --- Recusas de autenticação (403 { erro, motivo }) ---
    const recusa = async (nome, corpo, motivo) => {
      const r = await conector('/chamados', corpo);
      ok(r.status === 403 && r.body?.motivo === motivo && r.body?.erro,
        `! ${nome} -> 403 ${motivo} (${r.status} ${r.body?.motivo} ${r.body?.erro || ''})`);
    };
    await recusa('chave inexistente', { ...base, chave: 'MRSH-AAAA-BBBB-CCCC' }, 'chave');
    await pool.query(`UPDATE licencas SET status = 'suspensa' WHERE id = $1`, [licA]);
    await recusa('licença suspensa', base, 'suspensa');
    await pool.query(`UPDATE licencas SET status = 'ativa', data_fim = CURRENT_DATE - 1 WHERE id = $1`, [licA]);
    await recusa('licença vencida', base, 'vencida');
    await pool.query(`UPDATE licencas SET data_fim = $2 WHERE id = $1`, [licA, fim]);
    await recusa('SID fora da licença', { ...base, sid: 'PRD' }, 'sid');
    await recusa('máquina não ativada', { ...base, maquina_hash: M[3] }, 'maquina');
    await recusa('máquina de outra licença', { ...base, maquina_hash: M[2] }, 'maquina');
    const mNao = await conector('/chamados', { ...base, maquina_hash: M[3] });
    ok(mNao.body?.erro === 'Máquina não ativada nesta licença. Rode o instalador.', `mensagem da máquina não ativada (${mNao.body?.erro})`);
    ok(!(await pool.query('SELECT 1 FROM licencas_ativacoes WHERE maquina_hash = $1', [M[3]])).rows.length,
      'abrir chamado NÃO ativa máquina nova');
    await pool.query(`UPDATE licencas_ativacoes SET revogada = TRUE, revogada_em = NOW() WHERE licenca_id = $1 AND maquina_hash = $2`, [licA, M[1]]);
    await recusa('máquina revogada', { ...base, maquina_hash: M[1] }, 'maquina_revogada');

    // --- Campos inválidos (400) ---
    const invalidos = [
      ['usuario_hash inválido', { usuario_hash: 'abc' }],
      ['maquina_hash ausente', { maquina_hash: undefined }],
      ['sid ausente', { sid: '' }],
      ['título curto', { titulo: 'Oi' }],
      ['título com 201 caracteres', { titulo: 'x'.repeat(201) }],
      ['tipo inválido', { tipo: 'projeto' }],
      ['módulo inválido', { modulo: 'XX' }],
      ['prioridade inválida', { prioridade: 'urgente' }],
      ['pedido vazio', { pedido: '  ' }],
      ['pedido com 20.001 caracteres', { pedido: 'p'.repeat(20001) }],
      ['melhoria sem especificação', { especificacao: '' }],
      ['especificação com 200.001 caracteres', { especificacao: 'e'.repeat(200001) }],
      ['especificação não-texto', { especificacao: { a: 1 } }],
      ['objetos não-lista', { objetos: 'ZSDR0099' }],
      ['101 objetos', { objetos: Array.from({ length: 101 }, (_, i) => ({ tipo: 'PROG', nome: `Z${i}` })) }],
      ['objeto com caractere inválido', { objetos: [{ tipo: 'PROG', nome: 'ZSD-0099' }] }],
      ['objeto com tipo de 11 caracteres', { objetos: [{ tipo: 'PROGRAMAABC', nome: 'ZSDR0099' }] }],
      ['objeto com nome de 61 caracteres', { objetos: [{ tipo: 'PROG', nome: 'Z'.repeat(61) }] }],
      ['solicitante_nome vazio', { solicitante_nome: '' }],
      ['solicitante_email inválido', { solicitante_email: 'fulana@' }]
    ];
    for (const [nome, extra] of invalidos) {
      const r = await conector('/chamados', { ...base, ...extra });
      ok(r.status === 400 && typeof r.body?.erro === 'string', `! ${nome} -> 400 (${r.status} ${r.body?.erro || ''})`);
    }

    // --- Limite de 20 por hora por licença ---
    const jaNaHora = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM chamados WHERE licenca_id = $1 AND origem = 'conector' AND data_criacao >= NOW() - INTERVAL '1 hour'`,
      [licA])).rows[0].n;
    const extras = (await pool.query(
      `INSERT INTO chamados (empresa_id, cliente_id, titulo, status, origem, licenca_id, ativo)
       SELECT 1, $1, 'TESTE limite', 'aberto', 'conector', $2, FALSE FROM generate_series(1, $3) RETURNING id`,
      [cliA, licA, 20 - jaNaHora])).rows.map(r => r.id);
    const lim = await conector('/chamados', base);
    ok(lim.status === 429 && /20 chamados por hora/.test(lim.body?.erro || ''), `! 21º chamado na hora -> 429 (${lim.status} ${lim.body?.erro || ''})`);
    await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [extras]);

    // --- Listar ---
    const meus = await conector('/chamados/listar', { chave: chaveA, usuario_hash: U1, maquina_hash: M[0] });
    const idsMeus = (meus.body || []).map(c => c.id);
    ok(meus.status === 200 && Array.isArray(meus.body) && idsMeus.includes(id1) && idsMeus.includes(id3) && !idsMeus.includes(id2),
      `listar: só os do usuário (${idsMeus.join(',')})`);
    const item = (meus.body || []).find(c => c.id === id1) || {};
    const campos = ['id', 'numero', 'titulo', 'status', 'aprovacao_cliente', 'prioridade', 'modulo', 'sid', 'data_abertura', 'ultima_atualizacao', 'ultimo_comentario'];
    ok(campos.every(k => k in item) && Object.keys(item).length === campos.length && item.numero === `#${id1}` &&
       item.aprovacao_cliente === 'pendente' && item.ultimo_comentario === null,
      `listar: campos do contrato, sem hash nem especificação (${Object.keys(item).join(',')})`);
    const todos = await conector('/chamados/listar', { chave: chaveA, usuario_hash: U1, maquina_hash: M[0], todos: true });
    const idsTodos = (todos.body || []).map(c => c.id);
    ok(todos.status === 200 && idsTodos.includes(id1) && idsTodos.includes(id2) && !idsTodos.includes(id4),
      `listar todos: chamados da licença, não os de outra licença (${idsTodos.join(',')})`);
    const lRev = await conector('/chamados/listar', { chave: chaveA, usuario_hash: U2, maquina_hash: M[1] });
    ok(lRev.status === 403 && lRev.body?.motivo === 'maquina_revogada', `! listar com máquina revogada -> 403 (${lRev.body?.motivo})`);

    // --- Painel: lista, detalhe, SLA ---
    const pend = await api(tokAdmin, `/chamados?origem=conector&aprovacao=pendente&cliente_id=${cliA}`);
    const pIds = (pend.body?.chamados || []).map(c => c.id);
    ok(pend.status === 200 && pIds.includes(id1) && pIds.includes(id2) && !pIds.includes(id4),
      `GET /chamados?origem=conector&aprovacao=pendente (${pIds.join(',')})`);
    const linha = (pend.body?.chamados || []).find(c => c.id === id1) || {};
    ok(linha.origem === 'conector' && !('especificacao' in linha) && !('pedido_original' in linha) && !('usuario_hash' in linha),
      'lista não traz especificação, pedido nem hashes');
    ok(linha.sla === null, 'chamado aguardando aprovação não conta SLA (sla = null)');
    const dAdm = (await api(tokAdmin, `/chamados/${id1}`)).body || {};
    ok(dAdm.especificacao === espec.trim() && dAdm.usuario_hash === U1 && dAdm.maquina_nome === 'NB-FUNC-1',
      'detalhe (admin) traz especificação, hash e nome da máquina');
    const dCli = await api(tokCliA, `/chamados/${id1}`);
    ok(dCli.status === 200 && dCli.body.especificacao === espec.trim() && !('usuario_hash' in dCli.body) &&
       !('maquina_hash' in dCli.body) && !('licenca_id' in dCli.body), 'detalhe (cliente dono) sem hashes nem licença');
    ok((await api(tokCliB, `/chamados/${id1}`)).status === 404, '! cliente de outra empresa não vê o chamado (404)');

    // --- Aprovação ---
    ok((await api(tokCliB, `/chamados/${id1}/aprovacao`, 'POST', { decisao: 'aprovado' })).status === 403,
      '! cliente de outra empresa aprova -> 403');
    ok((await api(tokTecnico, `/chamados/${id1}/aprovacao`, 'POST', { decisao: 'aprovado' })).status === 403,
      '! técnico aprova -> 403');
    ok((await api(tokCliA, `/chamados/${id1}/aprovacao`, 'POST', { decisao: 'talvez' })).status === 400,
      '! decisao inválida -> 400');
    ok((await api(tokCliA, `/chamados/${id2}/aprovacao`, 'POST', { decisao: 'recusado', comentario: ' ' })).status === 400,
      '! recusar sem comentário -> 400');
    const ap = await api(tokCliA, `/chamados/${id1}/aprovacao`, 'POST', { decisao: 'aprovado', comentario: 'Pode seguir.' });
    ok(ap.status === 200 && ap.body.chamado?.aprovacao_cliente === 'aprovado' && ap.body.chamado.status === 'aberto',
      `gestor do cliente aprova -> 200 aprovado (${ap.status} ${ap.body?.erro || ''})`);
    const g1b = (await pool.query('SELECT aprovado_por_usuario_id, data_aprovacao FROM chamados WHERE id = $1', [id1])).rows[0];
    ok(g1b.aprovado_por_usuario_id === uGestorA && g1b.data_aprovacao, 'grava quem aprovou e quando');
    const at1 = (await pool.query(`SELECT tipo, descricao, usuario_id FROM atendimentos WHERE chamado_id = $1`, [id1])).rows;
    ok(at1.length === 1 && at1[0].tipo === 'aprovacao' && at1[0].usuario_id === uGestorA &&
       at1[0].descricao.includes('pelo gestor do cliente (Gestor A Teste)') && at1[0].descricao.includes('Pode seguir.'),
      `timeline registra a aprovação (${at1[0]?.descricao?.split('\n')[0]})`);
    const log1b = (await pool.query(`SELECT observacao FROM chamados_status_log WHERE chamado_id = $1 ORDER BY id DESC LIMIT 1`, [id1])).rows[0];
    ok(/^Aprovado pelo gestor do cliente/.test(log1b.observacao), `status log da aprovação (${log1b.observacao})`);
    const dup = await api(tokCliA, `/chamados/${id1}/aprovacao`, 'POST', { decisao: 'recusado', comentario: 'mudei de ideia' });
    ok(dup.status === 409, `! aprovação dupla -> 409 (${dup.status})`);
    const dAprov = (await api(tokAdmin, `/chamados/${id1}`)).body || {};
    ok(dAprov.sla && dAprov.sla.sla_status === 'ok' && dAprov.aprovado_por_nome === 'Gestor A Teste',
      `aprovado: SLA conta a partir da aprovação (${dAprov.sla?.sla_status}) e detalhe traz quem aprovou`);

    const rc = await api(tokCliA, `/chamados/${id2}/aprovacao`, 'POST', { decisao: 'recusado', comentario: 'Não é prioridade agora.' });
    const g2b = (await pool.query('SELECT status, aprovacao_cliente, data_fechamento FROM chamados WHERE id = $1', [id2])).rows[0];
    ok(rc.status === 200 && g2b.status === 'fechado' && g2b.aprovacao_cliente === 'recusado' && g2b.data_fechamento,
      `recusa fecha o chamado (${rc.status} ${g2b.status}/${g2b.aprovacao_cliente})`);
    const at2 = (await pool.query(`SELECT tipo, descricao FROM atendimentos WHERE chamado_id = $1`, [id2])).rows[0];
    const log2b = (await pool.query(`SELECT status_anterior, status_novo, observacao FROM chamados_status_log WHERE chamado_id = $1 ORDER BY id DESC LIMIT 1`, [id2])).rows[0];
    ok(at2?.tipo === 'recusa' && at2.descricao.includes('Não é prioridade agora.') &&
       log2b.status_anterior === 'aberto' && log2b.status_novo === 'fechado' && log2b.observacao.includes('Não é prioridade agora.'),
      'recusa na timeline e no status log com o comentário');

    const apAdm = await api(tokAdmin, `/chamados/${id3}/aprovacao`, 'POST', { decisao: 'aprovado' });
    const at3 = (await pool.query(`SELECT descricao FROM atendimentos WHERE chamado_id = $1`, [id3])).rows[0];
    ok(apAdm.status === 200 && /pela Marsh em nome do cliente \(Admin Conector Teste\)/.test(at3?.descricao || ''),
      `admin aprova em nome do cliente, registrando que foi a Marsh (${at3?.descricao})`);
    ok((await api(tokCliB, `/chamados/${id4}/aprovacao`, 'POST', { decisao: 'aprovado' })).status === 409,
      '! aprovar chamado que já entrou aprovado -> 409');

    const meus2 = await conector('/chamados/listar', { chave: chaveA, usuario_hash: U1, maquina_hash: M[0] });
    const it1 = (meus2.body || []).find(c => c.id === id1) || {};
    ok(it1.aprovacao_cliente === 'aprovado' && /Pode seguir\./.test(it1.ultimo_comentario || '') &&
       new Date(it1.ultima_atualizacao) >= new Date(it1.data_abertura),
      'listar reflete aprovação, último comentário e última atualização');

    // --- especificacao.md ---
    const md = await api(tokAdmin, `/chamados/${id1}/especificacao.md`, 'GET', null, true);
    const disp = md.headers.get('content-disposition') || '';
    ok(md.status === 200 && /text\/markdown/.test(md.headers.get('content-type') || '') &&
       disp === `attachment; filename="chamado-${id1}-incluir-cfop-no-relatorio-zsdr0099.md"`,
      `especificacao.md: download com nome do arquivo (${disp})`);
    const t = md.texto;
    ok(t.startsWith(`# Chamado #${id1} — Incluir CFOP no relatório ZSDR0099`) && t.includes('| Cliente | TESTE CONECTOR A LTDA |') &&
       t.includes('| Sistema SAP (SID) | DEV |') && t.includes('| Módulo | SD |') && t.includes('| Tipo | Melhoria |') &&
       t.includes('| Prioridade | Alta |') && t.includes('| Solicitante | Fulana Funcional <fulana@cliente.com.br> |') &&
       t.includes('| Aberto em |') && /\| Aprovação do cliente \| Aprovado \(Gestor A Teste, /.test(t),
      'especificacao.md: cabeçalho com cliente, SID, módulo, tipo, prioridade, solicitante, data e aprovação');
    ok(t.includes('## Objetos SAP') && t.includes('- PROG `ZSDR0099`') && t.includes('## Pedido original\n\nPreciso ver o CFOP') &&
       t.includes('## Especificação\n\n# Ajuste no ZSDR0099'), 'especificacao.md: objetos, pedido original e especificação');
    ok((await api(tokCliA, `/chamados/${id1}/especificacao.md`, 'GET', null, true)).status === 200, 'especificacao.md: cliente dono baixa');
    ok((await api(tokCliB, `/chamados/${id1}/especificacao.md`, 'GET', null, true)).status === 404, '! especificacao.md: cliente de outra empresa -> 404');
    const md3 = await api(tokAdmin, `/chamados/${id3}/especificacao.md`, 'GET', null, true);
    ok(md3.status === 200 && md3.texto.includes('Nenhum objeto') === false && md3.texto.includes('_Sem especificação (dúvida)._'),
      'especificacao.md de dúvida sem especificação');

    // --- Fila da fábrica ABAP ---
    const fila = await api(tokAdmin, '/chamados/fila-conector');
    const fIds = (fila.body || []).map(c => c.id);
    ok(fila.status === 200 && fIds.includes(id1) && fIds.includes(id3) && fIds.includes(id4) && !fIds.includes(id2),
      `fila-conector: só aprovados e em aberto (${fIds.filter(i => [id1, id2, id3, id4].includes(i)).join(',')})`);
    const nossos = fIds.filter(i => [id1, id3, id4].includes(i));
    ok(JSON.stringify(nossos) === JSON.stringify([id1, id3, id4]), 'fila-conector: mais antigos primeiro');
    const f1 = (fila.body || []).find(c => c.id === id1) || {};
    ok(f1.especificacao === espec.trim() && f1.cliente_nome === 'TESTE CONECTOR A LTDA' && f1.aprovado_por_nome === 'Gestor A Teste',
      'fila-conector traz especificação, cliente e quem aprovou');
    await pool.query(`UPDATE chamados SET status = 'resolvido' WHERE id = $1`, [id4]);
    ok(!((await api(tokAdmin, '/chamados/fila-conector')).body || []).some(c => c.id === id4), 'fila-conector: resolvido sai da fila');
    ok((await api(tokCliA, '/chamados/fila-conector')).status === 403, '! fila-conector para cliente -> 403');
    ok((await api(tokTecnico, '/chamados/fila-conector')).status === 200, 'fila-conector para técnico -> 200');

    // --- Chamados antigos (origem NULL) continuam funcionando ---
    const antigo = await api(tokCliA, '/chamados', 'POST', { titulo: 'TESTE chamado pelo portal', descricao: 'Sem conector', prioridade: 'baixa' });
    const idA = antigo.body?.chamado?.id;
    ok(antigo.status === 201 && antigo.body.chamado.origem === null && antigo.body.chamado.aprovacao_cliente === null,
      `chamado pelo portal: 201 com origem NULL (${antigo.status})`);
    const dA = (await api(tokCliA, `/chamados/${idA}`)).body || {};
    ok(dA.sla && dA.sla.sla_status === 'ok' && dA.status === 'aberto', 'chamado antigo: detalhe e SLA como antes');
    const man = await api(tokAdmin, `/chamados?origem=manual&cliente_id=${cliA}`);
    const mIds = (man.body?.chamados || []).map(c => c.id);
    ok(mIds.includes(idA) && !mIds.includes(id1), `filtro origem=manual (${mIds.join(',')})`);
    const semFiltro = await api(tokCliA, '/chamados?limit=200');
    const sIds = (semFiltro.body?.chamados || []).map(c => c.id);
    ok([idA, id1, id2, id3].every(i => sIds.includes(i)), 'portal: lista normal traz chamados do portal e do conector');
    const put = await api(tokAdmin, `/chamados/${idA}`, 'PUT', { status: 'em_andamento' });
    const at = await api(tokAdmin, '/atendimentos', 'POST', { chamado_id: idA, tipo: 'comentario', descricao: 'Olhando.' });
    ok(put.status === 200 && at.status === 201, 'chamado antigo: editar status e comentar como antes');
    ok((await api(tokCliA, `/chamados/${idA}/aprovacao`, 'POST', { decisao: 'aprovado' })).status === 409,
      '! aprovar chamado que não é do conector -> 409');
    ok((await api(tokAdmin, `/chamados/${idA}/especificacao.md`, 'GET', null, true)).status === 404,
      '! especificacao.md de chamado que não é do conector -> 404');

    console.log(`(chamadas às rotas do conector: ${chamadasConector})`);
  } finally {
    const ids = (await pool.query('SELECT id FROM chamados WHERE cliente_id IN ($1, $2)', [cliA, cliB])).rows.map(r => r.id);
    if (ids.length) {
      await pool.query('DELETE FROM atendimentos_lidos WHERE atendimento_id IN (SELECT id FROM atendimentos WHERE chamado_id = ANY($1))', [ids]);
      await pool.query('DELETE FROM atendimentos WHERE chamado_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM chamados_status_log WHERE chamado_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM chamados WHERE id = ANY($1)', [ids]);
    }
    const lics = (await pool.query('SELECT id FROM licencas WHERE cliente_id IN ($1, $2)', [cliA, cliB])).rows.map(r => r.id);
    if (lics.length) {
      await pool.query('DELETE FROM licencas_ativacoes WHERE licenca_id = ANY($1)', [lics]);
      await pool.query('DELETE FROM licencas_uso WHERE licenca_id = ANY($1)', [lics]);
      await pool.query('DELETE FROM licencas WHERE id = ANY($1)', [lics]);
    }
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [usuariosIds]);
    await pool.query('DELETE FROM clientes WHERE id IN ($1, $2)', [cliA, cliB]);
    await pool.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
