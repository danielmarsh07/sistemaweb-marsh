/**
 * /api/contratos-cursos — contrato de cursos POR PESSOAS (regras em services/contratos-cursos.js).
 *
 * O contrato tem os cursos e N vagas; cada vaga é uma pessoa (convite por e-mail). Só quem ocupa uma vaga vê os cursos.
 * Cobrança: cortesia (sem fatura) | unica (fatura avulsa em rascunho) | mensal | anual (contrato financeiro ligado).
 *
 * Portal (gestor = administrador da empresa, tabela clientes_admins):
 *   GET  /meus                                contratos de cursos do cliente, com vagas e progresso
 *   POST /meus/:id/convidar                   { nome, email } ou { eu: true } — próxima vaga livre
 *   POST /meus/:id/vagas/:vid/liberar         tira a pessoa da vaga (ou cancela o convite)
 *   POST /meus/:id/vagas/:vid/convite         reenvia o convite
 * Admin:
 *   GET  /?cliente_id=      contratos (com cursos e vagas)
 *   GET  /:id               um contrato (vagas e ocupantes)
 *   POST /                  { cliente_id, curso_ids[], vagas, pessoas?: [{ nome, email }], gestor?: { nome, email },
 *                             data_inicio?, data_fim?, cobranca, valor?, dia_vencimento?, observacoes? }
 *   PUT  /:id               { curso_ids[], vagas, data_fim?, observacoes? }
 *   POST /:id/convidar      { nome, email, vaga_id? }
 *   POST /:id/vagas/:vid/liberar | /:id/vagas/:vid/convite
 *   POST /:id/encerrar      os cursos saem de todas as vagas e a cobrança recorrente para
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const auditoria = require('../services/auditoria');
const acessos = require('../services/acessos');
const cc = require('../services/contratos-conector');
const ccu = require('../services/contratos-cursos');

const emp = req => req.usuario.empresa_id || 1;
const COBRANCAS = { cortesia: 'Cortesia', unica: 'Pagamento único', mensal: 'Mensal', anual: 'Anual' };
const hojeBrasilia = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const dataValida = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(new Date(`${d}T12:00:00Z`));
const ehAdmin = t => t === 'admin_empresa' || t === 'admin_sistema';

function responder(res, err, msg) {
  if (err instanceof cc.ErroRegra) return res.status(400).json({ erro: err.message });
  res.status(500).json({ erro: msg, detalhe: err.message });
}

async function sincronizar(usuarioId, atorId) {
  if (usuarioId) await acessos.sincronizarUsuario(usuarioId, { atorId }).catch(err => console.error('[acessos] contrato de cursos:', err.message));
}
async function sincronizarContrato(contratoId) {
  const r = await pool.query(
    `SELECT usuario_id AS id FROM contratos_cursos_vagas WHERE contrato_id = $1 AND usuario_id IS NOT NULL
     UNION SELECT d.usuario_id FROM direitos_acesso d JOIN contratos_cursos_vagas v ON v.id = d.origem_id
     WHERE d.origem = 'contrato' AND d.status = 'ativo' AND v.contrato_id = $1`, [contratoId]);
  for (const { id } of r.rows) await sincronizar(id);
}

function mensagemOcupacao(r) {
  if (!r.criado) return `${r.usuario.nome} recebeu os cursos do contrato.`;
  return r.convite_enviado
    ? `${r.usuario.nome} recebeu os cursos. Convite enviado para ${r.usuario.email} (os cursos aparecem quando a pessoa criar a senha).`
    : `${r.usuario.nome} está na vaga, mas o convite não pôde ser enviado. Use "Reenviar convite".`;
}

async function reenviarConvite(k, vagaId, res) {
  const u = (await pool.query(
    `SELECT u.id, u.nome, u.email FROM contratos_cursos_vagas v JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.id = $1 AND v.contrato_id = $2 AND v.ativo`, [vagaId, k.id])).rows[0];
  if (!u) return res.status(404).json({ erro: 'Vaga sem pessoa.' });
  if (!await cc.enviarConvite(u)) return res.status(400).json({ erro: 'Não foi possível enviar o e-mail agora. Tente de novo mais tarde.' });
  res.json({ mensagem: `Convite reenviado para ${u.email}.` });
}

// ============================== PORTAL ==============================
async function contratoDoGestor(req) {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return null;
  if (!await cc.ehAdminCorporativo(req.usuario.id, req.usuario.cliente_id)) return null;
  return (await pool.query(`SELECT * FROM contratos_cursos WHERE id = $1 AND cliente_id = $2 AND status = 'ativo'`,
    [req.params.id, req.usuario.cliente_id])).rows[0] || null;
}

router.get('/meus', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json([]);
  try {
    if (!await cc.ehAdminCorporativo(req.usuario.id, req.usuario.cliente_id)) return res.json([]);
    const ids = (await pool.query(`SELECT id FROM contratos_cursos WHERE cliente_id = $1 AND status = 'ativo' ORDER BY id DESC`,
      [req.usuario.cliente_id])).rows;
    res.json(await Promise.all(ids.map(r => ccu.detalhar(r.id))));
  } catch (err) { responder(res, err, 'Erro ao buscar os contratos de cursos'); }
});

router.post('/meus/:id/convidar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const r = await ccu.ocuparVaga(k, (req.body || {}).vaga_id, req.body || {}, { euId: req.usuario.id, atorId: req.usuario.id });
    await sincronizar(r.usuario.id, req.usuario.id);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado });
  } catch (err) { responder(res, err, 'Erro ao convidar'); }
});

router.post('/meus/:id/vagas/:vid/liberar', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await sincronizar(await ccu.liberarVaga(k, req.params.vid, req.usuario.id), req.usuario.id);
    res.json({ mensagem: 'Vaga liberada. A pessoa perde os cursos deste contrato, mas continua com a conta e o progresso.' });
  } catch (err) { responder(res, err, 'Erro ao liberar a vaga'); }
});

router.post('/meus/:id/vagas/:vid/convite', async (req, res) => {
  try {
    const k = await contratoDoGestor(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await reenviarConvite(k, req.params.vid, res);
  } catch (err) { responder(res, err, 'Erro ao reenviar o convite'); }
});

// ============================== ADMIN ==============================
router.use((req, res, next) => {
  if (!ehAdmin(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores.' });
  next();
});

async function contratoDaEmpresa(req, db = pool) {
  return (await db.query('SELECT * FROM contratos_cursos WHERE id = $1 AND empresa_id = $2', [req.params.id, emp(req)])).rows[0] || null;
}

router.get('/', async (req, res) => {
  try {
    const filtro = req.query.cliente_id ? 'AND k.cliente_id = $2' : '';
    const ids = (await pool.query(`SELECT k.id FROM contratos_cursos k WHERE k.empresa_id = $1 ${filtro} ORDER BY (k.status = 'ativo') DESC, k.id DESC`,
      req.query.cliente_id ? [emp(req), req.query.cliente_id] : [emp(req)])).rows;
    res.json(await Promise.all(ids.map(r => ccu.detalhar(r.id))));
  } catch (err) { responder(res, err, 'Erro ao listar contratos de cursos'); }
});

router.get('/:id', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const d = await ccu.detalhar(k.id);
    d.gestores = await cc.listarAdmins(k.cliente_id);
    res.json(d);
  } catch (err) { responder(res, err, 'Erro ao buscar contrato de cursos'); }
});

// Cursos da empresa escolhidos (ativos); devolve os ids válidos
async function lerCursos(db, ids, empresaId) {
  const lista = Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Number.isInteger))] : [];
  if (!lista.length) throw new cc.ErroRegra('Escolha ao menos um curso.');
  const r = await db.query('SELECT id FROM cursos WHERE id = ANY($1) AND empresa_id = $2 AND ativo', [lista, empresaId]);
  if (r.rows.length !== lista.length) throw new cc.ErroRegra('Algum curso escolhido não existe mais. Atualize a página.');
  return lista;
}

async function gravarItens(db, contratoId, cursoIds) {
  await db.query('DELETE FROM contratos_cursos_itens WHERE contrato_id = $1 AND NOT (curso_id = ANY($2))', [contratoId, cursoIds]);
  for (const id of cursoIds) {
    await db.query('INSERT INTO contratos_cursos_itens (contrato_id, curso_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [contratoId, id]);
  }
}

// Pessoas informadas no formulário: [{ nome, email }] sem repetir e-mail
function lerPessoas(lista) {
  const vistas = new Set();
  return (Array.isArray(lista) ? lista : [])
    .map(p => ({ nome: String(p && p.nome || '').trim(), email: String(p && p.email || '').trim() }))
    .filter(p => p.email && !vistas.has(p.email.toLowerCase()) && vistas.add(p.email.toLowerCase()));
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  let k, titulos, financeiroId = null, faturaId = null, gestor = null;
  try {
    const cliente = (await db.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo', [b.cliente_id, emp(req)])).rows[0];
    if (!cliente) throw new cc.ErroRegra('Escolha o cliente.');
    const pessoas = lerPessoas(b.pessoas);
    const vagas = ccu.lerVagas(b.vagas === undefined || b.vagas === '' ? Math.max(1, pessoas.length) : b.vagas);
    if (pessoas.length > vagas) throw new cc.ErroRegra(`Você informou ${pessoas.length} pessoas para ${vagas} vaga(s). Aumente as vagas.`);
    const cobranca = COBRANCAS[b.cobranca] ? b.cobranca : 'cortesia';
    const valor = cobranca === 'cortesia' ? 0 : Math.round(Number(b.valor) * 100) / 100;
    if (cobranca !== 'cortesia' && !(valor > 0)) throw new cc.ErroRegra('Informe o valor (ou escolha Cortesia).');
    const inicio = b.data_inicio || hojeBrasilia();
    if (!dataValida(inicio)) throw new cc.ErroRegra('Data de início inválida.');
    const fim = b.data_fim ? b.data_fim : null;
    if (fim && (!dataValida(fim) || fim < inicio)) throw new cc.ErroRegra('Validade inválida (precisa ser depois do início).');
    if (cobranca === 'anual' && !fim) throw new cc.ErroRegra('Cobrança anual precisa de validade (fim do contrato).');
    const dia = b.dia_vencimento ? Number(b.dia_vencimento) : 10;
    if (!Number.isInteger(dia) || dia < 1 || dia > 28) throw new cc.ErroRegra('Dia de vencimento: 1 a 28.');

    await db.query('BEGIN');
    const cursoIds = await lerCursos(db, b.curso_ids, emp(req));
    k = (await db.query(
      `INSERT INTO contratos_cursos (empresa_id, cliente_id, data_inicio, data_fim, valor, cobranca, observacoes, criado_por_usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [emp(req), cliente.id, inicio, fim, valor, cobranca, String(b.observacoes || '').trim() || null, req.usuario.id])).rows[0];
    await gravarItens(db, k.id, cursoIds);
    await ccu.criarVagas(db, k.id, vagas);
    titulos = (await db.query('SELECT titulo FROM cursos WHERE id = ANY($1) ORDER BY titulo', [cursoIds])).rows.map(r => r.titulo);
    const descServico = `Acesso aos cursos online Marsh (${vagas} pessoa(s)): ${titulos.join(', ')}.`;

    // Gestor (opcional): administrador da empresa no portal, distribui as vagas
    if (b.gestor && String(b.gestor.email || '').trim()) {
      const g = await cc.acharOuCriarUsuario(db, { clienteId: cliente.id, empresaId: emp(req), nome: b.gestor.nome, email: b.gestor.email, papel: 'gestor' });
      await db.query(`INSERT INTO clientes_admins (cliente_id, usuario_id, criado_por_usuario_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [cliente.id, g.usuario.id, req.usuario.id]);
      gestor = g;
    }

    if (cobranca === 'mensal' || cobranca === 'anual') {
      financeiroId = (await db.query(
        `INSERT INTO contratos (empresa_id, cliente_id, descricao, descricao_servico, valor, dia_vencimento, data_inicio, data_fim,
           tipo, periodicidade, mes_cobranca, contrato_cursos_id, itens, emitir_nfse, status, observacoes, criado_por_usuario_id, renovacao_automatica)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'produto', $9, $10, $11, $12, TRUE, 'ativo', $13, $14, FALSE) RETURNING id`,
        [emp(req), cliente.id, `Cursos — ${vagas} pessoa(s), ${cursoIds.length} curso(s)`, descServico, valor, dia, inicio, fim, cobranca,
         cobranca === 'anual' ? Number(inicio.slice(5, 7)) : null, k.id,
         JSON.stringify(titulos.map(t => ({ descricao: `Curso: ${t}`, tipo: cobranca }))),
         `Cobrança do contrato de cursos nº ${k.id}.`, req.usuario.id])).rows[0].id;
      await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato.criado', entidade: 'contrato',
        entidade_id: financeiroId, depois: { tipo: 'produto', periodicidade: cobranca, valor, contrato_cursos_id: k.id } }, db);
    } else if (cobranca === 'unica') {
      const fat = require('../services/faturamento');
      const config = await fat.carregarConfig(emp(req));
      const venc = new Date(Date.now() + 10 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      faturaId = (await db.query(
        `INSERT INTO faturas (empresa_id, cliente_id, competencia, descricao, valor, data_vencimento, observacoes,
           emitir_nfse, codigo_servico, nome_servico, aliquota_iss, reter_iss, criado_por_usuario_id, ret_ir, ret_csll, ret_pis, ret_cofins, ret_inss)
         VALUES ($1, $2, date_trunc('month', $3::date)::date, $4, $5, $6, $7, TRUE, $8, $9, $10, FALSE, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [emp(req), cliente.id, hojeBrasilia(), descServico, valor, venc, `Contrato de cursos nº ${k.id} (pagamento único).`,
         config.codigo_servico, config.nome_servico, config.aliquota_iss, req.usuario.id, ...fat.RETENCOES.map(r => config[r] ?? 0)])).rows[0].id;
    }
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato_cursos.criado', entidade: 'cliente',
      entidade_id: cliente.id, depois: { contrato_cursos_id: k.id, cursos: titulos, vagas, cobranca, valor, data_fim: fim } }, db);
    await db.query('COMMIT');

    // Depois do contrato gravado: convite ao gestor novo e as pessoas nas vagas (uma falha não desfaz o contrato)
    if (gestor && gestor.criado) gestor.convite_enviado = await cc.enviarConvite(gestor.usuario);
    const resultados = [];
    for (const p of pessoas) {
      try {
        const r = await ccu.ocuparVaga(k, null, p, { atorId: req.usuario.id });
        await sincronizar(r.usuario.id, req.usuario.id);
        resultados.push(r.criado ? (r.convite_enviado ? `${r.usuario.email}: convite enviado` : `${r.usuario.email}: convite não enviado (reenvie)`)
          : `${r.usuario.email}: já tinha acesso, cursos liberados`);
      } catch (err) {
        if (!(err instanceof cc.ErroRegra)) throw err;
        resultados.push(`${p.email}: ${err.message}`);
      }
    }
    const extra = financeiroId ? ` Cobrança ${COBRANCAS[cobranca].toLowerCase()} criada em Contratos.`
      : faturaId ? ' Fatura em rascunho criada no Faturamento (aprove para enviar).' : ' Cortesia: sem cobrança.';
    const txtGestor = gestor ? ` Gestor: ${gestor.usuario.nome}${gestor.criado ? (gestor.convite_enviado ? ' (convite enviado)' : ' (convite não enviado)') : ''}.` : '';
    res.status(201).json({ id: k.id, contrato_financeiro_id: financeiroId, fatura_id: faturaId, pessoas: resultados,
      mensagem: `Contrato de cursos criado com ${vagas} vaga(s) para ${titulos.length} curso(s)${fim ? ` até ${fim.split('-').reverse().join('/')}` : ''}.${extra}${txtGestor}`
        + (resultados.length ? `\n\nPessoas:\n• ${resultados.join('\n• ')}` : '') });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responder(res, err, 'Erro ao criar contrato de cursos');
  } finally { db.release(); }
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const db = await pool.connect();
  try {
    let k = await contratoDaEmpresa(req, db);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    if (k.status !== 'ativo') throw new cc.ErroRegra('Contrato encerrado não muda. Crie outro.');
    const inicio = String(k.data_inicio instanceof Date ? k.data_inicio.toISOString() : k.data_inicio).slice(0, 10);
    const fim = b.data_fim ? b.data_fim : null;
    if (fim && (!dataValida(fim) || fim < inicio)) throw new cc.ErroRegra('Validade inválida (precisa ser depois do início).');
    await db.query('BEGIN');
    await db.query('SELECT id FROM contratos_cursos WHERE id = $1 FOR UPDATE', [k.id]);
    const cursoIds = await lerCursos(db, b.curso_ids, emp(req));
    k = (await db.query(
      `UPDATE contratos_cursos SET data_fim = $2, observacoes = $3, data_atualizacao = NOW() WHERE id = $1 RETURNING *`,
      [k.id, fim, b.observacoes !== undefined ? (String(b.observacoes).trim() || null) : k.observacoes])).rows[0];
    await gravarItens(db, k.id, cursoIds);
    if (b.vagas !== undefined && b.vagas !== '') await ccu.ajustarVagas(db, k, b.vagas);
    await db.query(`UPDATE contratos SET data_fim = $2, data_atualizacao = NOW() WHERE contrato_cursos_id = $1 AND status = 'ativo'`, [k.id, fim]);
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato_cursos.alterado', entidade: 'cliente',
      entidade_id: k.cliente_id, depois: { contrato_cursos_id: k.id, curso_ids: cursoIds, vagas: b.vagas, data_fim: fim } }, db);
    await db.query('COMMIT');
    await sincronizarContrato(k.id);
    res.json({ mensagem: 'Contrato de cursos atualizado.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responder(res, err, 'Erro ao atualizar contrato de cursos');
  } finally { db.release(); }
});

router.post('/:id/convidar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    const b = req.body || {};
    const r = await ccu.ocuparVaga(k, b.vaga_id, { nome: b.nome, email: b.email }, { atorId: req.usuario.id });
    await sincronizar(r.usuario.id, req.usuario.id);
    res.json({ mensagem: mensagemOcupacao(r), convite_enviado: r.convite_enviado });
  } catch (err) { responder(res, err, 'Erro ao colocar a pessoa na vaga'); }
});

router.post('/:id/vagas/:vid/liberar', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await sincronizar(await ccu.liberarVaga(k, req.params.vid, req.usuario.id), req.usuario.id);
    res.json({ mensagem: 'Vaga liberada.' });
  } catch (err) { responder(res, err, 'Erro ao liberar a vaga'); }
});

router.post('/:id/vagas/:vid/convite', async (req, res) => {
  try {
    const k = await contratoDaEmpresa(req);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    await reenviarConvite(k, req.params.vid, res);
  } catch (err) { responder(res, err, 'Erro ao reenviar o convite'); }
});

router.post('/:id/encerrar', async (req, res) => {
  const db = await pool.connect();
  try {
    const k = await contratoDaEmpresa(req, db);
    if (!k) return res.status(404).json({ erro: 'Contrato não encontrado.' });
    if (k.status !== 'ativo') throw new cc.ErroRegra('O contrato já está encerrado.');
    await db.query('BEGIN');
    await db.query(`UPDATE contratos_cursos SET status = 'encerrado', data_atualizacao = NOW() WHERE id = $1`, [k.id]);
    await db.query(`UPDATE contratos SET status = 'encerrado', data_atualizacao = NOW() WHERE contrato_cursos_id = $1 AND status <> 'encerrado'`, [k.id]);
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'contrato_cursos.encerrado', entidade: 'cliente',
      entidade_id: k.cliente_id, antes: { contrato_cursos_id: k.id } }, db);
    await db.query('COMMIT');
    await sincronizarContrato(k.id);
    res.json({ mensagem: 'Contrato de cursos encerrado: as pessoas das vagas perdem estes cursos e a cobrança recorrente parou. O progresso fica guardado.' });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    responder(res, err, 'Erro ao encerrar contrato de cursos');
  } finally { db.release(); }
});

module.exports = router;
