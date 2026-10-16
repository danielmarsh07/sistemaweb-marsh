/**
 * /api/loja — loja de cursos (requer login). Regras em services/loja.js.
 *
 * Portal: GET /meus-pedidos (pedidos do próprio usuário, com status e link para pagar).
 * Admin:  ofertas (GET/POST/PUT), cupons (GET/POST/PUT), pedidos (GET),
 *         POST /pedidos/:id/confirmar-teste (homologação: marca a cobrança de teste como paga no sandbox e libera),
 *         POST /pedidos/:id/cancelar, POST /pedidos/:id/estornar (registra estorno feito no Asaas e tira o acesso).
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const loja = require('../services/loja');
const asaas = require('../services/asaas');
const auditoria = require('../services/auditoria');

const emp = req => req.usuario.empresa_id || 1;
const vazio = v => v === undefined || v === null || String(v).trim() === '';
const dataOk = v => vazio(v) || /^\d{4}-\d{2}-\d{2}$/.test(String(v));

function erro(res, err, msg) {
  if (err instanceof loja.ErroLoja) return res.status(400).json({ erro: err.message });
  console.error(`[loja] ${msg}:`, err.message);
  res.status(500).json({ erro: msg, detalhe: err.message });
}

// ============================== PORTAL ==============================
router.get('/meus-pedidos', async (req, res) => {
  if (req.usuario.tipo !== 'cliente') return res.json([]);
  try {
    const r = await pool.query(
      `SELECT p.id, p.status, p.valor::float AS valor, p.desconto::float AS desconto, p.modo, p.forma_pagamento, p.criado_em, p.pago_em,
              to_char(p.vencimento, 'YYYY-MM-DD') AS vencimento, to_char(p.acesso_fim, 'YYYY-MM-DD') AS acesso_fim,
              CASE WHEN p.status = 'pendente' THEN p.link_pagamento END AS link_pagamento, o.titulo
       FROM pedidos p JOIN ofertas o ON o.id = p.oferta_id WHERE p.usuario_id = $1 ORDER BY p.criado_em DESC LIMIT 50`, [req.usuario.id]);
    res.json(r.rows);
  } catch (err) { erro(res, err, 'Erro ao buscar pedidos'); }
});

// ============================== ADMIN ==============================
router.use((req, res, next) => {
  if (!['admin_empresa', 'admin_sistema'].includes(req.usuario.tipo)) return res.status(403).json({ erro: 'Apenas administradores.' });
  next();
});

router.get('/status', (req, res) => {
  res.json({ teste_configurado: asaas.modoConfigurado('teste'), producao_configurado: asaas.modoConfigurado('producao'),
    ambiente_principal: asaas.ambiente(), webhook_teste: !!(process.env.ASAAS_SANDBOX_WEBHOOK_TOKEN || (asaas.ambiente() === 'sandbox' && process.env.ASAAS_WEBHOOK_TOKEN)) });
});

// ----- Ofertas -----
function validarOferta(b) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(b.slug || '')) || String(b.slug).length > 80) return 'Endereço (slug): letras minúsculas, números e hífens. Ex.: curso-sap-cpi';
  if (vazio(b.titulo)) return 'Informe o título da oferta.';
  if (!['curso', 'conector'].includes(b.tipo || 'curso')) return 'Tipo inválido.';
  if ((b.tipo || 'curso') === 'curso' && !Number.isInteger(Number(b.curso_id))) return 'Escolha o curso.';
  if ((b.tipo || 'curso') === 'curso' && !(Number(b.preco) >= 0)) return 'Preço inválido.';
  if (!vazio(b.preco_promocional) && !(Number(b.preco_promocional) >= 0 && Number(b.preco_promocional) <= Number(b.preco))) return 'Preço promocional deve ficar entre 0 e o preço cheio.';
  if (!['promo_inicio', 'promo_fim', 'venda_inicio', 'venda_fim'].every(k => dataOk(b[k]))) return 'Datas no formato AAAA-MM-DD.';
  if (!vazio(b.duracao_meses) && !(Number.isInteger(Number(b.duracao_meses)) && b.duracao_meses >= 1 && b.duracao_meses <= 120)) return 'Duração do acesso: 1 a 120 meses (vazio = sem prazo).';
  if (!['teste', 'producao'].includes(b.modo || 'teste')) return 'Modo inválido.';
  return null;
}
// Licenças do Conector: preço vem da tabela (preco 0 aqui), sem promoção fixa (use cupom) e vigência de 12 meses
const ehConector = b => b.tipo === 'conector';
const paramsOferta = b => [String(b.slug), String(b.titulo).trim().slice(0, 255), vazio(b.descricao) ? null : String(b.descricao),
  ehConector(b) ? null : Number(b.curso_id), ehConector(b) ? 0 : Number(b.preco),
  ehConector(b) || vazio(b.preco_promocional) ? null : Number(b.preco_promocional), ehConector(b) ? null : b.promo_inicio || null, ehConector(b) ? null : b.promo_fim || null,
  b.venda_inicio || null, b.venda_fim || null, ehConector(b) ? 12 : (vazio(b.duracao_meses) ? null : Number(b.duracao_meses)), b.modo || 'teste', b.ativa !== false,
  ehConector(b) ? 'conector' : 'curso'];

router.get('/ofertas', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.*, o.preco::float AS preco, o.preco_promocional::float AS preco_promocional,
              to_char(o.promo_inicio, 'YYYY-MM-DD') AS promo_inicio, to_char(o.promo_fim, 'YYYY-MM-DD') AS promo_fim,
              to_char(o.venda_inicio, 'YYYY-MM-DD') AS venda_inicio, to_char(o.venda_fim, 'YYYY-MM-DD') AS venda_fim,
              c.titulo AS curso_titulo, c.status AS curso_status,
              (SELECT COUNT(*)::int FROM pedidos p WHERE p.oferta_id = o.id AND p.status = 'pago') AS vendidos,
              (SELECT COALESCE(SUM(valor), 0)::float FROM pedidos p WHERE p.oferta_id = o.id AND p.status = 'pago') AS receita
       FROM ofertas o LEFT JOIN cursos c ON c.id = o.curso_id WHERE o.empresa_id = $1 ORDER BY o.ativa DESC, o.criado_em DESC`, [emp(req)]);
    res.json(r.rows.map(o => ({ ...o, preco_atual: loja.precoAtual(o).preco, em_venda: loja.emVenda(o) })));
  } catch (err) { erro(res, err, 'Erro ao buscar ofertas'); }
});

router.post('/ofertas', async (req, res) => {
  const b = req.body || {};
  const e = validarOferta(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    if (!ehConector(b)) {
      const c = await pool.query('SELECT 1 FROM cursos WHERE id = $1 AND empresa_id = $2 AND ativo', [b.curso_id, emp(req)]);
      if (!c.rows.length) return res.status(400).json({ erro: 'Curso não encontrado.' });
    }
    const r = await pool.query(
      `INSERT INTO ofertas (slug, titulo, descricao, curso_id, preco, preco_promocional, promo_inicio, promo_fim, venda_inicio, venda_fim,
         duracao_meses, modo, ativa, tipo, empresa_id, criado_por_usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, [...paramsOferta(b), emp(req), req.usuario.id]);
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'oferta.criada', entidade: 'oferta', entidade_id: r.rows[0].id,
      depois: { slug: b.slug, preco: Number(b.preco), modo: b.modo || 'teste' } });
    res.status(201).json({ mensagem: 'Oferta criada.', id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe uma oferta com esse endereço (slug).' });
    erro(res, err, 'Erro ao criar oferta');
  }
});

router.put('/ofertas/:id', async (req, res) => {
  const b = req.body || {};
  const e = validarOferta(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const antes = (await pool.query('SELECT modo, preco::float AS preco, ativa FROM ofertas WHERE id = $1 AND empresa_id = $2', [req.params.id, emp(req)])).rows[0];
    if (!antes) return res.status(404).json({ erro: 'Oferta não encontrada.' });
    await pool.query(
      `UPDATE ofertas SET slug=$1, titulo=$2, descricao=$3, curso_id=$4, preco=$5, preco_promocional=$6, promo_inicio=$7, promo_fim=$8,
         venda_inicio=$9, venda_fim=$10, duracao_meses=$11, modo=$12, ativa=$13, tipo=$14, atualizado_em=NOW() WHERE id=$15`, [...paramsOferta(b), req.params.id]);
    await auditoria.registrar({ empresa_id: emp(req), usuario_id: req.usuario.id, acao: 'oferta.alterada', entidade: 'oferta', entidade_id: Number(req.params.id),
      antes, depois: { modo: b.modo, preco: Number(b.preco), ativa: b.ativa !== false } });
    res.json({ mensagem: b.modo === 'producao' && antes.modo === 'teste' ? 'Oferta salva e colocada em PRODUÇÃO: os próximos pedidos cobram de verdade.' : 'Oferta salva.' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe uma oferta com esse endereço (slug).' });
    erro(res, err, 'Erro ao salvar oferta');
  }
});

// ----- Cupons -----
function validarCupom(b) {
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(String(b.codigo || ''))) return 'Código: 3 a 40 letras, números, - ou _.';
  if (!['percentual', 'valor'].includes(b.tipo)) return 'Tipo: percentual ou valor.';
  if (!(Number(b.valor) > 0) || (b.tipo === 'percentual' && Number(b.valor) > 100)) return 'Valor do desconto inválido.';
  if (!dataOk(b.inicio) || !dataOk(b.fim)) return 'Datas no formato AAAA-MM-DD.';
  if (!vazio(b.usos_max) && !(Number.isInteger(Number(b.usos_max)) && b.usos_max > 0)) return 'Limite de usos: número inteiro (vazio = sem limite).';
  return null;
}

router.get('/cupons', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT k.*, k.valor::float AS valor, to_char(k.inicio, 'YYYY-MM-DD') AS inicio, to_char(k.fim, 'YYYY-MM-DD') AS fim, o.titulo AS oferta_titulo
       FROM cupons k LEFT JOIN ofertas o ON o.id = k.oferta_id WHERE k.empresa_id = $1 ORDER BY k.ativo DESC, k.criado_em DESC`, [emp(req)]);
    res.json(r.rows);
  } catch (err) { erro(res, err, 'Erro ao buscar cupons'); }
});

router.post('/cupons', async (req, res) => {
  const b = req.body || {};
  const e = validarCupom(b);
  if (e) return res.status(400).json({ erro: e });
  try {
    const r = await pool.query(
      `INSERT INTO cupons (empresa_id, codigo, tipo, valor, oferta_id, inicio, fim, usos_max, ativo) VALUES ($1, UPPER($2), $3, $4, $5, $6, $7, $8, TRUE) RETURNING id`,
      [emp(req), b.codigo, b.tipo, Number(b.valor), vazio(b.oferta_id) ? null : Number(b.oferta_id), b.inicio || null, b.fim || null, vazio(b.usos_max) ? null : Number(b.usos_max)]);
    res.status(201).json({ mensagem: 'Cupom criado.', id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Já existe um cupom com esse código.' });
    erro(res, err, 'Erro ao criar cupom');
  }
});

router.put('/cupons/:id', async (req, res) => {
  try {
    const r = await pool.query('UPDATE cupons SET ativo = $1 WHERE id = $2 AND empresa_id = $3 RETURNING id', [req.body?.ativo !== false, req.params.id, emp(req)]);
    if (!r.rowCount) return res.status(404).json({ erro: 'Cupom não encontrado.' });
    res.json({ mensagem: req.body?.ativo === false ? 'Cupom desativado.' : 'Cupom ativado.' });
  } catch (err) { erro(res, err, 'Erro ao salvar cupom'); }
});

// ----- Pedidos -----
router.get('/pedidos', async (req, res) => {
  const { status, modo } = req.query;
  try {
    const r = await pool.query(
      `SELECT p.id, p.status, p.modo, p.valor::float AS valor, p.desconto::float AS desconto, p.forma_pagamento, p.origem, p.erro,
              p.criado_em, p.pago_em, to_char(p.vencimento, 'YYYY-MM-DD') AS vencimento, to_char(p.acesso_fim, 'YYYY-MM-DD') AS acesso_fim,
              p.link_pagamento, p.fatura_id, p.itens, p.contrato_conector_id, o.titulo AS oferta, o.tipo AS oferta_tipo, u.nome, u.email, k.codigo AS cupom,
              COALESCE(cl.razao_social, cl.nome) AS cliente, cl.cpf_cnpj, p.cliente_id
       FROM pedidos p JOIN ofertas o ON o.id = p.oferta_id JOIN usuarios u ON u.id = p.usuario_id
       JOIN clientes cl ON cl.id = p.cliente_id LEFT JOIN cupons k ON k.id = p.cupom_id
       WHERE p.empresa_id = $1 AND ($2::text IS NULL OR p.status = $2) AND ($3::text IS NULL OR p.modo = $3)
       ORDER BY p.criado_em DESC LIMIT 300`, [emp(req), status || null, modo || null]);
    res.json(r.rows);
  } catch (err) { erro(res, err, 'Erro ao buscar pedidos'); }
});

async function pedidoDaEmpresa(req) {
  return (await pool.query('SELECT * FROM pedidos WHERE id = $1 AND empresa_id = $2', [req.params.id, emp(req)])).rows[0] || null;
}

// Homologação: simula o pagamento de um pedido de TESTE (no sandbox) e libera o curso, mesmo sem webhook configurado
router.post('/pedidos/:id/confirmar-teste', async (req, res) => {
  try {
    const p = await pedidoDaEmpresa(req);
    if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    if (p.modo !== 'teste') return res.status(400).json({ erro: 'Só pedidos de teste podem ser confirmados por aqui.' });
    if (!['pendente', 'vencido'].includes(p.status)) return res.status(400).json({ erro: 'O pedido não está aguardando pagamento.' });
    if (p.asaas_payment_id) {
      await asaas.confirmarPagamentoTeste(p.asaas_payment_id, p.valor).catch(err => console.error('[loja] receiveInCash teste:', err.message));
    }
    await loja.confirmarPagamento(p.id, { forma: 'teste' });
    res.json({ mensagem: 'Pagamento de teste confirmado: curso liberado e e-mail enviado ao comprador.' });
  } catch (err) { erro(res, err, 'Erro ao confirmar o pagamento de teste'); }
});

router.post('/pedidos/:id/cancelar', async (req, res) => {
  try {
    const p = await pedidoDaEmpresa(req);
    if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    if (!['pendente', 'vencido'].includes(p.status)) return res.status(400).json({ erro: 'Só pedido aguardando pagamento pode ser cancelado.' });
    if (p.asaas_payment_id) await asaas.cancelarCobrancaModo(p.asaas_payment_id, p.modo).catch(err => console.error('[loja] cancelar cobrança:', err.message));
    await loja.mudarStatus(p.id, 'cancelado', `Cancelado por ${req.usuario.nome || 'administrador'}`);
    res.json({ mensagem: 'Pedido cancelado.' });
  } catch (err) { erro(res, err, 'Erro ao cancelar o pedido'); }
});

// Estorno feito no painel do Asaas (ou combinado com o cliente): tira o acesso comprado; o progresso fica
router.post('/pedidos/:id/estornar', async (req, res) => {
  try {
    const p = await pedidoDaEmpresa(req);
    if (!p) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    if (!await loja.mudarStatus(p.id, 'estornado', `Estorno registrado por ${req.usuario.nome || 'administrador'}`)) {
      return res.status(400).json({ erro: 'Só pedido pago (ou contestado) pode ser estornado.' });
    }
    res.json({ mensagem: 'Estorno registrado: o acesso ao curso comprado foi retirado.' });
  } catch (err) { erro(res, err, 'Erro ao registrar o estorno'); }
});

module.exports = router;
