const express = require('express');
const router = express.Router();
const pool = require('../db');
const { validarDocumento } = require('../services/validacao');

// GET - Listar clientes da empresa logada
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT c.*,
        COALESCE(c.razao_social, c.nome) as nome_exibicao,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome,
        (SELECT COUNT(*) FROM chamados ch WHERE ch.cliente_id = c.id AND ch.ativo = true AND ch.status NOT IN ('resolvido','fechado')) as chamados_abertos
       FROM clientes c
       LEFT JOIN usuarios uc ON uc.id = c.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = c.atualizado_por_usuario_id
       WHERE c.empresa_id = $1 AND c.ativo = TRUE
       ORDER BY COALESCE(c.razao_social, c.nome) ASC`,
      [empresa_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar clientes', detalhe: err.message });
  }
});

// GET - Um cliente por ID (com tecnologias vinculadas)
router.get('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT c.*,
        uc.nome as criado_por_nome,
        ua.nome as atualizado_por_nome
       FROM clientes c
       LEFT JOIN usuarios uc ON uc.id = c.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = c.atualizado_por_usuario_id
       WHERE c.id = $1 AND c.empresa_id = $2 AND c.ativo = TRUE`,
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const cliente = result.rows[0];

    // Buscar tecnologias vinculadas
    const tecResult = await pool.query(
      `SELECT t.id, t.nome, t.categoria, ct.status as vinculo_status, ct.data_ativacao
       FROM cliente_tecnologias ct
       JOIN tecnologias t ON t.id = ct.tecnologia_id
       WHERE ct.cliente_id = $1 AND ct.status = 'ativo'`,
      [req.params.id]
    );
    cliente.tecnologias = tecResult.rows;

    res.json(cliente);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar cliente', detalhe: err.message });
  }
});

// POST - Criar novo cliente
router.post('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const {
    razao_social, nome_fantasia, cpf_cnpj,
    inscricao_estadual, inscricao_municipal,
    email, telefone, celular, site,
    responsavel_nome, responsavel_email, responsavel_telefone,
    cep, logradouro, numero, complemento, bairro, cidade, uf,
    status, data_inicio_contrato, data_fim_contrato, observacoes,
    segmento, porte, tier_sla
  } = req.body;

  if (!razao_social) {
    return res.status(400).json({ erro: 'Razão social é obrigatória' });
  }

  // Validar formato/dígito do CPF/CNPJ se preenchido
  if (cpf_cnpj && !validarDocumento(cpf_cnpj)) {
    return res.status(400).json({ erro: 'CPF/CNPJ inválido. Verifique os dígitos.' });
  }

  try {
    // Verificar CNPJ duplicado dentro da empresa
    if (cpf_cnpj) {
      const dup = await pool.query(
        'SELECT id FROM clientes WHERE cpf_cnpj = $1 AND empresa_id = $2 AND ativo = TRUE',
        [cpf_cnpj, empresa_id]
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({ erro: 'CPF/CNPJ já cadastrado para outro cliente' });
      }
    }

    const result = await pool.query(
      `INSERT INTO clientes (
        empresa_id, nome, razao_social, nome_fantasia, cpf_cnpj,
        inscricao_estadual, inscricao_municipal,
        email, telefone, celular, site,
        responsavel_nome, responsavel_email, responsavel_telefone,
        cep, logradouro, numero, complemento, bairro, cidade, uf,
        status, data_inicio_contrato, data_fim_contrato, observacoes,
        segmento, porte, tier_sla,
        criado_por_usuario_id, ativo
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25,
        $26, $27, $28,
        $29, TRUE
      ) RETURNING *`,
      [
        empresa_id,
        razao_social,
        razao_social, nome_fantasia || null, cpf_cnpj || null,
        inscricao_estadual || null, inscricao_municipal || null,
        email || null, telefone || null, celular || null, site || null,
        responsavel_nome || null, responsavel_email || null, responsavel_telefone || null,
        cep || null, logradouro || null, numero || null, complemento || null,
        bairro || null, cidade || null, uf || null,
        status || 'ativo',
        data_inicio_contrato || null, data_fim_contrato || null,
        observacoes || null,
        segmento || null, porte || null, tier_sla || null,
        req.usuario.id
      ]
    );
    res.status(201).json({ mensagem: 'Cliente criado com sucesso!', cliente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar cliente', detalhe: err.message });
  }
});

// PUT - Atualizar cliente
router.put('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;

  // Helper: converte string vazia em null
  const v = (val) => (val === '' || val === undefined) ? null : val;

  const {
    razao_social, nome_fantasia, cpf_cnpj,
    inscricao_estadual, inscricao_municipal,
    email, telefone, celular, site,
    responsavel_nome, responsavel_email, responsavel_telefone,
    cep, logradouro, numero, complemento, bairro, cidade, uf,
    status, data_inicio_contrato, data_fim_contrato, observacoes,
    segmento, porte, tier_sla
  } = req.body;

  // Validar formato/dígito do CPF/CNPJ se preenchido
  if (cpf_cnpj && cpf_cnpj.trim() !== '' && !validarDocumento(cpf_cnpj)) {
    return res.status(400).json({ erro: 'CPF/CNPJ inválido. Verifique os dígitos.' });
  }

  try {
    // Usa IS NOT FALSE para pegar registros com ativo=TRUE e ativo=NULL (migração)
    const atual = await pool.query(
      'SELECT * FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo IS NOT FALSE',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const c = atual.rows[0];

    // Verificar CNPJ duplicado (exceto o próprio)
    const novoCnpj = v(cpf_cnpj);
    if (novoCnpj && novoCnpj !== c.cpf_cnpj) {
      const dup = await pool.query(
        'SELECT id FROM clientes WHERE cpf_cnpj = $1 AND empresa_id = $2 AND ativo IS NOT FALSE AND id != $3',
        [novoCnpj, empresa_id, req.params.id]
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({ erro: 'CPF/CNPJ já cadastrado para outro cliente' });
      }
    }

    const novaRazao = v(razao_social) || c.razao_social || c.nome;

    const result = await pool.query(
      `UPDATE clientes SET
        nome=$1, razao_social=$2, nome_fantasia=$3, cpf_cnpj=$4,
        inscricao_estadual=$5, inscricao_municipal=$6,
        email=$7, telefone=$8, celular=$9, site=$10,
        responsavel_nome=$11, responsavel_email=$12, responsavel_telefone=$13,
        cep=$14, logradouro=$15, numero=$16, complemento=$17, bairro=$18, cidade=$19, uf=$20,
        status=$21, data_inicio_contrato=$22::date, data_fim_contrato=$23::date, observacoes=$24,
        segmento=$25, porte=$26, tier_sla=$27,
        atualizado_por_usuario_id=$28, data_atualizacao=NOW()
       WHERE id=$29 AND empresa_id=$30
       RETURNING *`,
      [
        novaRazao,
        novaRazao,
        v(nome_fantasia) ?? c.nome_fantasia,
        novoCnpj ?? c.cpf_cnpj,
        v(inscricao_estadual) ?? c.inscricao_estadual,
        v(inscricao_municipal) ?? c.inscricao_municipal,
        v(email) ?? c.email,
        v(telefone) ?? c.telefone,
        v(celular) ?? c.celular,
        v(site) ?? c.site,
        v(responsavel_nome) ?? c.responsavel_nome,
        v(responsavel_email) ?? c.responsavel_email,
        v(responsavel_telefone) ?? c.responsavel_telefone,
        v(cep) ?? c.cep,
        v(logradouro) ?? c.logradouro,
        v(numero) ?? c.numero,
        v(complemento) ?? c.complemento,
        v(bairro) ?? c.bairro,
        v(cidade) ?? c.cidade,
        v(uf) ?? c.uf,
        v(status) || c.status || 'ativo',
        v(data_inicio_contrato) || null,
        v(data_fim_contrato) || null,
        v(observacoes) ?? c.observacoes,
        v(segmento) ?? c.segmento,
        v(porte) ?? c.porte,
        v(tier_sla) ?? c.tier_sla,
        req.usuario.id,
        req.params.id,
        empresa_id
      ]
    );
    res.json({ mensagem: 'Cliente atualizado com sucesso!', cliente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar cliente', detalhe: err.message });
  }
});

// DELETE - Exclusão lógica do cliente
router.delete('/:id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      'UPDATE clientes SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING *',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }
    res.json({ mensagem: 'Cliente removido com sucesso!', cliente: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover cliente', detalhe: err.message });
  }
});

// POST - Vincular tecnologia ao cliente
router.post('/:id/tecnologias', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { tecnologia_id, data_ativacao, observacoes } = req.body;

  if (!tecnologia_id) {
    return res.status(400).json({ erro: 'tecnologia_id é obrigatório' });
  }

  try {
    // Garantir que o cliente pertence à empresa
    const clienteOk = await pool.query(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
    if (clienteOk.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    const result = await pool.query(
      `INSERT INTO cliente_tecnologias (cliente_id, tecnologia_id, data_ativacao, observacoes, status)
       VALUES ($1, $2, $3, $4, 'ativo')
       ON CONFLICT (cliente_id, tecnologia_id)
       DO UPDATE SET status = 'ativo', data_ativacao = $3, data_inativacao = NULL
       RETURNING *`,
      [req.params.id, tecnologia_id, data_ativacao || new Date(), observacoes || null]
    );
    res.status(201).json({ mensagem: 'Tecnologia vinculada com sucesso!', vinculo: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao vincular tecnologia', detalhe: err.message });
  }
});

// DELETE - Desvincular tecnologia do cliente
router.delete('/:id/tecnologias/:tec_id', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const clienteOk = await pool.query(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo = TRUE',
      [req.params.id, empresa_id]
    );
    if (clienteOk.rows.length === 0) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    await pool.query(
      `UPDATE cliente_tecnologias SET status = 'inativo', data_inativacao = CURRENT_DATE
       WHERE cliente_id = $1 AND tecnologia_id = $2`,
      [req.params.id, req.params.tec_id]
    );
    res.json({ mensagem: 'Tecnologia desvinculada com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao desvincular tecnologia', detalhe: err.message });
  }
});

module.exports = router;
