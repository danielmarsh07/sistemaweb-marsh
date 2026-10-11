/**
 * /api/licencas — gestão das licenças do conector Claude <-> SAP (requer login).
 *
 * Admin (admin_empresa / admin_sistema): listar, criar, editar, nova chave, cancelar, uso.
 * Cliente: GET /minhas — só as licenças do próprio cliente, sem dados de chave.
 * A chave em texto aparece UMA vez (criação / nova chave); no banco fica só o hash.
 */
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { PLANOS, gerarChave, hashChave, prefixoChave, listaSids } = require('../services/licenca');

const COLUNAS = `l.id, l.cliente_id, l.produto, l.plano, l.max_usuarios, l.sids, l.data_inicio, l.data_fim,
  l.status, l.chave_prefixo, l.ultima_validacao, l.versao_conector, l.observacoes, l.data_criacao`;

const USO_30D = `
  (SELECT COUNT(DISTINCT u.usuario_hash) FROM licencas_uso u
    WHERE u.licenca_id = l.id AND u.data >= CURRENT_DATE - 30) AS usuarios_ativos,
  (SELECT COALESCE(SUM(u.chamadas), 0) FROM licencas_uso u
    WHERE u.licenca_id = l.id AND u.data >= CURRENT_DATE - 30) AS chamadas_30d`;

function somenteAdmin(req, res, next) {
  const tipo = req.usuario.tipo;
  if (tipo !== 'admin_empresa' && tipo !== 'admin_sistema') {
    return res.status(403).json({ erro: 'Apenas administradores podem gerenciar licenças.' });
  }
  next();
}

function validarCampos(body, parcial = false) {
  const { plano, data_fim, sids, max_usuarios, status } = body;
  if (!parcial || plano !== undefined) {
    if (!PLANOS[plano]) return 'Plano inválido (leitura, desenvolvimento ou empresa).';
  }
  if (!parcial || data_fim !== undefined) {
    if (!data_fim || isNaN(Date.parse(data_fim))) return 'Data de fim do contrato é obrigatória.';
  }
  if (sids !== undefined && listaSids(sids).some(s => !/^[A-Z0-9]{3}$/.test(s))) {
    return 'SIDs devem ter 3 letras/números, separados por vírgula (ex.: DEV, QAS).';
  }
  if (max_usuarios !== undefined && max_usuarios !== null && max_usuarios !== '' &&
      !(Number.isInteger(Number(max_usuarios)) && Number(max_usuarios) > 0)) {
    return 'Máximo de usuários deve ser um número inteiro positivo (vazio = ilimitado).';
  }
  if (status !== undefined && !['ativa', 'suspensa', 'cancelada'].includes(status)) {
    return 'Status inválido (ativa, suspensa ou cancelada).';
  }
  return null;
}

const maxOuNulo = v => (v === undefined || v === null || v === '' ? null : Number(v));

// GET /minhas — portal do cliente (antes de /:id)
router.get('/minhas', async (req, res) => {
  if (req.usuario.tipo !== 'cliente' || !req.usuario.cliente_id) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT l.id, l.produto, l.plano, l.max_usuarios, l.sids, l.data_inicio, l.data_fim, l.status,
              l.ultima_validacao, ${USO_30D}
       FROM licencas l
       WHERE l.cliente_id = $1 AND l.ativo = TRUE AND l.status <> 'cancelada'
       ORDER BY l.data_fim DESC`,
      [req.usuario.cliente_id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar licenças', detalhe: err.message });
  }
});

router.use(somenteAdmin);

// GET / — lista
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const r = await pool.query(
      `SELECT ${COLUNAS}, COALESCE(c.razao_social, c.nome) AS cliente_nome, ${USO_30D}
       FROM licencas l
       JOIN clientes c ON c.id = l.cliente_id
       WHERE l.empresa_id = $1 AND l.ativo = TRUE
       ORDER BY l.status = 'ativa' DESC, l.data_fim ASC`,
      [empresa_id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar licenças', detalhe: err.message });
  }
});

// GET /:id/uso — contadores dos últimos 30 dias
router.get('/:id/uso', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const lic = await pool.query('SELECT id FROM licencas WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]);
    if (!lic.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });

    const porFerramenta = await pool.query(
      `SELECT ferramenta, SUM(chamadas)::int AS chamadas, SUM(recusas)::int AS recusas
       FROM licencas_uso WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30
       GROUP BY ferramenta ORDER BY chamadas DESC`, [req.params.id]);
    const porDia = await pool.query(
      `SELECT data, SUM(chamadas)::int AS chamadas, COUNT(DISTINCT usuario_hash)::int AS usuarios
       FROM licencas_uso WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30
       GROUP BY data ORDER BY data`, [req.params.id]);
    const porSid = await pool.query(
      `SELECT sid, SUM(chamadas)::int AS chamadas FROM licencas_uso
       WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30 GROUP BY sid ORDER BY sid`, [req.params.id]);
    const usuarios = await pool.query(
      `SELECT COUNT(DISTINCT usuario_hash)::int AS n FROM licencas_uso
       WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30`, [req.params.id]);

    res.json({
      por_ferramenta: porFerramenta.rows,
      por_dia: porDia.rows,
      por_sid: porSid.rows,
      usuarios_ativos: usuarios.rows[0].n
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar uso da licença', detalhe: err.message });
  }
});

// POST / — cria licença e devolve a chave (única vez)
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const erro = validarCampos(req.body);
  if (erro) return res.status(400).json({ erro });
  const { cliente_id, plano, max_usuarios, sids, data_inicio, data_fim, observacoes } = req.body;

  try {
    const cli = await pool.query('SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [cliente_id, empresa_id]);
    if (!cli.rows.length) return res.status(400).json({ erro: 'Cliente inválido.' });

    const chave = gerarChave();
    const r = await pool.query(
      `INSERT INTO licencas (empresa_id, cliente_id, plano, max_usuarios, sids, data_inicio, data_fim,
         status, chave_hash, chave_prefixo, observacoes, criado_por_usuario_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, 'ativa', $8, $9, $10, $11)
       RETURNING id`,
      [empresa_id, cliente_id, plano, maxOuNulo(max_usuarios), listaSids(sids || 'DEV').join(','),
       data_inicio || null, data_fim, hashChave(chave), prefixoChave(chave), observacoes || null, req.usuario.id]
    );
    res.status(201).json({ mensagem: 'Licença criada! Copie a chave agora: ela não será exibida de novo.',
                           id: r.rows[0].id, chave });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar licença', detalhe: err.message });
  }
});

// PUT /:id — edita contrato (não mexe na chave)
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const erro = validarCampos(req.body, true);
  if (erro) return res.status(400).json({ erro });

  try {
    const atual = await pool.query('SELECT * FROM licencas WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });
    const l = atual.rows[0];
    const b = req.body;

    await pool.query(
      `UPDATE licencas SET plano = $1, max_usuarios = $2, sids = $3, data_inicio = $4, data_fim = $5,
         status = $6, observacoes = $7, atualizado_por_usuario_id = $8, data_atualizacao = NOW()
       WHERE id = $9 AND empresa_id = $10`,
      [b.plano ?? l.plano,
       b.max_usuarios !== undefined ? maxOuNulo(b.max_usuarios) : l.max_usuarios,
       b.sids !== undefined ? listaSids(b.sids).join(',') : l.sids,
       b.data_inicio || l.data_inicio, b.data_fim || l.data_fim,
       b.status ?? l.status, b.observacoes ?? l.observacoes,
       req.usuario.id, req.params.id, empresa_id]
    );
    res.json({ mensagem: 'Licença atualizada!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar licença', detalhe: err.message });
  }
});

// POST /:id/nova-chave — invalida a chave antiga e gera outra (única exibição)
router.post('/:id/nova-chave', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const chave = gerarChave();
    const r = await pool.query(
      `UPDATE licencas SET chave_hash = $1, chave_prefixo = $2, atualizado_por_usuario_id = $3,
         data_atualizacao = NOW()
       WHERE id = $4 AND empresa_id = $5 AND ativo = TRUE RETURNING id`,
      [hashChave(chave), prefixoChave(chave), req.usuario.id, req.params.id, empresa_id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json({ mensagem: 'Nova chave gerada. A anterior deixou de funcionar.', chave });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar nova chave', detalhe: err.message });
  }
});

// DELETE /:id — cancela (exclusão lógica; o histórico de uso é mantido)
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const r = await pool.query(
      `UPDATE licencas SET status = 'cancelada', ativo = FALSE, atualizado_por_usuario_id = $1,
         data_atualizacao = NOW()
       WHERE id = $2 AND empresa_id = $3 RETURNING id`,
      [req.usuario.id, req.params.id, empresa_id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json({ mensagem: 'Licença cancelada.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cancelar licença', detalhe: err.message });
  }
});

module.exports = router;
