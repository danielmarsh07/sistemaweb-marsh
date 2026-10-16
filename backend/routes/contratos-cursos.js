/**
 * /api/contratos-cursos — contrato de cursos para a empresa inteira (docs/plano-contratos-unificados.md, fase 2). Só admin.
 *
 * Os cursos escolhidos viram liberação da empresa (cursos_liberacoes) com a validade do contrato e valem para todas
 * as pessoas do cliente no portal. Cobrança:
 *   cortesia — sem cobrança (valor 0)
 *   unica    — uma fatura avulsa em rascunho no Faturamento
 *   mensal | anual — contrato financeiro recorrente ligado (contratos.contrato_cursos_id)
 *
 *   GET  /?cliente_id=      contratos (com cursos e cobrança)
 *   GET  /:id               um contrato
 *   POST /                  { cliente_id, curso_ids[], data_inicio?, data_fim?, cobranca, valor?, dia_vencimento?, observacoes? }
 *   PUT  /:id               { curso_ids[], data_fim?, observacoes? } — troca os cursos e a validade
 *   POST /:id/encerrar      tira os cursos e encerra a cobrança recorrente
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const auditoria = require('../services/auditoria');
const acessos = require('../services/acessos');

const emp = req => req.usuario.empresa_id || 1;
const COBRANCAS = { cortesia: 'Cortesia', unica: 'Pagamento único', mensal: 'Mensal', anual: 'Anual' };
const hojeBrasilia = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const dataValida = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(new Date(`${d}T12:00:00Z`));

class ErroCursos extends Error {}

router.use((req, res, next) => {
  if (!['admin_empresa', 'admin_sistema'].includes(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores.' });
  next();
});

function responder(res, err, msg) {
  if (err instanceof ErroCursos) return res.status(400).json({ erro: err.message });
  res.status(500).json({ erro: msg, detalhe: err.message });
}

const SELECT_CONTRATO = `
  SELECT k.id, k.cliente_id, k.status, k.cobranca, k.valor::float AS valor, k.observacoes,
         to_char(k.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
         (k.status = 'ativo' AND (k.data_fim IS NULL OR k.data_fim >= CURRENT_DATE)) AS vigente,
         COALESCE(cl.nome_fantasia, cl.razao_social, cl.nome) AS cliente_nome,
         COALESCE((SELECT json_agg(json_build_object('id', c.id, 'titulo', c.titulo, 'status', c.status) ORDER BY c.titulo)
                     FROM cursos_liberacoes lb JOIN cursos c ON c.id = lb.curso_id WHERE lb.contrato_cursos_id = k.id), '[]') AS cursos,
         (SELECT ct.id FROM contratos ct WHERE ct.contrato_cursos_id = k.id ORDER BY ct.id DESC LIMIT 1) AS contrato_financeiro_id,
         (SELECT COUNT(*)::int FROM usuarios u WHERE u.cliente_id = k.cliente_id AND u.tipo = 'cliente' AND u.ativo) AS pessoas
  FROM contratos_cursos k JOIN clientes cl ON cl.id = k.cliente_id`;

router.get('/', async (req, res) => {
  try {
    const filtro = req.query.cliente_id ? 'AND k.cliente_id = $2' : '';
    const r = await pool.query(`${SELECT_CONTRATO} WHERE k.empresa_id = $1 ${filtro} ORDER BY (k.status = 'ativo') DESC, k.id DESC`,
      req.query.cliente_id ? [emp(req), req.query.cliente_id] : [emp(req)]);
    res.json(r.rows);
  } catch (err) { responder(res, err, 'Erro ao listar contratos de cursos'); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(`${SELECT_CONTRATO} WHERE k.id = $1 AND k.empresa_id = $2`, [req.params.id, emp(req)]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    res.json(r.rows[0]);
  } catch (err) { responder(res, err, 'Erro ao buscar contrato de cursos'); }
});

// Cursos da empresa escolhidos (ativos); devolve os ids válidos
async function lerCursos(db, ids, empresaId) {
  const lista = Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Number.isInteger))] : [];
  if (!lista.length) throw new ErroCursos('Escolha ao menos um curso.');
  const r = await db.query('SELECT id FROM cursos WHERE id = ANY($1) AND empresa_id = $2 AND ativo', [lista, empresaId]);
  if (r.rows.length !== lista.length) throw new ErroCursos('Algum curso escolhido não existe mais. Atualize a página.');
  return lista;
}

// Liberações do contrato = exatamente estes cursos, com a validade do contrato.
// Curso já liberado avulso para o cliente passa a ser do contrato (a liberação é uma só por curso e cliente).
async function gravarLiberacoes(db, k, cursoIds) {
  await db.query('DELETE FROM cursos_liberacoes WHERE contrato_cursos_id = $1 AND NOT (curso_id = ANY($2))', [k.id, cursoIds]);
  for (const id of cursoIds) {
    await db.query(
      `INSERT INTO cursos_liberacoes (curso_id, cliente_id, data_fim, contrato_cursos_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (curso_id, cliente_id) DO UPDATE SET data_fim = EXCLUDED.data_fim, contrato_cursos_id = EXCLUDED.contrato_cursos_id`,
      [id, k.cliente_id, k.data_fim, k.id]);
  }
}

async function sincronizarCliente(clienteId) {
  const r = await pool.query(`SELECT id FROM usuarios WHERE cliente_id = $1 AND tipo = 'cliente'`, [clienteId]);
  for (const { id } of r.rows) await acessos.sincronizarUsuario(id).catch(err => console.error('[acessos] contrato de cursos:', err.message));
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  try {
    const cliente = (await db.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo', [b.cliente_id, emp(req)])).rows[0];
    if (!cliente) throw new ErroCursos('Escolha o cliente.');
    const cobranca = COBRANCAS[b.cobranca] ? b.cobranca : 'cortesia';
    const valor = cobranca === 'cortesia' ? 0 : Math.round(Number(b.valor) * 100) / 100;
    if (cobranca !== 'cortesia' && !(valor > 0)) throw new ErroCursos('Informe o valor (ou escolha Cortesia).');
    const inicio = b.data_inicio || hojeBrasilia();
    if (!dataValida(inicio)) throw new ErroCursos('Data de início inválida.');
    const fim = b.data_fim ? b.data_fim : null;
    if (fim && (!dataValida(fim) || fim < inicio)) throw new ErroCursos('Validade inválida (precisa ser depois do início).');
    if (cobranca === 'anual' && !fim) throw new ErroCursos('Cobrança anual precisa de validade (fim do contrato).');
    const dia = b.dia_vencimento ? Number(b.dia_vencimento) : 10;
    if (!Number.isInteger(dia) || dia < 1 || dia > 28) throw new ErroCursos('Dia de vencimento: 1 a 28.');

    await db.query('BEGIN');
    const cursoIds = await lerCursos(db, b.curso_ids, emp(req));
    const k = (await db.query(
      `INSERT INTO contratos_cursos (empresa_id, cliente_id, data_inicio, data_fim, valor, cobranca, observacoes, criado_por_usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *, to_char(data_fim, 'YYYY-MM-DD') AS data_fim`,
      [emp(req), cliente.id, inicio, fim, valor, cobranca, String(b.observacoes || '').trim() || null, req.usuario.id])).rows[0];
    await gravarLiberacoes(db, k, cursoIds);
    const titulos = (await db.query('SELECT titulo FROM cursos WHERE id = ANY($1) ORDER BY titulo', [cursoIds])).rows.map(r => r.titulo);
    const descServico = `Acesso aos cursos online Marsh para a empresa: ${titulos.join(', ')}.`;

    let financeiroId = null, faturaId = null;
    if (cobranca === 'mensal' || cobranca === 'anual') {
      financeiroId = (await db.query(
        `INSERT INTO contratos (empresa_id, cliente_id, descricao, descricao_servico, valor, dia_vencimento, data_inicio, data_fim,
           tipo, periodicidade, mes_cobranca, contrato_cursos_id, itens, emitir_nfse, status, observacoes, criado_por_usuario_id, renovacao_automatica)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'produto', $9, $10, $11, $12, TRUE, 'ativo', $13, $14, FALSE) RETURNING id`,
        [emp(req), cliente.id, `Cursos para a empresa — ${cursoIds.length} curso(s)`, descServico, valor, dia, inicio, fim, cobranca,
         cobranca === 'anual' ? Number(inicio.slice(5, 7)) : null, k.id,
         JSON.stringify(titulos.map(t => ({ descricao: `Curso: ${t}`, tipo: cobranca }))),
         `Cobrança do contrato de cursos nº ${k.id}.`, req.usuario.id])).rows[0].id;
      await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato.criado', entidade: 'contrato',
        entidade_id: financeiroId, depois: { tipo: 'produto', periodicidade: cobranca, valor, contrato_cursos_id: k.id } }, db);
    } else if (cobranca === 'unica') {
      const config = await require('../services/faturamento').carregarConfig(emp(req));
      const { RETENCOES } = require('../services/faturamento');
      const venc = new Date(Date.now() + 10 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      faturaId = (await db.query(
        `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, observacoes,
           emitir_nfse, codigo_servico, nome_servico, aliquota_iss, reter_iss, criado_por_usuario_id, ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss)
         VALUES ($1, $2, date_trunc('month', $3::date)::date, $4, $5, $6, $7, TRUE, $8, $9, $10, FALSE, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [emp(req), cliente.id, hojeBrasilia(), descServico, valor, venc, `Contrato de cursos nº ${k.id} (pagamento único).`,
         config.codigo_servico, config.nome_servico, config.aliquota_iss, req.usuario.id, ...RETENCOES.map(r => config[r] ?? 0)])).rows[0].id;
    }
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato_cursos.criado', entidade: 'cliente',
      entidade_id: cliente.id, depois: { contrato_cursos_id: k.id, cursos: titulos, cobranca, valor, data_fim: fim } }, db);
    await db.query('COMMIT');
    await sincronizarCliente(cliente.id);

    const extra = financeiroId ? ` Cobrança ${COBRANCAS[cobranca].toLowerCase()} criada em Contratos.`
      : faturaId ? ' Fatura em rascunho criada no Faturamento (aprove para enviar).' : ' Cortesia: sem cobrança.';
    res.status(201).json({ id: k.id, contrato_financeiro_id: financeiroId, fatura_id: faturaId,
      mensagem: `${titulos.length} curso(s) liberado(s) para todos da empresa${fim ? ` até ${fim.split('-').reverse().join('/')}` : ''}.${extra}` });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responder(res, err, 'Erro ao criar contrato de cursos');
  } finally { db.release(); }
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  try {
    let k = (await db.query('SELECT * FROM contratos_cursos WHERE id = $1 AND empresa_id = $2', [req.params.id, emp(req)])).rows[0];
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    if (k.status !== 'ativo') throw new ErroCursos('Contrato encerrado não muda. Crie outro.');
    const inicio = String(k.data_inicio instanceof Date ? k.data_inicio.toISOString() : k.data_inicio).slice(0, 10);
    const fim = b.data_fim ? b.data_fim : null;
    if (fim && (!dataValida(fim) || fim < inicio)) throw new ErroCursos('Validade inválida (precisa ser depois do início).');
    await db.query('BEGIN');
    const cursoIds = await lerCursos(db, b.curso_ids, emp(req));
    k = (await db.query(
      `UPDATE contratos_cursos SET data_fim = $2, observacoes = $3, data_atualizacao = NOW() WHERE id = $1
       RETURNING *, to_char(data_fim, 'YYYY-MM-DD') AS data_fim`,
      [k.id, fim, b.observacoes !== undefined ? (String(b.observacoes).trim() || null) : k.observacoes])).rows[0];
    await gravarLiberacoes(db, k, cursoIds);
    await db.query(`UPDATE contratos SET data_fim = $2, data_atualizacao = NOW() WHERE contrato_cursos_id = $1 AND status = 'ativo'`, [k.id, fim]);
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato_cursos.alterado', entidade: 'cliente',
      entidade_id: k.cliente_id, depois: { contrato_cursos_id: k.id, curso_ids: cursoIds, data_fim: fim } }, db);
    await db.query('COMMIT');
    await sincronizarCliente(k.cliente_id);
    res.json({ mensagem: 'Contrato de cursos atualizado.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responder(res, err, 'Erro ao atualizar contrato de cursos');
  } finally { db.release(); }
});

router.post('/:id/encerrar', async (req, res) => {
  const db = await pool.connect();
  try {
    const k = (await db.query('SELECT * FROM contratos_cursos WHERE id = $1 AND empresa_id = $2', [req.params.id, emp(req)])).rows[0];
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    if (k.status !== 'ativo') throw new ErroCursos('O contrato já está encerrado.');
    await db.query('BEGIN');
    await db.query(`UPDATE contratos_cursos SET status = 'encerrado', data_atualizacao = NOW() WHERE id = $1`, [k.id]);
    await db.query('DELETE FROM cursos_liberacoes WHERE contrato_cursos_id = $1', [k.id]);
    await db.query(`UPDATE contratos SET status = 'encerrado', data_atualizacao = NOW() WHERE contrato_cursos_id = $1 AND status <> 'encerrado'`, [k.id]);
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato_cursos.encerrado', entidade: 'cliente',
      entidade_id: k.cliente_id, antes: { contrato_cursos_id: k.id } }, db);
    await db.query('COMMIT');
    await sincronizarCliente(k.cliente_id);
    res.json({ mensagem: 'Contrato de cursos encerrado: os cursos saíram da empresa e a cobrança recorrente parou. O progresso das pessoas fica guardado.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responder(res, err, 'Erro ao encerrar contrato de cursos');
  } finally { db.release(); }
});

module.exports = router;
