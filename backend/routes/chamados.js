const express = require('express');
const router = express.Router();
const pool = require('../db');
const { notificarNovoChamado, notificarAtualizacaoStatus, notificarNovoAtendimento } = require('../services/email');
const { calcularSla } = require('../services/sla');
const storage = require('../services/storage');
const sap = require('../services/sap');
const { condicaoProprios } = require('../middleware/chamados-do-aluno');

// Ordenação da listagem (?ordem=coluna&direcao=asc|desc). Lista fechada: nada do usuário entra cru no SQL.
const ORDENS_CHAMADOS = {
  id: 'ch.id',
  titulo: 'LOWER(ch.titulo)',
  cliente: 'LOWER(COALESCE(c.razao_social, c.nome))',
  tecnologia: 'LOWER(t.nome)',
  status: `CASE ch.status WHEN 'aberto' THEN 1 WHEN 'em_andamento' THEN 2 WHEN 'aguardando_cliente' THEN 3
           WHEN 'resolvido' THEN 4 WHEN 'fechado' THEN 5 ELSE 6 END`,
  prioridade: `CASE ch.prioridade WHEN 'critica' THEN 1 WHEN 'alta' THEN 2 WHEN 'media' THEN 3 WHEN 'baixa' THEN 4 ELSE 5 END`,
  abertura: 'ch.data_criacao'
};
function ordemChamados(ordem, direcao) {
  const col = ORDENS_CHAMADOS[ordem];
  if (!col) return 'ch.data_criacao DESC';
  return `${col} ${direcao === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ch.data_criacao DESC`;
}

const ehAdmin = tipo => tipo === 'admin_empresa' || tipo === 'admin_sistema';

// Colunas da listagem: tudo do chamado MENOS os textos grandes do Conector SAP (pedido/especificação)
// e os hashes de usuário/máquina — esses só no detalhe.
const COLUNAS_LISTA = `ch.id, ch.empresa_id, ch.cliente_id, ch.tecnologia_id, ch.aberto_por_usuario_id,
  ch.atribuido_para_usuario_id, ch.titulo, ch.descricao, ch.status, ch.prioridade, ch.categoria,
  ch.data_abertura, ch.data_fechamento, ch.ativo, ch.data_criacao, ch.atualizado_por_usuario_id, ch.data_atualizacao,
  ch.origem, ch.licenca_id, ch.sid, ch.modulo, ch.tipo_demanda, ch.objetos_sap, ch.solicitante_nome,
  ch.solicitante_email, ch.aprovacao_cliente, ch.aprovado_por_usuario_id, ch.data_aprovacao`;

const ROTULO_TIPO_DEMANDA = { melhoria: 'Melhoria', erro: 'Erro (correção)', nova_funcionalidade: 'Nova funcionalidade', duvida: 'Dúvida' };
const ROTULO_PRIORIDADE = { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' };
const ROTULO_STATUS = { aberto: 'Aberto', em_andamento: 'Em andamento', aguardando_cliente: 'Aguardando cliente', resolvido: 'Resolvido', fechado: 'Fechado' };
const ROTULO_APROVACAO = { pendente: 'Aguardando aprovação do cliente', aprovado: 'Aprovado', recusado: 'Recusado' };

const dataHoraBr = d => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '-');
const celulaMd = v => String(v ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'chamado';

/** Markdown do chamado do conector: cabeçalho (dados do chamado), objetos SAP, pedido original e especificação. */
function markdownEspecificacao(ch) {
  const objetos = Array.isArray(ch.objetos_sap) ? ch.objetos_sap : [];
  const solicitante = ch.solicitante_email ? `${ch.solicitante_nome} <${ch.solicitante_email}>` : ch.solicitante_nome;
  let aprovacao = ROTULO_APROVACAO[ch.aprovacao_cliente] || '-';
  if (ch.aprovacao_cliente === 'aprovado' || ch.aprovacao_cliente === 'recusado') {
    aprovacao += ` (${ch.aprovado_por_nome || '-'}, ${dataHoraBr(ch.data_aprovacao)})`;
  }
  return [
    `# Chamado #${ch.id} — ${ch.titulo}`,
    '',
    '| Campo | Valor |',
    '|---|---|',
    `| Cliente | ${celulaMd(ch.cliente_nome)} |`,
    `| Sistema SAP (SID) | ${celulaMd(ch.sid)} |`,
    `| Módulo | ${celulaMd(ch.modulo)} |`,
    `| Tipo | ${celulaMd(ROTULO_TIPO_DEMANDA[ch.tipo_demanda] || ch.tipo_demanda)} |`,
    `| Prioridade | ${celulaMd(ROTULO_PRIORIDADE[ch.prioridade] || ch.prioridade)} |`,
    `| Solicitante | ${celulaMd(solicitante)} |`,
    `| Aberto em | ${celulaMd(dataHoraBr(ch.data_abertura))} |`,
    `| Status | ${celulaMd(ROTULO_STATUS[ch.status] || ch.status)} |`,
    `| Aprovação do cliente | ${celulaMd(aprovacao)} |`,
    '',
    '## Objetos SAP',
    '',
    ...(objetos.length ? objetos.map(o => `- ${o.tipo} \`${o.nome}\``) : ['Nenhum objeto informado.']),
    '',
    '## Pedido original',
    '',
    ch.pedido_original || '-',
    '',
    '## Especificação',
    '',
    ch.especificacao || '_Sem especificação (dúvida)._',
    ''
  ].join('\n');
}

/** Chamado da empresa com o nome do cliente e de quem aprovou (null se não existe). */
async function buscarChamadoCompleto(id, empresa_id) {
  const r = await pool.query(
    `SELECT ch.*, COALESCE(c.razao_social, c.nome) AS cliente_nome, ua.nome AS aprovado_por_nome
     FROM chamados ch
     LEFT JOIN clientes c ON c.id = ch.cliente_id
     LEFT JOIN usuarios ua ON ua.id = ch.aprovado_por_usuario_id
     WHERE ch.id = $1 AND ch.empresa_id = $2 AND ch.ativo = TRUE`,
    [id, empresa_id]);
  return r.rows[0] || null;
}

// GET - Listar chamados (cliente vê só os seus; admin vê todos)
// Suporta: status, prioridade, cliente_id, busca (texto), data_de, data_ate, page, limit, ordem, direcao,
//          origem (conector | manual), aprovacao (pendente | aprovado | recusado)
router.get('/', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const usuario_id = req.usuario.id;
  const isCliente = req.usuario.tipo === 'cliente';
  const { status, prioridade, cliente_id, busca, data_de, data_ate, origem, aprovacao } = req.query;

  // Paginação (default: page=1, limit=50, max=200)
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    // whereParams contém apenas o que aparece no WHERE compartilhado entre COUNT e SELECT
    const whereParams = [empresa_id];
    let where = 'WHERE ch.empresa_id = $1 AND ch.ativo = TRUE';
    let idx = 2;

    // Cliente sem empresa vinculada não vê nada (cliente_id NULL nunca casa com chamado)
    if (isCliente) {
      where += ` AND ch.cliente_id = $${idx++}`;
      whereParams.push(req.usuario.cliente_id || null);
    }
    // Usuário de vaga do Conector: só os próprios chamados (middleware chamados-do-aluno)
    if (req.soProprios) { where += ` AND ${condicaoProprios(idx++)}`; whereParams.push(req.usuario.id); }
    if (status) { where += ` AND ch.status = $${idx++}`; whereParams.push(status); }
    if (prioridade) { where += ` AND ch.prioridade = $${idx++}`; whereParams.push(prioridade); }
    if (!isCliente && cliente_id) { where += ` AND ch.cliente_id = $${idx++}`; whereParams.push(cliente_id); }
    if (data_de) { where += ` AND ch.data_criacao >= $${idx++}::date`; whereParams.push(data_de); }
    if (data_ate) { where += ` AND ch.data_criacao < ($${idx++}::date + INTERVAL '1 day')`; whereParams.push(data_ate); }
    if (origem === 'conector') where += ` AND ch.origem = 'conector'`;
    if (origem === 'manual') where += ' AND ch.origem IS NULL';
    if (['pendente', 'aprovado', 'recusado'].includes(aprovacao)) {
      where += ` AND ch.aprovacao_cliente = $${idx++}`; whereParams.push(aprovacao);
    }
    if (busca && busca.trim()) {
      where += ` AND (ch.titulo ILIKE $${idx} OR ch.descricao ILIKE $${idx} OR CAST(ch.id AS TEXT) = $${idx + 1})`;
      whereParams.push(`%${busca.trim()}%`);
      whereParams.push(busca.trim());
      idx += 2;
    }

    // Conta total para paginação — só whereParams
    const totalResult = await pool.query(
      `SELECT COUNT(*) as total FROM chamados ch ${where}`,
      whereParams
    );
    const total = parseInt(totalResult.rows[0].total);

    // SELECT principal: depois dos filtros vêm usuario_id, limit, offset (nessa ordem)
    const usuarioIdx = idx;
    const limitIdx = idx + 1;
    const offsetIdx = idx + 2;
    const dadosParams = [...whereParams, usuario_id, limit, offset];

    const result = await pool.query(`
      SELECT ${COLUNAS_LISTA},
        COALESCE(c.razao_social, c.nome) as cliente_nome,
        t.nome as tecnologia_nome,
        u1.nome as aberto_por_nome,
        u2.nome as atribuido_para_nome,
        u3.nome as atualizado_por_nome,
        (SELECT COUNT(*) FROM atendimentos a WHERE a.chamado_id = ch.id) as total_atendimentos,
        (SELECT COUNT(*) FROM atendimentos a
          WHERE a.chamado_id = ch.id
            AND a.usuario_id IS DISTINCT FROM $${usuarioIdx}
            AND NOT EXISTS (
              SELECT 1 FROM atendimentos_lidos al
              WHERE al.atendimento_id = a.id AND al.usuario_id = $${usuarioIdx}
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
      ORDER BY ${ordemChamados(req.query.ordem, req.query.direcao)}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, dadosParams);

    // Anexa SLA computado em cada chamado
    const chamados = result.rows.map(ch => ({ ...ch, sla: calcularSla(ch) }));

    res.json({
      chamados,
      paginacao: { total, page, limit, total_paginas: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('[chamados GET /]', err);
    res.status(500).json({ erro: 'Erro ao buscar chamados', detalhe: err.message });
  }
});

// GET - Fila da fábrica ABAP: chamados do Conector SAP já aprovados pelo cliente e ainda em aberto,
// mais antigos primeiro, com a especificação. Só equipe Marsh. (Antes de /:id.)
router.get('/fila-conector', async (req, res) => {
  if (req.usuario.tipo === 'cliente') {
    return res.status(403).json({ erro: 'Acesso restrito à equipe Marsh.' });
  }
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const r = await pool.query(
      `SELECT ch.id, ch.titulo, ch.status, ch.prioridade, ch.cliente_id, COALESCE(c.razao_social, c.nome) AS cliente_nome,
              ch.sid, ch.modulo, ch.tipo_demanda, ch.objetos_sap, ch.solicitante_nome, ch.solicitante_email,
              ch.pedido_original, ch.especificacao, ch.aprovacao_cliente, ch.data_aprovacao, ua.nome AS aprovado_por_nome,
              ch.data_abertura, ch.atribuido_para_usuario_id, u2.nome AS atribuido_para_nome
       FROM chamados ch
       LEFT JOIN clientes c ON c.id = ch.cliente_id
       LEFT JOIN usuarios ua ON ua.id = ch.aprovado_por_usuario_id
       LEFT JOIN usuarios u2 ON u2.id = ch.atribuido_para_usuario_id
       WHERE ch.empresa_id = $1 AND ch.ativo = TRUE AND ch.origem = 'conector'
         AND ch.aprovacao_cliente = 'aprovado' AND ch.status IN ('aberto', 'em_andamento')
       ORDER BY ch.data_abertura ASC, ch.id ASC`,
      [empresa_id]);
    res.json(r.rows.map(ch => ({ ...ch, numero: `#${ch.id}`, sla: calcularSla(ch) })));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar a fila do conector', detalhe: err.message });
  }
});

// GET - Especificação do chamado do conector em markdown (download). Equipe Marsh ou o cliente dono.
router.get('/:id/especificacao.md', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const ch = await buscarChamadoCompleto(req.params.id, empresa_id);
    if (!ch || (req.usuario.tipo === 'cliente' && (!req.usuario.cliente_id || ch.cliente_id !== req.usuario.cliente_id))) {
      return res.status(404).json({ erro: 'Chamado não encontrado' });
    }
    if (ch.origem !== 'conector') {
      return res.status(404).json({ erro: 'Este chamado não foi aberto pelo Conector SAP: não tem especificação.' });
    }
    const nome = `chamado-${ch.id}-${slug(ch.titulo)}.md`;
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nome}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(markdownEspecificacao(ch));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gerar a especificação', detalhe: err.message });
  }
});

// POST - Aprovação do chamado do conector pelo gestor do cliente (ou pela Marsh em nome dele).
// { decisao: 'aprovado' | 'recusado', comentario } — só quando aprovacao_cliente = 'pendente'.
// Recusado fecha o chamado com o comentário.
router.post('/:id/aprovacao', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  const decisao = req.body?.decisao;
  const comentario = typeof req.body?.comentario === 'string' ? req.body.comentario.trim() : '';

  if (!isCliente && !ehAdmin(req.usuario.tipo)) {
    return res.status(403).json({ erro: 'Só o cliente (ou um administrador da Marsh) aprova chamados do conector.' });
  }
  if (!['aprovado', 'recusado'].includes(decisao)) {
    return res.status(400).json({ erro: 'decisao deve ser "aprovado" ou "recusado".' });
  }
  if (decisao === 'recusado' && !comentario) {
    return res.status(400).json({ erro: 'Informe o motivo da recusa.' });
  }
  if (comentario.length > 5000) return res.status(400).json({ erro: 'Comentário deve ter até 5.000 caracteres.' });

  try {
    const ch = await buscarChamadoCompleto(req.params.id, empresa_id);
    if (!ch) return res.status(404).json({ erro: 'Chamado não encontrado' });
    if (isCliente && (!req.usuario.cliente_id || ch.cliente_id !== req.usuario.cliente_id)) {
      return res.status(403).json({ erro: 'Este chamado é de outra empresa.' });
    }
    if (ch.origem !== 'conector' || ch.aprovacao_cliente !== 'pendente') {
      return res.status(409).json({ erro: 'Este chamado não está aguardando aprovação.' });
    }

    const nome = req.usuario.nome || (await pool.query('SELECT nome FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0]?.nome || 'usuário';
    // req.soProprios = usuário de vaga autorizado a aprovar os próprios chamados (chamados-do-aluno)
    const quem = !isCliente ? `pela Marsh em nome do cliente (${nome})`
      : req.soProprios ? `pelo cliente (${nome}, autorizado a aprovar os próprios chamados)` : `pelo gestor do cliente (${nome})`;
    const texto = decisao === 'aprovado'
      ? `Chamado aprovado ${quem}.${comentario ? `\n\n${comentario}` : ''}`
      : `Chamado recusado ${quem}: ${comentario}`;
    const statusNovo = decisao === 'recusado' ? 'fechado' : ch.status;

    const client = await pool.connect();
    let chamado, atendimento;
    try {
      await client.query('BEGIN');
      // A condição aprovacao_cliente = 'pendente' no UPDATE segura duas decisões simultâneas
      const up = await client.query(
        `UPDATE chamados SET aprovacao_cliente = $1, aprovado_por_usuario_id = $2, data_aprovacao = NOW(),
           status = $3, data_fechamento = CASE WHEN $6 THEN NOW() ELSE data_fechamento END,
           atualizado_por_usuario_id = $2, data_atualizacao = NOW()
         WHERE id = $4 AND empresa_id = $5 AND aprovacao_cliente = 'pendente'
         RETURNING *`,
        [decisao, req.usuario.id, statusNovo, ch.id, empresa_id, statusNovo === 'fechado']);
      if (!up.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ erro: 'Este chamado não está aguardando aprovação.' });
      }
      chamado = up.rows[0];
      atendimento = (await client.query(
        `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, data_atendimento)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [ch.id, req.usuario.id, decisao === 'aprovado' ? 'aprovacao' : 'recusa', texto])).rows[0];
      await client.query(
        `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ch.id, empresa_id, req.usuario.id, ch.status, statusNovo,
         decisao === 'aprovado' ? `Aprovado ${quem}` : `Recusado ${quem}: ${comentario}`]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    notificarNovoAtendimento({
      atendimento, chamado, remetente_tipo: req.usuario.tipo, remetente_nome: nome, empresa_id
    }).catch(() => {});

    res.json({
      mensagem: decisao === 'aprovado'
        ? 'Chamado aprovado: ele entrou na fila de desenvolvimento da Marsh.'
        : 'Chamado recusado e fechado.',
      chamado: { id: chamado.id, status: chamado.status, aprovacao_cliente: chamado.aprovacao_cliente, data_aprovacao: chamado.data_aprovacao }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar a aprovação', detalhe: err.message });
  }
});

// POST - Request SAP (ordem de transporte de workbench do DEV) do chamado do conector: { request } ex. UPDK955200.
// Cliente (do próprio chamado) ou equipe. Com a request informada, o agente ABAP prepara o desenvolvimento.
router.post('/:id/request', async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const isCliente = req.usuario.tipo === 'cliente';
  const request = String(req.body?.request || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3}K\d{6}$/.test(request)) {
    return res.status(400).json({ erro: 'Request inválida: use o número da SE09/SE10, ex.: UPDK955200.' });
  }
  try {
    const ch = await buscarChamadoCompleto(req.params.id, empresa_id);
    if (!ch) return res.status(404).json({ erro: 'Chamado não encontrado' });
    if (isCliente && (!req.usuario.cliente_id || ch.cliente_id !== req.usuario.cliente_id)) {
      return res.status(403).json({ erro: 'Este chamado é de outra empresa.' });
    }
    if (ch.origem !== 'conector') return res.status(409).json({ erro: 'Só chamados do Conector SAP recebem request.' });
    if (['resolvido', 'fechado'].includes(ch.status)) return res.status(409).json({ erro: 'Chamado encerrado.' });
    if (ch.request_sap === request) return res.json({ mensagem: 'Esta request já está no chamado.', request });

    const nome = req.usuario.nome || (await pool.query('SELECT nome FROM usuarios WHERE id = $1', [req.usuario.id])).rows[0]?.nome || 'usuário';
    const texto = ch.request_sap ? `Request SAP trocada de ${ch.request_sap} para ${request}.` : `Request SAP informada: ${request}.`;
    await pool.query(
      `UPDATE chamados SET request_sap = $1, request_sap_em = NOW(), request_sap_por_usuario_id = $2,
         atualizado_por_usuario_id = $2, data_atualizacao = NOW() WHERE id = $3`, [request, req.usuario.id, ch.id]);
    const atendimento = (await pool.query(
      `INSERT INTO atendimentos (chamado_id, usuario_id, tipo, descricao, data_atendimento)
       VALUES ($1, $2, 'atualizacao', $3, NOW()) RETURNING *`, [ch.id, req.usuario.id, texto])).rows[0];
    // Cliente informou: avisa a equipe. A equipe informando não manda e-mail ao cliente.
    if (isCliente) {
      notificarNovoAtendimento({ atendimento, chamado: ch, remetente_tipo: 'cliente', remetente_nome: nome, empresa_id }).catch(() => {});
    }
    res.json({ mensagem: `${texto} O desenvolvimento entra na fila do agente ABAP.`, request });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao gravar a request', detalhe: err.message });
  }
});

// GET /responsaveis — ABAP da equipe (admin/técnico ativos) que podem ser responsáveis pelo chamado, e o padrão
// da empresa. O responsável é, com quem abriu, o único que recebe e-mail do chamado.
router.get('/responsaveis', async (req, res) => {
  if (req.usuario.tipo === 'cliente') return res.status(403).json({ erro: 'Acesso restrito à equipe.' });
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const lista = (await pool.query(
      `SELECT id, nome, email FROM usuarios
        WHERE empresa_id = $1 AND tipo IN ('admin_empresa', 'tecnico') AND ativo = TRUE ORDER BY nome`, [empresa_id])).rows;
    const padrao = (await pool.query('SELECT abap_padrao_usuario_id FROM empresas WHERE id = $1', [empresa_id])).rows[0]?.abap_padrao_usuario_id || null;
    res.json({ responsaveis: lista, padrao_usuario_id: padrao });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar responsáveis', detalhe: err.message });
  }
});

// PUT /:id/responsavel { usuario_id, padrao } — troca o ABAP responsável pelo chamado. padrao = true (só
// administrador) também o define como responsável dos chamados novos da empresa.
router.put('/:id/responsavel', async (req, res) => {
  if (req.usuario.tipo === 'cliente') return res.status(403).json({ erro: 'Acesso restrito à equipe.' });
  const empresa_id = req.usuario.empresa_id || 1;
  const usuario_id = parseInt(req.body?.usuario_id) || null;
  const padrao = req.body?.padrao === true;
  if (!usuario_id) return res.status(400).json({ erro: 'Escolha o ABAP responsável.' });
  if (padrao && !['admin_empresa', 'admin_sistema'].includes(req.usuario.tipo)) {
    return res.status(403).json({ erro: 'Só administrador define o responsável padrão.' });
  }
  try {
    const abap = (await pool.query(
      `SELECT id, nome FROM usuarios WHERE id = $1 AND empresa_id = $2 AND tipo IN ('admin_empresa', 'tecnico') AND ativo = TRUE`,
      [usuario_id, empresa_id])).rows[0];
    if (!abap) return res.status(400).json({ erro: 'Usuário não é da equipe ou está inativo.' });
    const r = await pool.query(
      `UPDATE chamados SET atribuido_para_usuario_id = $1, atualizado_por_usuario_id = $2, data_atualizacao = NOW()
        WHERE id = $3 AND empresa_id = $4 AND ativo = TRUE RETURNING id`, [abap.id, req.usuario.id, req.params.id, empresa_id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Chamado não encontrado' });
    if (padrao) await pool.query('UPDATE empresas SET abap_padrao_usuario_id = $1 WHERE id = $2', [abap.id, empresa_id]);
    res.json({ mensagem: `Responsável: ${abap.nome}${padrao ? ' (também padrão dos chamados novos)' : ''}.` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao trocar o responsável', detalhe: err.message });
  }
});

// GET /sistemas-sap — servidores SAP que podem ser escolhidos no chamado (licenças ativas do Conector e contrato vigente) + listas SAP.
// Cliente: sempre os da própria empresa. Equipe: ?cliente_id=.
router.get('/sistemas-sap', async (req, res) => {
  const cliente_id = req.usuario.tipo === 'cliente' ? req.usuario.cliente_id : parseInt(req.query.cliente_id) || null;
  try {
    res.json({ sistemas: await sap.sistemasDoCliente(cliente_id, req.usuario.empresa_id || 1), modulos: sap.MODULOS, tipos: sap.TIPOS_DEMANDA });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar os servidores SAP', detalhe: err.message });
  }
});

// Confere servidor (SID), módulo e tipo do chamado. O servidor tem de ser um dos habilitados para o cliente
// (sap.sistemasDoCliente); para o cliente, escolher o servidor é obrigatório quando ele tem algum. Devolve { erro } ou os valores limpos.
async function validarSap({ sid, modulo, tipo_demanda }, cliente_id, empresa_id, { exigirSid }) {
  sid = String(sid || '').trim().toUpperCase() || null;
  modulo = String(modulo || '').trim().toUpperCase() || null;
  tipo_demanda = String(tipo_demanda || '').trim() || null;
  if (modulo && !sap.MODULOS.includes(modulo)) return { erro: 'Módulo SAP inválido.' };
  if (tipo_demanda && !sap.TIPOS_DEMANDA.includes(tipo_demanda)) return { erro: 'Tipo de chamado inválido.' };
  const sistemas = await sap.sistemasDoCliente(cliente_id, empresa_id);
  if (sid && !sistemas.some(s => s.sid === sid)) {
    return { erro: `O servidor ${sid} não está habilitado nas licenças ativas do Conector desta empresa.` };
  }
  if (!sid && exigirSid && sistemas.length) return { erro: 'Informe em qual servidor SAP o problema acontece.' };
  return { sid, modulo, tipo_demanda };
}

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
        u3.nome as atualizado_por_nome,
        ua.nome as aprovado_por_nome,
        (SELECT la.nome_maquina FROM licencas_ativacoes la
          WHERE la.licenca_id = ch.licenca_id AND la.maquina_hash = ch.maquina_hash) as maquina_nome
       FROM chamados ch
       LEFT JOIN clientes c ON c.id = ch.cliente_id
       LEFT JOIN tecnologias t ON t.id = ch.tecnologia_id
       LEFT JOIN usuarios u1 ON u1.id = ch.aberto_por_usuario_id
       LEFT JOIN usuarios u2 ON u2.id = ch.atribuido_para_usuario_id
       LEFT JOIN usuarios u3 ON u3.id = ch.atualizado_por_usuario_id
       LEFT JOIN usuarios ua ON ua.id = ch.aprovado_por_usuario_id
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
    // Portal: sem os hashes do usuário/máquina e sem a ligação interna com a licença
    if (isCliente) {
      delete chamado.usuario_hash;
      delete chamado.maquina_hash;
      delete chamado.maquina_nome;
      delete chamado.licenca_id;
    }

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

    // Anexos — gera preview_url (presigned) para arquivos do tipo imagem
    const anexos = await pool.query(`
      SELECT a.id, a.nome_original, a.tamanho_bytes, a.mime_type, a.data_upload, a.storage_key,
        u.nome as enviado_por_nome
      FROM chamados_anexos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.chamado_id = $1
      ORDER BY a.data_upload ASC
    `, [req.params.id]);
    chamado.anexos = await Promise.all(anexos.rows.map(async (a) => {
      const out = {
        id: a.id,
        nome_original: a.nome_original,
        tamanho_bytes: a.tamanho_bytes,
        mime_type: a.mime_type,
        data_upload: a.data_upload,
        enviado_por_nome: a.enviado_por_nome
      };
      const ehImagem = a.mime_type && a.mime_type.startsWith('image/');
      if (ehImagem && storage.disponivel) {
        try {
          out.preview_url = await storage.getDownloadUrl(a.storage_key);
        } catch { /* ignora — front cai no fluxo de Baixar */ }
      }
      return out;
    }));

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
    console.error('[chamados GET /:id]', err);
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
    const s = await validarSap(req.body, cliente_id, empresa_id, { exigirSid: isCliente });
    if (s.erro) return res.status(400).json({ erro: s.erro });
    const result = await pool.query(
      // Sem responsável informado, o chamado nasce com o ABAP responsável padrão da empresa
      `INSERT INTO chamados (
        empresa_id, cliente_id, tecnologia_id,
        aberto_por_usuario_id, atribuido_para_usuario_id,
        titulo, descricao, prioridade, categoria, status, ativo,
        sid, modulo, tipo_demanda
      ) VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT abap_padrao_usuario_id FROM empresas WHERE id = $1)),
        $6, $7, $8, $9, 'aberto', TRUE, $10, $11, $12)
      RETURNING *`,
      [
        empresa_id, cliente_id || null, tecnologia_id || null,
        usuario_id, (!isCliente && atribuido_para_usuario_id) || null,
        titulo, descricao || null,
        prioridade || 'media', categoria || null,
        s.sid, s.modulo, s.tipo_demanda
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

    // Servidor/módulo/tipo SAP: só mexe no que veio no corpo; o servidor só é conferido se mudou
    // (um chamado antigo continua com o SID dele mesmo que o contrato tenha vencido)
    const b = req.body;
    const sidNovo = 'sid' in b ? (String(b.sid || '').trim().toUpperCase() || null) : ch.sid;
    const s = await validarSap({
      sid: sidNovo !== ch.sid ? sidNovo : null,
      modulo: 'modulo' in b ? b.modulo : ch.modulo,
      tipo_demanda: 'tipo_demanda' in b ? b.tipo_demanda : ch.tipo_demanda
    }, cliente_id || ch.cliente_id, empresa_id, { exigirSid: false });
    if (s.erro) return res.status(400).json({ erro: s.erro });

    const result = await pool.query(
      `UPDATE chamados SET
        titulo=$1, descricao=$2, status=$3, prioridade=$4, categoria=$5,
        cliente_id=$6, tecnologia_id=$7, atribuido_para_usuario_id=$8,
        data_fechamento=$9,
        atualizado_por_usuario_id=$10, data_atualizacao=NOW(),
        sid=$13, modulo=$14, tipo_demanda=$15
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
        req.params.id, empresa_id,
        sidNovo, s.modulo, s.tipo_demanda
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
