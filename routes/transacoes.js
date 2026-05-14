const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');

// Gera a lista de datas a partir de uma data base + periodicidade + data final (inclusiva).
// A data base é sempre o primeiro item. Periodicidades aceitas: 'mensal' | 'diaria'.
function gerarDatasRepeticao(dataBaseStr, periodicidade, dataFinalStr) {
  const datas = [];
  const base = new Date(dataBaseStr + 'T00:00:00');
  const limite = new Date(dataFinalStr + 'T00:00:00');
  if (isNaN(base) || isNaN(limite)) return null;
  if (limite < base) return null;

  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  if (periodicidade === 'diaria') {
    const cur = new Date(base);
    while (cur <= limite) {
      datas.push(fmt(cur));
      cur.setDate(cur.getDate() + 1);
      if (datas.length > 3650) break; // sanity: máximo 10 anos diários
    }
    return datas;
  }

  if (periodicidade === 'mensal') {
    const diaOriginal = base.getDate();
    let i = 0;
    while (true) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      // mantém o mesmo dia, mas faz clamp para o último dia do mês quando necessário
      const ultimoDiaMes = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(diaOriginal, ultimoDiaMes));
      if (d > limite) break;
      datas.push(fmt(d));
      i += 1;
      if (i > 600) break; // sanity: máximo 50 anos mensais
    }
    return datas;
  }

  return null;
}

// GET - Listar todas com resumo (filtrado por empresa)
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT t.*,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome
       FROM transacoes t
       LEFT JOIN usuarios uc ON uc.id = t.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = t.atualizado_por_usuario_id
       WHERE t.empresa_id = $1
       ORDER BY t.data DESC`,
      [empresa_id]
    );
    const transacoes = result.rows;

    let totalEntradas = 0;
    let totalSaidas = 0;

    transacoes.forEach(t => {
      if (t.tipo === 'entrada') totalEntradas += parseFloat(t.valor);
      else if (t.tipo === 'saída') totalSaidas += parseFloat(t.valor);
    });

    res.json({
      transacoes,
      resumo: {
        totalEntradas,
        totalSaidas,
        saldo: totalEntradas - totalSaidas
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar transações', detalhe: err.message });
  }
});

// GET - Uma transação por ID (filtrado por empresa)
router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT t.*,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome
       FROM transacoes t
       LEFT JOIN usuarios uc ON uc.id = t.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = t.atualizado_por_usuario_id
       WHERE t.id = $1 AND t.empresa_id = $2`,
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar transação', detalhe: err.message });
  }
});

// POST - Criar nova transação (com opção de repetir em múltiplas datas)
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { tipo, valor, categoria, descricao, data, repetir } = req.body;

  if (!tipo || !valor || !categoria) {
    return res.status(400).json({ erro: 'Tipo, valor e categoria são obrigatórios' });
  }

  if (!['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  try {
    const catCheck = await pool.query(
      `SELECT 1 FROM categorias_transacao
       WHERE empresa_id = $1 AND nome = $2 AND tipo = $3 AND ativo = TRUE`,
      [empresa_id, categoria, tipo]
    );
    if (catCheck.rows.length === 0) {
      return res.status(400).json({ erro: `Categoria "${categoria}" não está cadastrada para o tipo ${tipo}. Cadastre em "Categorias" antes.` });
    }

    // Caso simples: sem repetição
    if (!repetir || !repetir.periodicidade || !repetir.data_final) {
      const result = await pool.query(
        `INSERT INTO transacoes (tipo, valor, categoria, descricao, data, empresa_id, usuario_id, criado_por_usuario_id)
         VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $7) RETURNING *`,
        [tipo, parseFloat(valor), categoria, descricao || '', data || null, empresa_id, req.usuario.id]
      );
      return res.status(201).json({ mensagem: 'Transação criada com sucesso!', transacao: result.rows[0] });
    }

    // Caso com repetição
    if (!['mensal', 'diaria'].includes(repetir.periodicidade)) {
      return res.status(400).json({ erro: 'Periodicidade deve ser "mensal" ou "diaria"' });
    }

    const dataBase = data || new Date().toISOString().slice(0, 10);
    const datas = gerarDatasRepeticao(dataBase, repetir.periodicidade, repetir.data_final);
    if (!datas || datas.length === 0) {
      return res.status(400).json({ erro: 'Data final inválida ou anterior à data inicial.' });
    }
    if (datas.length > 600) {
      return res.status(400).json({ erro: 'Repetição gera lançamentos demais (>600). Reduza o intervalo.' });
    }

    const grupoId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const criadas = [];
      for (const dt of datas) {
        const r = await client.query(
          `INSERT INTO transacoes (tipo, valor, categoria, descricao, data, empresa_id, usuario_id, criado_por_usuario_id, grupo_id)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7, $7, $8) RETURNING *`,
          [tipo, parseFloat(valor), categoria, descricao || '', dt, empresa_id, req.usuario.id, grupoId]
        );
        criadas.push(r.rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json({
        mensagem: `${criadas.length} lançamentos criados com sucesso!`,
        grupo_id: grupoId,
        transacoes: criadas
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar transação', detalhe: err.message });
  }
});

// PUT - Atualizar transação (filtrada por empresa)
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { tipo, valor, categoria, descricao, data } = req.body;

  if (tipo && !['entrada', 'saída'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser "entrada" ou "saída"' });
  }

  try {
    const atual = await pool.query(
      'SELECT * FROM transacoes WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada' });
    }

    const t = atual.rows[0];
    const novoTipo = tipo || t.tipo;
    const novaCategoria = categoria || t.categoria;

    if (novaCategoria !== t.categoria || novoTipo !== t.tipo) {
      const catCheck = await pool.query(
        `SELECT 1 FROM categorias_transacao
         WHERE empresa_id = $1 AND nome = $2 AND tipo = $3 AND ativo = TRUE`,
        [empresa_id, novaCategoria, novoTipo]
      );
      if (catCheck.rows.length === 0) {
        return res.status(400).json({ erro: `Categoria "${novaCategoria}" não está cadastrada para o tipo ${novoTipo}.` });
      }
    }

    const result = await pool.query(
      `UPDATE transacoes SET tipo=$1, valor=$2, categoria=$3, descricao=$4, data=$5,
        atualizado_por_usuario_id=$6, data_atualizacao=NOW()
       WHERE id=$7 AND empresa_id=$8 RETURNING *`,
      [
        novoTipo,
        valor != null && valor !== '' ? parseFloat(valor) : t.valor,
        novaCategoria,
        descricao != null ? descricao : t.descricao,
        data || t.data,
        req.usuario.id,
        req.params.id, empresa_id
      ]
    );
    res.json({ mensagem: 'Transação atualizada com sucesso!', transacao: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar transação', detalhe: err.message });
  }
});

// DELETE - Deletar transação (filtrada por empresa)
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'DELETE FROM transacoes WHERE id = $1 AND empresa_id = $2 RETURNING *',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Transação não encontrada' });
    }
    res.json({ mensagem: 'Transação deletada com sucesso!', transacao: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao deletar transação', detalhe: err.message });
  }
});

module.exports = router;
