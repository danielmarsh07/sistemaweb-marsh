require('./_ambiente-local');
// Fluxo novo — fase 5 (docs/plano-fluxo-novo.md): inadimplência, renovação e registro de e-mails.
// Decisão do dono: fatura vencida gera alerta; com 30 dias de atraso as licenças do Conector (e os cursos inclusos)
// ficam suspensas e voltam sozinhas quando a fatura é paga. Renovação: avisos 30/7/1 dia e +12 meses (ou encerra).
const jwt = require('jsonwebtoken');
const pool = require('../backend/db');
const vigencia = require('../backend/services/vigencia');
const cc = require('../backend/services/contratos-conector');
const acessos = require('../backend/services/acessos');
const BASE = 'http://localhost:3000/api';

let falhas = 0;
const ok = (c, msg) => { if (!c) falhas++; console.log(c ? 'OK  ' : 'FAIL', msg); };
const tok = p => jwt.sign({ empresa_id: 1, ...p }, process.env.JWT_SECRET, { expiresIn: '10m' });
const tokAdmin = tok({ id: 1, tipo: 'admin_empresa', nome: 'Admin' });
const api = async (t, p, m = 'GET', body) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const dia = n => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

(async () => {
  const sufixo = Date.now();
  const cli = (await pool.query(`INSERT INTO clientes (nome, empresa_id, ativo) VALUES ($1, 1, TRUE) RETURNING id`, [`TESTE F5 ${sufixo}`])).rows[0].id;
  const curso = (await pool.query(`INSERT INTO cursos (empresa_id, titulo, status, trilha, ordem) VALUES (1, $1, 'publicado', 'abap', 995) RETURNING id`, [`TESTE F5 curso ${sufixo}`])).rows[0].id;
  await pool.query(`INSERT INTO cursos_aulas (curso_id, titulo, ordem) VALUES ($1, 'Aula', 0)`, [curso]);
  await acessos.incluirNoBeneficioPelaTrilha(curso, 'abap');
  const alertaAntes = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM alertas_sistema')).rows[0].m;
  const emailAntes = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM emails_enviados')).rows[0].m;
  let kid, ctId, fid;
  try {
    // Contrato do Conector com cobrança anual e um usuário com licença ativa
    const k = await api(tokAdmin, '/contratos-conector', 'POST', { cliente_id: cli, gestor_nome: 'Admin F5', gestor_email: `adm-f5-${sufixo}@teste.com`,
      vagas: { abap: 1 }, data_fim: dia(365), cobranca: { gerar: true, valor_anual: 1200 } });
    kid = k.body.id; ctId = k.body.contrato_financeiro_id;
    ok((await pool.query('SELECT renovacao_automatica FROM contratos WHERE id = $1', [ctId])).rows[0].renovacao_automatica, 'cobrança das licenças nasce com renovação automática');
    const admin = (await pool.query('SELECT id FROM usuarios WHERE email = $1', [`adm-f5-${sufixo}@teste.com`])).rows[0];
    const conv = await api(tok({ id: admin.id, tipo: 'cliente', cliente_id: cli }), `/contratos-conector/meus/${kid}/convidar`, 'POST', { perfil: 'abap', nome: 'Ana', email: `ana-f5-${sufixo}@teste.com` });
    const ana = (await pool.query('SELECT id FROM usuarios WHERE email = $1', [`ana-f5-${sufixo}@teste.com`])).rows[0];
    await cc.ativarConvites(ana.id);
    const tokAna = tok({ id: ana.id, tipo: 'cliente', cliente_id: cli });
    const temCurso = async () => ((await api(tokAna, '/treinamentos/meus')).body || []).some(c => c.id === curso);
    ok(conv.status === 200 && await temCurso(), 'Ana usa a licença e o curso incluso');

    // --- Fatura vencida há 5 dias: alerta, sem suspensão ---
    fid = (await pool.query(
      `INSERT INTO faturas (empresa_id, cliente_id, contrato_id, competencia, descricao, valor, data_vencimento, status, emitir_nfse)
       VALUES (1, $1, $2, date_trunc('month', CURRENT_DATE)::date, 'Anuidade F5', 1200, $3, 'aberta', FALSE) RETURNING id`, [cli, ctId, dia(-5)])).rows[0].id;
    await vigencia.alertarVencidas();
    await vigencia.alertarVencidas();
    const al = (await pool.query(`SELECT * FROM alertas_sistema WHERE chave = $1`, [`inadimplencia:fatura:${fid}`])).rows;
    ok(al.length === 1 && al[0].ocorrencias === 1 && /serão suspensas/.test(al[0].detalhe), 'fatura vencida gera um alerta só, avisando da suspensão');
    await vigencia.suspenderInadimplentes();
    ok((await pool.query('SELECT status FROM contratos_conector WHERE id = $1', [kid])).rows[0].status === 'ativo' && await temCurso(), '5 dias de atraso: ainda ativo');

    // --- 31 dias: suspende licenças e cursos inclusos ---
    await pool.query('UPDATE faturas SET data_vencimento = $2 WHERE id = $1', [fid, dia(-31)]);
    await vigencia.suspenderInadimplentes();
    let kk = (await pool.query('SELECT status, suspenso_por_fatura_id FROM contratos_conector WHERE id = $1', [kid])).rows[0];
    ok(kk.status === 'suspenso' && kk.suspenso_por_fatura_id === fid, '31 dias de atraso: contrato do Conector suspenso pela fatura');
    ok(!await temCurso(), 'curso incluso bloqueado na hora');
    const lic = (await pool.query(`SELECT status FROM licencas WHERE vaga_id = $1`, [conv.body.vaga_id])).rows[0];
    ok(!lic || lic.status === 'suspensa', 'licença individual (se houver) acompanha a suspensão');
    const ficha = (await api(tokAdmin, `/clientes/${cli}/ficha`)).body;
    ok(ficha.conector[0].suspenso_por_fatura_id === fid && ficha.atividade.some(a => a.acao === 'conector.suspenso_inadimplencia'), 'ficha mostra a suspensão e o motivo');

    // --- Pagou: volta na hora ---
    const baixa = await api(tokAdmin, `/financeiro/faturas/${fid}/baixa`, 'POST', { data_pagamento: dia(0), valor_pago: 1200, forma_pagamento: 'transferencia' });
    kk = (await pool.query('SELECT status, suspenso_por_fatura_id FROM contratos_conector WHERE id = $1', [kid])).rows[0];
    ok(baixa.status === 200 && kk.status === 'ativo' && !kk.suspenso_por_fatura_id, 'baixa da fatura reativa o contrato');
    ok(await temCurso(), 'curso incluso de volta');

    // --- Suspensão manual não é desfeita pela rotina ---
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'suspenso' });
    await vigencia.reativarPagos();
    ok((await pool.query('SELECT status FROM contratos_conector WHERE id = $1', [kid])).rows[0].status === 'suspenso', 'suspensão feita pelo admin continua');
    await api(tokAdmin, `/contratos-conector/${kid}`, 'PUT', { status: 'ativo' });

    // --- Renovação: avisos e +12 meses ---
    await pool.query(`UPDATE contratos SET data_fim = $2 WHERE id = $1`, [ctId, dia(30)]);
    await vigencia.avisarVencimentos();
    await vigencia.avisarVencimentos();
    const avisos = (await pool.query(`SELECT detalhe FROM auditoria WHERE entidade = 'contrato' AND entidade_id = $1 AND acao = 'contrato.aviso_vencimento'`, [ctId])).rows;
    ok(avisos.length === 1 && avisos[0].detalhe === 'dias:30', 'aviso de 30 dias enviado uma vez');
    const mails = (await pool.query(`SELECT para, assunto, ok FROM emails_enviados WHERE id > $1`, [emailAntes])).rows;
    ok(mails.some(m => /vence em 30/.test(m.assunto)) && mails.some(m => /Licenças do Conector vencem em 30/.test(m.assunto) && m.para.includes(`adm-f5-${sufixo}`)),
      `e-mails registrados (admins da Marsh e administrador da empresa): ${mails.length}`);
    await pool.query(`UPDATE contratos SET data_fim = $2 WHERE id = $1`, [ctId, dia(-1)]);
    await vigencia.processarFimDeVigencia();
    const ren = (await pool.query(`SELECT to_char(data_fim, 'YYYY-MM-DD') AS f, status FROM contratos WHERE id = $1`, [ctId])).rows[0];
    const esperado = new Date(`${dia(-1)}T12:00:00Z`); esperado.setUTCMonth(esperado.getUTCMonth() + 12);
    ok(ren.status === 'ativo' && ren.f === esperado.toISOString().slice(0, 10), `renovado por mais 12 meses (até ${ren.f})`);
    const kf = (await pool.query(`SELECT to_char(data_fim, 'YYYY-MM-DD') AS f FROM contratos_conector WHERE id = $1`, [kid])).rows[0].f;
    ok(kf >= ren.f, 'contrato do Conector acompanha a renovação');

    // --- Sem renovação automática: encerra ---
    const sr = await api(tokAdmin, '/financeiro/contratos', 'POST', { cliente_id: cli, descricao: 'TESTE F5 serviço', descricao_servico: 'x', valor: 100,
      dia_vencimento: 10, data_inicio: dia(-400), data_fim: dia(-1), emitir_nfse: false, renovacao_automatica: false });
    await vigencia.processarFimDeVigencia();
    ok((await pool.query('SELECT status FROM contratos WHERE id = $1', [sr.body.id])).rows[0].status === 'encerrado', 'sem renovação automática: encerrado no fim da vigência');
    const lista = (await api(tokAdmin, '/financeiro/contratos')).body.find(c => c.id === ctId);
    ok(lista.renovacao_automatica === true, 'tela de contratos mostra a renovação automática');
    const hist = (await api(tokAdmin, `/financeiro/contratos/${ctId}/historico`)).body.map(h => h.acao);
    ok(hist.includes('contrato.renovado') && hist.includes('contrato.aviso_vencimento'), 'histórico do contrato registra aviso e renovação');
    await pool.query('DELETE FROM auditoria WHERE entidade = $1 AND entidade_id = $2', ['contrato', sr.body.id]);
    await pool.query('DELETE FROM contratos WHERE id = $1', [sr.body.id]);
  } catch (e) {
    falhas++;
    console.error('FAIL erro inesperado:', e);
  } finally {
    const users = (await pool.query('SELECT id FROM usuarios WHERE cliente_id = $1', [cli])).rows.map(r => r.id);
    const vagas = (await pool.query('SELECT id FROM contratos_conector_vagas WHERE contrato_id = $1', [kid || 0])).rows.map(r => r.id);
    await pool.query(`DELETE FROM auditoria WHERE (entidade = 'contrato' AND entidade_id = $1) OR (entidade = 'contrato_conector' AND entidade_id = $2)
      OR (entidade = 'vaga_conector' AND entidade_id = ANY($3)) OR (entidade = 'cliente' AND entidade_id = $4)
      OR (entidade = 'direito_acesso' AND entidade_id IN (SELECT id FROM direitos_acesso WHERE usuario_id = ANY($5)))`, [ctId || 0, kid || 0, vagas, cli, users]);
    await pool.query('DELETE FROM faturas WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM contratos WHERE cliente_id = $1', [cli]);
    await pool.query('DELETE FROM licencas WHERE vaga_id = ANY($1)', [vagas]);
    await pool.query('DELETE FROM contratos_conector_vagas WHERE contrato_id = $1', [kid || 0]);
    await pool.query('DELETE FROM contratos_conector WHERE id = $1', [kid || 0]);
    await pool.query('DELETE FROM usuarios_tokens WHERE usuario_id = ANY($1)', [users]);
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM cursos_aulas WHERE curso_id = $1', [curso]);
    await pool.query('DELETE FROM cursos WHERE id = $1', [curso]);
    await pool.query('DELETE FROM clientes WHERE id = $1', [cli]);
    await pool.query(`DELETE FROM alertas_sistema WHERE id > $1 AND (chave LIKE 'inadimplencia:%')`, [alertaAntes]);
    console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo OK'}`);
    await pool.end();
    process.exit(falhas ? 1 : 0);
  }
})();
