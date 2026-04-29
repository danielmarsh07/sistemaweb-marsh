const express = require('express');
const router = express.Router();
const pool = require('../db');
const { notificarNovoChamado, notificarAtualizacaoStatus } = require('../services/email');
const { calcularSla } = require('../services/sla');

// GET - Listar chamados (cliente vê só os seus; admin vê todos)
// Suporta: status, prioridade, cliente_id, busca (texto), page, limit
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const usuario_id = req.usuario.id;
  const isCliente = req.usuario.tipo === 'cliente';
  const { status, prioridade, cliente_id, busca } = req.query;

  // Paginação (default: page=1, limit=50, max=200)
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const params = [empresa_id, usuario_id];
    let where = 'WHERE ch.empresa_id = $1 AND ch.ativo = TRUE';
    let idx = 3;

    if (isCliente && req.usuario.cliente_id) {
      where += ` AND ch.cliente_id = $${idx++}`;
      params.push(req.usuario.cliente_id);
    }
    if (status) { where += ` AND ch.status = $${idx++}`; params.push(status); }
    if (prioridade) { where += ` AND ch.prioridade = $${idx++}`; params.push(prioridade); }
    if (!isCliente && cliente_id) { where += ` AND ch.cliente_id = $${idx++}`; params.push(cliente_id); }
    if (busca && busca.trim()) {
      where += ` AND (ch.titulo ILIKE $${idx} OR ch.descricao ILIKE $${idx} OR CAST(ch.id AS TEXT) = $${idx + 1})`;
      params.push(`%${busca.trim()}%`);
      params.push(busca.trim());
      idx += 2;
    }

    // Conta total para paginação
    const totalResult = await pool.query(
      `SELECT COUNT(*) as total FROM chamados ch ${where}`,
      params
    );
    const total = parseInt(totalResult.rows[0].total);

    const dadosParams = [...params, limit, offset];
    const result = await pool.query(`
      SELECT ch.*,
        COALESCE(c.razao_social, c.nome) as cliente_nome,
        t.nome as tecnologia_nome,
        u1.nome as aberto_por_nome,
        u2.nome as atribuido_para_nome,
        u3.nome as atualizado_por_nome,
        (SELECT COUNT(*) FROM atendimentos a WHERE a.chamado_id = ch.id) as total_atendimentos,
        (SELECT COUNT(*) FROM atendimentos a
          WHERE a.chamado_id = ch.id
            AND a.usuario_id IS DISTINCT FROM $2
            AND NOT EXISTS (
              SELECT 1 FROM atendimentos_lidos al
              WHERE al.atendimento_id = a.id AND al.usuario_id = $2
            )
        ) as atendimentos_nao_lidos,
        av.nota as avaliacao_nota
      FROM chamados ch
      LEFT JOIN clientes c ON c.id = ch.cliente_id
      LEFT JOIN tecnologias t ON t.id = ch.tecnologia_id
      LEFT JOIN usuarios u1 ON u1.id = ch.aberto_por_usuario_id
      LEFT JOIN usuarios u2 ON u2.id = ch.atribuido_para_usuario_id
      LEFT JOIN usuarios u3 ON u3.id = ch.atualizado_por_usuario_id
      LEFT JOIN chamados_avaliacao av ON av.chamado_id = ch.id
      ${where}
      ORDER BY ch.data_criacao DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, dadosParams);

    // Anexa SLA computado em cada chamado
    const chamados = result.rows.map(ch => ({ ...ch, sla: calcularSla(ch) }));

    res.json({
      chamados,
      paginacao: { total, page, limit, total_paginas: Math.ceil(total / limit) }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar chamados', detalhe: err.message });
  }
});

// GET - Um chamado por ID (com atendimentos, status_log, avaliação, SLA)
router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  try {
    let query = `SELECT ch.*,
        COALESCE(c.razao_social, c.nome) as cliente_nome,
        t.nome as tecnologia_nome,
        u1.nome as aberto_por_nome,
        u2.nome as atribuido_para_nome,
        u3.nome as atualizado_por_nome
       FROM chamados ch
       LEFT JOIN clientes c ON c.id = ch.cliente_id
       LEFT JOIN tecnologias t ON t.id = ch.tecnologia_id
       LEFT JOIN usuarios u1 ON u1.id = ch.aberto_por_usuario_id
       LEFT JOIN usuarios u2 ON u2.id = ch.atribuido_para_usuario_id
       LEFT JOIN usuarios u3 ON u3.id = ch.atualizado_por_usuario_id
       WHERE ch.id = $1 AND ch.empresa_id = $2 AND ch.ativo = TRUE`;
    const params = [req.params.id, empresa_id];

    if (isCliente) {
      if (!req.usuario.cliente_id) {
        return res.status(403).json({ erro: 'Usuário não vinculado a um cliente.' });
      }
      query += ' AND ch.cliente_id = $3';
      params.push(req.usuario.cliente_id);
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    const chamado = result.rows[0];
    chamado.sla = calcularSla(chamado);

    // Atendimentos (com flag se já foi lido pelo usuário atual)
    const atend = await pool.query(`
      SELECT a.*, u.nome as usuario_nome,
        EXISTS (
          SELECT 1 FROM atendimentos_lidos al
          WHERE al.atendimento_id = a.id AND al.usuario_id = $2
        ) as lido
      FROM atendimentos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.chamado_id = $1
      ORDER BY a.data_atendimento ASC
    `, [req.params.id, req.usuario.id]);
    chamado.atendimentos = atend.rows;

    // Anexos
    const anexos = await pool.query(`
      SELECT a.id, a.nome_original, a.tamanho_bytes, a.mime_type, a.data_upload,
        u.nome as enviado_por_nome
      FROM chamados_anexos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.chamado_id = $1
      ORDER BY a.data_upload ASC
    `, [req.params.id]);
    chamado.anexos = anexos.rows;

    // Avaliação CSAT (se existir)
    const avaliacao = await pool.query(
      `SELECT av.*, u.nome as avaliado_por_nome
       FROM chamados_avaliacao av
       LEFT JOIN usuarios u ON u.id = av.usuario_id
       WHERE av.chamado_id = $1`,
      [req.params.id]
    );
    chamado.avaliacao = avaliacao.rows[0] || null;

    // Histórico de status (apenas para perfis internos)
    if (!isCliente) {
      const log = await pool.query(
        `SELECT l.*, u.nome as usuario_nome
         FROM chamados_status_log l
         LEFT JOIN usuarios u ON u.id = l.usuario_id
         WHERE l.chamado_id = $1
         ORDER BY l.data_mudanca ASC`,
        [req.params.id]
      );
      chamado.status_log = log.rows;
    }

    res.json(chamado);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar chamado', detalhe: err.message });
  }
});

// POST - Abrir chamado
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const usuario_id = req.usuario.id;
  const isCliente = req.usuario.tipo === 'cliente';

  let {
    cliente_id, tecnologia_id,
    titulo, descricao, prioridade, categoria,
    atribuido_para_usuario_id
  } = req.body;

  if (isCliente) {
    if (!req.usuario.cliente_id) {
      return res.status(400).json({ erro: 'Usuário não vinculado a nenhum cliente. Contate o administrador.' });
    }
    cliente_id = req.usuario.cliente_id;
  }

  if (!titulo) return res.status(400).json({ erro: 'Título é obrigatório' });
  if (!cliente_id) return res.status(400).json({ erro: 'Cliente é obrigatório' });

  try {
    const result = await pool.query(
      `INSERT INTO chamados (
        empresa_id, cliente_id, tecnologia_id,
        aberto_por_usuario_id, atribuido_para_usuario_id,
        titulo, descricao, prioridade, categoria, status, ativo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aberto', TRUE)
      RETURNING *`,
      [
        empresa_id, cliente_id || null, tecnologia_id || null,
        usuario_id, atribuido_para_usuario_id || null,
        titulo, descricao || null,
        prioridade || 'media', categoria || null
      ]
    );
    const chamado = result.rows[0];

    await pool.query(
      `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
       VALUES ($1, $2, $3, NULL, 'aberto', 'Chamado aberto')`,
      [chamado.id, empresa_id, usuario_id]
    );

    notificarNovoChamado({
      chamado,
      empresa_id,
      aberto_por: req.usuario.nome
    }).catch(() => {});

    res.status(201).json({ mensagem: 'Chamado aberto com sucesso!', chamado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao abrir chamado', detalhe: err.message });
  }
});

// PUT - Atualizar chamado (status, atribuição, etc.)
router.put('/:id', async (req, res) => {
  if (req.usuario.tipo === 'cliente') {
    return res.status(403).json({ erro: 'Cliente não pode editar chamados.' });
  }
  const empresa_id = req.usuario.empresa_id || 1;
  const {
    titulo, descricao, status, prioridade, categoria,
    cliente_id, tecnologia_id, atribuido_para_usuario_id
  } = req.body;

  try {
    const atual = await pool.query(
      'SELECT * FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    const ch = atual.rows[0];
    const dataFechamento = (status === 'fechado' || status === 'resolvido') ? new Date() : ch.data_fechamento;

    const result = await pool.query(
      `UPDATE chamados SET
        titulo=$1, descricao=$2, status=$3, prioridade=$4, categoria=$5,
        cliente_id=$6, tecnologia_id=$7, atribuido_para_usuario_id=$8,
        data_fechamento=$9,
        atualizado_por_usuario_id=$10, data_atualizacao=NOW()
       WHERE id=$11 AND empresa_id=$12 RETURNING *`,
      [
        titulo || ch.titulo,
        descricao ?? ch.descricao,
        status || ch.status,
        prioridade || ch.prioridade,
        categoria ?? ch.categoria,
        cliente_id || ch.cliente_id,
        tecnologia_id ?? ch.tecnologia_id,
        atribuido_para_usuario_id ?? ch.atribuido_para_usuario_id,
        dataFechamento,
        req.usuario.id,
        req.params.id, empresa_id
      ]
    );
    const chamado = result.rows[0];

    if (status && status !== ch.status) {
      await pool.query(
        `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo)
         VALUES ($1, $2, $3, $4, $5)`,
        [chamado.id, empresa_id, req.usuario.id, ch.status, status]
      );

      notificarAtualizacaoStatus({
        chamado,
        statusAnterior: ch.status,
        empresa_id
      }).catch(() => {});
    }

    res.json({ mensagem: 'Chamado atualizado com sucesso!', chamado });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar chamado', detalhe: err.message });
  }
});

// POST - Reabrir chamado (cliente quando solução não funcionou; admin/técnico também pode)
router.post('/:id/reabrir', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  const { motivo } = req.body;

  try {
    let q = 'SELECT * FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE';
    const params = [req.params.id, empresa_id];
    if (isCliente) {
      if (!req.usuario.cliente_id) {
        return res.status(403).json({ erro: 'Usuário não vinculado a um cliente.' });
      }
      q += ' AND cliente_id = $3';
      params.push(req.usuario.cliente_id);
    }
    const atual = await pool.query(q, params);
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }
    const ch = atual.rows[0];

    if (ch.status !== 'resolvido' && ch.status !== 'fechado') {
      return res.status(400).json({ erro: 'Só é possível reabrir chamados resolvidos ou fechados.' });
    }

    const result = await pool.query(
      `UPDATE chamados SET status = 'aberto', data_fechamento = NULL,
         atualizado_por_usuario_id = $1, data_atualizacao = NOW()
       WHERE id = $2 AND empresa_id = $3 RETURNING *`,
      [req.usuario.id, req.params.id, empresa_id]
    );

    const observacao = motivo ? `Reaberto: ${motivo}` : 'Chamado reaberto';
    await pool.query(
      `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
       VALUES ($1, $2, $3, $4, 'aberto', $5)`,
      [req.params.id, empresa_id, req.usuario.id, ch.status, observacao]
    );

    // Registra como atendimento na timeline (visível para o outro lado)
    if (motivo) {
      await pool.query(
        `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, data_atendimento)
         VALUES ($1, $2, 'reabertura', $3, NOW())`,
        [req.params.id, req.usuario.id, motivo]
      );
    }

    res.json({ mensagem: 'Chamado reaberto com sucesso!', chamado: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reabrir chamado', detalhe: err.message });
  }
});

// POST - Avaliar chamado (CSAT) — só cliente, só após resolvido/fechado
router.post('/:id/avaliar', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  const { nota, comentario } = req.body;

  if (!isCliente) {
    return res.status(403).json({ erro: 'Apenas o cliente pode avaliar o atendimento.' });
  }
  if (!req.usuario.cliente_id) {
    return res.status(403).json({ erro: 'Usuário não vinculado a um cliente.' });
  }
  const notaInt = parseInt(nota);
  if (!notaInt || notaInt < 1 || notaInt > 5) {
    return res.status(400).json({ erro: 'Nota deve ser de 1 a 5.' });
  }

  try {
    const ch = await pool.query(
      `SELECT id, status FROM chamados
       WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE AND cliente_id = $3`,
      [req.params.id, empresa_id, req.usuario.cliente_id]
    );
    if (ch.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }
    if (ch.rows[0].status !== 'resolvido' && ch.rows[0].status !== 'fechado') {
      return res.status(400).json({ erro: 'Só é possível avaliar chamados resolvidos ou fechados.' });
    }

    const result = await pool.query(
      `INSERT INTO chamados_avaliacao (chamado_id, empresa_id, usuario_id, nota, comentario)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chamado_id) DO UPDATE
         SET nota = EXCLUDED.nota,
             comentario = EXCLUDED.comentario,
             data_avaliacao = NOW()
       RETURNING *`,
      [req.params.id, empresa_id, req.usuario.id, notaInt, comentario || null]
    );
    res.status(201).json({ mensagem: 'Avaliação registrada!', avaliacao: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar avaliação', detalhe: err.message });
  }
});

// POST - Marcar todos os atendimentos do chamado como lidos para o usuário atual
router.post('/:id/marcar-lido', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';

  try {
    let q = 'SELECT id FROM chamados WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE';
    const params = [req.params.id, empresa_id];
    if (isCliente) {
      if (!req.usuario.cliente_id) {
        return res.status(403).json({ erro: 'Usuário não vinculado a um cliente.' });
      }
      q += ' AND cliente_id = $3';
      params.push(req.usuario.cliente_id);
    }
    const ch = await pool.query(q, params);
    if (ch.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }

    await pool.query(
      `INSERT INTO atendimentos_lidos (atendimento_id, usuario_id)
       SELECT a.id, $1
       FROM atendimentos a
       WHERE a.chamado_id = $2
       ON CONFLICT (atendimento_id, usuario_id) DO NOTHING`,
      [req.usuario.id, req.params.id]
    );
    res.json({ mensagem: 'Atendimentos marcados como lidos.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao marcar como lido', detalhe: err.message });
  }
});

// DELETE - Exclusão lógica
router.delete('/:id', async (req, res) => {
  if (req.usuario.tipo === 'cliente') {
    return res.status(403).json({ erro: 'Cliente não pode remover chamados.' });
  }
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'UPDATE chamados SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING *',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }
    res.json({ mensagem: 'Chamado removido com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover chamado', detalhe: err.message });
  }
});

module.exports = router;
