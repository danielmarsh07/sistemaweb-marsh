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

// GET /:id/ficha — visão 360° do cliente: dados + contratos, faturas, usuários do portal, licenças, cursos,
// tecnologias, chamados e oportunidades. Contratos, faturas e oportunidades só para administradores.
router.get('/:id/ficha', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const tipo = req.usuario.tipo;
  if (tipo === 'cliente') return res.status(403).json({ erro: 'Acesso negado.' });
  const admin = !tipo || tipo === 'admin_empresa' || tipo === 'admin_sistema';
  const id = req.params.id;
  try {
    const c = (await pool.query(
      `SELECT c.*, uc.nome AS criado_por_nome, ua.nome AS atualizado_por_nome
       FROM clientes c
       LEFT JOIN usuarios uc ON uc.id = c.criado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = c.atualizado_por_usuario_id
       WHERE c.id = $1 AND c.empresa_id = $2 AND c.ativo = TRUE`, [id, empresa_id])).rows[0];
    if (!c) return res.status(404).json({ erro: 'Cliente não encontrado' });

    const vazio = { rows: [] };
    const [usuarios, licencas, cursos, tecnologias, chamados, contratos, faturas, oportunidades, conector, cursosAcesso, atividade, contratosCursos] = await Promise.all([
      // Usuários do portal com o papel: administrador da empresa, licença do Conector (ativa ou convite) e acesso amplo
      pool.query(
        `SELECT u.id, u.nome, u.email, u.ativo, u.portal_papel,
                EXISTS (SELECT 1 FROM clientes_admins a WHERE a.cliente_id = $1 AND a.usuario_id = u.id) AS admin_empresa,
                (SELECT json_agg(json_build_object('perfil', v.perfil, 'estado', v.estado, 'contrato_id', v.contrato_id))
                   FROM contratos_conector_vagas v WHERE v.usuario_id = u.id AND v.ativo) AS licencas,
                EXISTS (SELECT 1 FROM usuarios_tokens t WHERE t.usuario_id = u.id AND t.tipo = 'convite' AND t.usado_em IS NULL AND t.expira_em > NOW()) AS convite_pendente
         FROM usuarios u WHERE u.cliente_id = $1 AND u.tipo = 'cliente' ORDER BY u.ativo DESC, u.nome`, [id]),
      pool.query(
        `SELECT id, plano, sids, max_usuarios, status, vaga_id, to_char(data_fim, 'YYYY-MM-DD') AS data_fim, ultima_validacao,
                (data_fim < CURRENT_DATE) AS vencida
         FROM licencas WHERE cliente_id = $1 AND ativo = TRUE AND status <> 'cancelada' ORDER BY data_fim DESC`, [id]),
      pool.query(
        `SELECT cu.id, cu.titulo, cu.status, to_char(lb.data_fim, 'YYYY-MM-DD') AS acesso_ate, lb.contrato_cursos_id,
                (SELECT COUNT(*) FROM cursos_aulas a WHERE a.curso_id = cu.id AND a.ativo)::int AS aulas,
                (SELECT COUNT(DISTINCT p.usuario_id) FROM cursos_progresso p JOIN cursos_aulas a ON a.id = p.aula_id
                   JOIN usuarios u ON u.id = p.usuario_id WHERE a.curso_id = cu.id AND u.cliente_id = $1)::int AS alunos
         FROM cursos_liberacoes lb JOIN cursos cu ON cu.id = lb.curso_id
         WHERE lb.cliente_id = $1 AND cu.ativo ORDER BY cu.titulo`, [id]),
      pool.query(
        `SELECT t.id, t.nome, t.categoria, to_char(ct.data_ativacao, 'YYYY-MM-DD') AS desde
         FROM cliente_tecnologias ct JOIN tecnologias t ON t.id = ct.tecnologia_id
         WHERE ct.cliente_id = $1 AND ct.status = 'ativo' ORDER BY t.nome`, [id]),
      pool.query(
        `SELECT id, titulo, status, prioridade, to_char(data_abertura, 'YYYY-MM-DD') AS data_abertura,
                COUNT(*) OVER () AS total,
                COUNT(*) FILTER (WHERE status NOT IN ('resolvido','fechado')) OVER () AS abertos
         FROM chamados WHERE cliente_id = $1 AND ativo = TRUE
         ORDER BY (status NOT IN ('resolvido','fechado')) DESC, data_abertura DESC LIMIT 8`, [id]),
      admin ? pool.query(
        `SELECT id, descricao, valor::float AS valor, dia_vencimento, status, tipo, periodicidade, contrato_conector_id, contrato_cursos_id,
                COALESCE(mes_cobranca, EXTRACT(MONTH FROM data_inicio)::int) AS mes_cobranca,
                to_char(data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(data_fim, 'YYYY-MM-DD') AS data_fim
         FROM contratos WHERE cliente_id = $1 ORDER BY status = 'ativo' DESC, data_inicio DESC`, [id]) : vazio,
      admin ? pool.query(
        `SELECT id, to_char(competencia, 'YYYY-MM-DD') AS competencia, valor::float AS valor, status,
                to_char(data_vencimento, 'YYYY-MM-DD') AS data_vencimento, to_char(data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
                nfse_status, nfse_numero, nfse_pdf_url, (status = 'aberta' AND data_vencimento < CURRENT_DATE) AS vencida
         FROM faturas WHERE cliente_id = $1 AND status <> 'cancelada'
         ORDER BY competencia DESC, id DESC LIMIT 12`, [id]) : vazio,
      admin ? pool.query(
        `SELECT id, titulo, etapa, valor_mensal::float AS valor_mensal, valor_unico::float AS valor_unico,
                to_char(data_fechamento, 'YYYY-MM-DD') AS data_fechamento
         FROM oportunidades WHERE cliente_id = $1 ORDER BY (etapa IN ('ganha','perdida')), data_atualizacao DESC LIMIT 8`, [id]) : vazio,
      // Licenças do Conector: cada contrato com o total, em uso, convites pendentes e disponíveis, e a cobrança
      admin ? pool.query(
        `SELECT k.id, k.status, k.suspenso_por_fatura_id, to_char(k.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
                (k.status = 'ativo' AND k.data_inicio <= CURRENT_DATE AND k.data_fim >= CURRENT_DATE) AS vigente,
                COUNT(v.id)::int AS total,
                COUNT(v.id) FILTER (WHERE v.estado = 'ativa')::int AS em_uso,
                COUNT(v.id) FILTER (WHERE v.estado = 'convidada')::int AS convites,
                COUNT(v.id) FILTER (WHERE v.usuario_id IS NULL)::int AS livres,
                COUNT(v.id) FILTER (WHERE v.perfil = 'abap')::int AS abap,
                COUNT(v.id) FILTER (WHERE v.perfil = 'funcional')::int AS funcional,
                COUNT(v.id) FILTER (WHERE v.perfil = 'ambos')::int AS ambos,
                (SELECT ct.id FROM contratos ct WHERE ct.contrato_conector_id = k.id) AS contrato_financeiro_id
         FROM contratos_conector k LEFT JOIN contratos_conector_vagas v ON v.contrato_id = k.id AND v.ativo
         WHERE k.cliente_id = $1 GROUP BY k.id ORDER BY (k.status = 'cancelado'), k.data_fim DESC`, [id]) : vazio,
      // Cursos que as pessoas da empresa têm agora, por origem (licença, empresa, compra/individual)
      pool.query(
        `SELECT c.id, c.titulo,
                COUNT(DISTINCT d.usuario_id) FILTER (WHERE d.origem = 'beneficio')::int AS por_licenca,
                COUNT(DISTINCT d.usuario_id) FILTER (WHERE d.origem = 'liberacao')::int AS pela_empresa,
                COUNT(DISTINCT d.usuario_id) FILTER (WHERE d.origem IN ('compra', 'manual'))::int AS individual
         FROM direitos_acesso d JOIN cursos c ON c.id = d.curso_id JOIN usuarios u ON u.id = d.usuario_id
         WHERE u.cliente_id = $1 AND d.status = 'ativo' AND (d.fim IS NULL OR d.fim >= CURRENT_DATE)
         GROUP BY c.id, c.titulo ORDER BY c.titulo`, [id]),
      // Atividade recente: contratos, licenças, administradores e usuários da empresa
      admin ? pool.query(
        `SELECT a.acao, a.criado_em, a.antes, a.depois, a.detalhe, u.nome AS feito_por,
                CASE WHEN a.entidade = 'contrato' THEN (SELECT descricao FROM contratos WHERE id = a.entidade_id) END AS contrato_desc
         FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
         WHERE (a.entidade = 'contrato' AND a.entidade_id IN (SELECT id FROM contratos WHERE cliente_id = $1))
            OR (a.entidade = 'cliente' AND a.entidade_id = $1)
            OR (a.entidade = 'contrato_conector' AND a.entidade_id IN (SELECT id FROM contratos_conector WHERE cliente_id = $1))
            OR (a.entidade = 'vaga_conector' AND (COALESCE(a.depois, a.antes)->>'contrato_id')::int IN (SELECT id FROM contratos_conector WHERE cliente_id = $1))
            OR (a.entidade = 'usuario' AND a.entidade_id IN (SELECT id FROM usuarios WHERE cliente_id = $1))
         ORDER BY a.criado_em DESC, a.id DESC LIMIT 12`, [id]) : vazio,
      // Contratos de cursos para a empresa (cortesia, pagamento único ou recorrente)
      admin ? pool.query(
        `SELECT k.id, k.status, k.cobranca, k.valor::float AS valor,
                to_char(k.data_inicio, 'YYYY-MM-DD') AS data_inicio, to_char(k.data_fim, 'YYYY-MM-DD') AS data_fim,
                (k.status = 'ativo' AND (k.data_fim IS NULL OR k.data_fim >= CURRENT_DATE)) AS vigente,
                COALESCE((SELECT json_agg(c.titulo ORDER BY c.titulo) FROM cursos_liberacoes lb JOIN cursos c ON c.id = lb.curso_id
                            WHERE lb.contrato_cursos_id = k.id), '[]') AS cursos
         FROM contratos_cursos k WHERE k.cliente_id = $1 ORDER BY (k.status = 'ativo') DESC, k.id DESC`, [id]) : vazio
    ]);

    // Resumo financeiro do cliente (só admin)
    let financeiro = null;
    if (admin) {
      const f = (await pool.query(
        `SELECT COALESCE(SUM(valor) FILTER (WHERE status = 'ativo' AND periodicidade = 'mensal'), 0)::float AS mensal_contratado,
                COALESCE(SUM(valor) FILTER (WHERE status = 'ativo' AND periodicidade = 'anual'), 0)::float AS anual_contratado,
                (SELECT COALESCE(SUM(valor), 0) FROM faturas WHERE cliente_id = $1 AND status = 'aberta' AND data_vencimento < CURRENT_DATE)::float AS vencido,
                (SELECT COALESCE(SUM(valor_pago), 0) FROM faturas WHERE cliente_id = $1 AND status = 'paga'
                   AND data_pagamento >= CURRENT_DATE - INTERVAL '12 months')::float AS recebido_12m
         FROM contratos WHERE cliente_id = $1`, [id])).rows[0];
      financeiro = f;
    }

    res.json({
      cliente: c, admin, financeiro,
      usuarios: usuarios.rows, licencas: licencas.rows, cursos: cursos.rows, tecnologias: tecnologias.rows,
      chamados: { lista: chamados.rows, total: Number(chamados.rows[0]?.total || 0), abertos: Number(chamados.rows[0]?.abertos || 0) },
      contratos: contratos.rows, faturas: faturas.rows, oportunidades: oportunidades.rows,
      conector: conector.rows, cursos_acesso: cursosAcesso.rows, atividade: atividade.rows, contratos_cursos: contratosCursos.rows
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao montar a ficha do cliente', detalhe: err.message });
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
        "SELECT id FROM clientes WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g') AND empresa_id = $2 AND ativo = TRUE",
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
    if (req.body.email_financeiro !== undefined) {
      await pool.query('UPDATE clientes SET email_financeiro = $1 WHERE id = $2',
        [String(req.body.email_financeiro || '').trim() || null, result.rows[0].id]);
    }
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
        "SELECT id FROM clientes WHERE regexp_replace(cpf_cnpj, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g') AND empresa_id = $2 AND ativo IS NOT FALSE AND id != $3",
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
    // E-mail de cobrança; se o CPF/CNPJ mudou, o cliente é recriado no Asaas na próxima nota
    await pool.query(
      `UPDATE clientes SET
         email_financeiro = CASE WHEN $1::boolean THEN $2 ELSE email_financeiro END,
         asaas_customer_id = CASE WHEN cpf_cnpj IS DISTINCT FROM $3 THEN NULL ELSE asaas_customer_id END
       WHERE id = $4`,
      [req.body.email_financeiro !== undefined, String(req.body.email_financeiro || '').trim() || null, c.cpf_cnpj, req.params.id]);
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
