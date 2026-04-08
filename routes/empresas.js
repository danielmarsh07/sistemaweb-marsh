const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET - Dados da empresa do usuário logado
router.get('/minha', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'SELECT * FROM empresas WHERE id = $1',
      [empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar empresa', detalhe: err.message });
  }
});

// PUT - Atualizar dados da própria empresa
router.put('/minha', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { razao_social, nome_fantasia, cnpj, email, telefone } = req.body;

  try {
    const atual = await pool.query('SELECT * FROM empresas WHERE id = $1', [empresa_id]);
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Empresa não encontrada' });
    }

    const e = atual.rows[0];
    const result = await pool.query(
      `UPDATE empresas SET razao_social=$1, nome_fantasia=$2, cnpj=$3, email=$4, telefone=$5
       WHERE id=$6 RETURNING *`,
      [
        razao_social || e.razao_social,
        nome_fantasia ?? e.nome_fantasia,
        cnpj ?? e.cnpj,
        email ?? e.email,
        telefone ?? e.telefone,
        empresa_id
      ]
    );
    res.json({ mensagem: 'Empresa atualizada com sucesso!', empresa: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar empresa', detalhe: err.message });
  }
});

// GET - Resumo / métricas da empresa
router.get('/resumo', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const [clientes, fornecedores, tecnologias, chamados] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM clientes WHERE empresa_id=$1 AND ativo=TRUE', [empresa_id]),
      pool.query('SELECT COUNT(*) FROM fornecedores WHERE empresa_id=$1 AND ativo=TRUE', [empresa_id]),
      pool.query('SELECT COUNT(*) FROM tecnologias WHERE empresa_id=$1 AND ativo=TRUE', [empresa_id]),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE status = 'aberto') as abertos,
          COUNT(*) FILTER (WHERE status = 'em_andamento') as em_andamento,
          COUNT(*) FILTER (WHERE status = 'resolvido') as resolvidos,
          COUNT(*) FILTER (WHERE status = 'fechado') as fechados,
          COUNT(*) as total
         FROM chamados WHERE empresa_id=$1 AND ativo=TRUE`, [empresa_id])
    ]);

    res.json({
      clientes: parseInt(clientes.rows[0].count),
      fornecedores: parseInt(fornecedores.rows[0].count),
      tecnologias: parseInt(tecnologias.rows[0].count),
      chamados: chamados.rows[0]
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar resumo', detalhe: err.message });
  }
});

module.exports = router;
