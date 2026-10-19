const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const senhas = require('../services/senhas');
const emailSvc = require('../services/email');
const auditoria = require('../services/auditoria');

// Middleware: apenas admin_empresa e admin_sistema podem gerenciar usuários
// Se tipo não veio no JWT (token antigo), assume admin_empresa
function apenasAdmin(req, res, next) {
  const tipo = req.usuario.tipo;
  if (tipo && tipo !== 'admin_empresa' && tipo !== 'admin_sistema') {
    return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
  }
  next();
}

const TEMAS_VALIDOS = ['sereno', 'sereno-escuro', 'dark', 'light', 'enterprise'];

// GET /api/usuarios/me — perfil + preferências do usuário logado
router.get('/me', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, nome, email, tipo, cliente_id, empresa_id, tema FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar perfil', detalhe: err.message });
  }
});

// PUT /api/usuarios/me/tema — qualquer usuário logado altera o próprio tema
router.put('/me/tema', async (req, res) => {
  const { tema } = req.body || {};
  if (!TEMAS_VALIDOS.includes(tema)) {
    return res.status(400).json({ erro: `Tema inválido. Use: ${TEMAS_VALIDOS.join(', ')}` });
  }
  try {
    await pool.query('UPDATE usuarios SET tema = $1 WHERE id = $2', [tema, req.usuario.id]);
    res.json({ tema });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar tema', detalhe: err.message });
  }
});

// PUT /api/usuarios/me/senha { senha_atual, nova_senha } — qualquer usuário logado troca a própria senha
router.put('/me/senha', async (req, res) => {
  const { senha_atual, nova_senha } = req.body || {};
  const erro = senhas.validarSenha(nova_senha);
  if (erro) return res.status(400).json({ erro });
  try {
    const u = (await pool.query('SELECT senha FROM usuarios WHERE id = $1 AND ativo = TRUE', [req.usuario.id])).rows[0];
    if (!u || !(await bcrypt.compare(String(senha_atual || ''), u.senha))) return res.status(400).json({ erro: 'Senha atual incorreta.' });
    await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [await bcrypt.hash(nova_senha, 10), req.usuario.id]);
    res.json({ mensagem: 'Senha alterada!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao alterar senha', detalhe: err.message });
  }
});

// GET - Listar usuários da empresa
router.get('/', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const result = await pool.query(
      `SELECT u.id, u.nome, u.email, u.tipo, u.ativo, u.data_criacao,
              u.cliente_id,
              COALESCE(c.razao_social, c.nome) as cliente_nome
       FROM usuarios u
       LEFT JOIN clientes c ON c.id = u.cliente_id
       WHERE u.empresa_id = $1
       ORDER BY u.tipo ASC, u.nome ASC`,
      [empresa_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar usuários', detalhe: err.message });
  }
});

// POST - Criar novo usuário (admin cria para cliente ou técnico)
router.post('/', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, senha, tipo, cliente_id } = req.body;
  const email = String(req.body.email || '').trim();
  const convite = !!req.body.enviar_convite; // convite: o próprio usuário cria a senha pelo link do e-mail

  if (!nome || !email || (!convite && !senha)) {
    return res.status(400).json({ erro: convite ? 'Nome e e-mail são obrigatórios' : 'Nome, email e senha são obrigatórios' });
  }

  if (!tipo) {
    return res.status(400).json({ erro: 'Tipo de usuário é obrigatório' });
  }

  const tiposValidos = ['admin_empresa', 'tecnico', 'cliente'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({ erro: `Tipo inválido. Use: ${tiposValidos.join(', ')}` });
  }

  if (tipo === 'cliente' && !cliente_id) {
    return res.status(400).json({ erro: 'Usuário do tipo cliente deve estar vinculado a um cliente' });
  }

  if (!convite) {
    const erroSenha = senhas.validarSenha(senha);
    if (erroSenha) return res.status(400).json({ erro: erroSenha });
  }

  try {
    const existe = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)', [email]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ erro: 'Email já cadastrado' });
    }

    // Se tipo=cliente, valida que o cliente pertence à empresa
    if (tipo === 'cliente' && cliente_id) {
      const clienteOk = await pool.query(
        'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo IS NOT FALSE',
        [cliente_id, empresa_id]
      );
      if (clienteOk.rows.length === 0) {
        return res.status(400).json({ erro: 'Cliente não encontrado nesta empresa' });
      }
    }

    const hash = convite ? await senhas.senhaProvisoria() : await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO usuarios (nome, email, senha, empresa_id, tipo, cliente_id, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, nome, email, tipo, cliente_id, ativo, data_criacao`,
      [nome, email, hash, empresa_id, tipo, tipo === 'cliente' ? cliente_id : null]
    );

    if (convite) {
      const { enviado } = await senhas.enviarLink(result.rows[0], 'convite');
      return res.status(201).json({
        mensagem: enviado ? `Usuário criado! Convite enviado para ${email} (o link vale ${senhas.PRAZO_H.convite} horas).`
          : 'Usuário criado, mas o convite não pôde ser enviado (e-mail desligado?). Use "Reenviar convite" ou defina uma senha.',
        usuario: result.rows[0], convite_enviado: enviado
      });
    }
    // Sem convite: avisa a pessoa que a conta existe (a senha não vai no e-mail)
    const boasVindas = await emailSvc.enviarBoasVindas(result.rows[0]).catch(() => false);
    res.status(201).json({
      mensagem: boasVindas ? `Usuário criado! E-mail de boas-vindas enviado para ${result.rows[0].email} (sem a senha: passe a senha à pessoa).`
        : 'Usuário criado com sucesso! (o e-mail de boas-vindas não pôde ser enviado)',
      usuario: result.rows[0], boas_vindas_enviado: boasVindas
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar usuário', detalhe: err.message });
  }
});

// PUT - Atualizar usuário (nome, tipo, cliente_id, ativo)
router.put('/:id', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nome, tipo, cliente_id, ativo } = req.body;

  try {
    const atual = await pool.query(
      'SELECT * FROM usuarios WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (atual.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const u = atual.rows[0];

    // Não deixa revogar o próprio acesso de admin
    if (parseInt(req.params.id) === req.usuario.id && ativo === false) {
      return res.status(400).json({ erro: 'Você não pode desativar sua própria conta' });
    }

    // Mudou tipo ou empresa: encerra as sessões abertas (o token antigo carregava os dados velhos)
    const result = await pool.query(
      `UPDATE usuarios SET nome=$1, tipo=$2::varchar, cliente_id=$3::int, ativo=$4,
              sessao_versao = sessao_versao + CASE WHEN tipo IS DISTINCT FROM $2::varchar OR cliente_id IS DISTINCT FROM $3::int THEN 1 ELSE 0 END
       WHERE id=$5 AND empresa_id=$6
       RETURNING id, nome, email, tipo, cliente_id, ativo`,
      [
        nome || u.nome,
        tipo || u.tipo,
        // Sem "tipo" no corpo (ex.: só reativar), mantém a empresa vinculada
        (tipo || u.tipo) === 'cliente' ? (cliente_id || u.cliente_id) : null,
        ativo !== undefined ? ativo : u.ativo,
        req.params.id,
        empresa_id
      ]
    );
    const novo = result.rows[0];
    await auditoria.registrar({
      empresa_id, usuario_id: req.usuario.id, acao: 'usuario.alterado', entidade: 'usuario', entidade_id: novo.id,
      antes: { nome: u.nome, tipo: u.tipo, cliente_id: u.cliente_id, ativo: u.ativo },
      depois: { nome: novo.nome, tipo: novo.tipo, cliente_id: novo.cliente_id, ativo: novo.ativo }
    });

    res.json({ mensagem: 'Usuário atualizado!', usuario: result.rows[0] });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar usuário', detalhe: err.message });
  }
});

// PUT - Resetar senha (admin redefine a senha de qualquer usuário da empresa)
router.put('/:id/senha', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const { nova_senha } = req.body;

  const erroSenha = senhas.validarSenha(nova_senha);
  if (erroSenha) return res.status(400).json({ erro: erroSenha });

  try {
    const check = await pool.query(
      'SELECT id FROM usuarios WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresa_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const hash = await bcrypt.hash(nova_senha, 10);
    // Senha redefinida pelo admin: derruba as sessões abertas do usuário
    await pool.query('UPDATE usuarios SET senha = $1, sessao_versao = sessao_versao + 1 WHERE id = $2', [hash, req.params.id]);
    await auditoria.registrar({ empresa_id, usuario_id: req.usuario.id, acao: 'usuario.senha_redefinida', entidade: 'usuario', entidade_id: Number(req.params.id) });

    res.json({ mensagem: 'Senha redefinida com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao redefinir senha', detalhe: err.message });
  }
});

// DELETE - Desativar usuário (soft delete)
// POST /:id/convite — (re)envia o link para o usuário criar/redefinir a própria senha
router.post('/:id/convite', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  try {
    const u = (await pool.query('SELECT id, nome, email, ativo FROM usuarios WHERE id = $1 AND empresa_id = $2', [req.params.id, empresa_id])).rows[0];
    if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (!u.ativo) return res.status(400).json({ erro: 'Reative o usuário antes de enviar o convite.' });
    const { enviado } = await senhas.enviarLink(u, 'convite');
    if (!enviado) return res.status(400).json({ erro: 'Não foi possível enviar: envio de e-mail desligado ou falhou (veja Sistema → Alertas).' });
    res.json({ mensagem: `Link enviado para ${u.email} (vale ${senhas.PRAZO_H.convite} horas).` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao enviar convite', detalhe: err.message });
  }
});

// POST /:id/simular — o administrador entra como o usuário para ver o que ele vê (Simulador de acesso).
// Gera um token curto (1 h) do usuário alvo marcado com simulado_por: o middleware autenticar deixa só ler
// (GET) e confere a cada requisição se o administrador continua ativo. Fica registrado na auditoria.
// Hierarquia: administrador comum não simula Admin Sistema; ninguém simula o super usuário.
router.post('/:id/simular', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const id = parseInt(req.params.id);
  if (id === req.usuario.id) return res.status(400).json({ erro: 'Você já está no seu próprio acesso.' });
  try {
    const admin = (await pool.query('SELECT id, nome, tipo, super_usuario FROM usuarios WHERE id = $1 AND ativo = TRUE', [req.usuario.id])).rows[0];
    if (!admin) return res.status(403).json({ erro: 'Acesso restrito a administradores.' });
    const alvo = (await pool.query(
      `SELECT u.*, e.razao_social AS empresa_nome, e.nome_fantasia AS empresa_fantasia
       FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id
       WHERE u.id = $1 AND u.empresa_id = $2`, [id, empresa_id])).rows[0];
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (alvo.ativo === false) return res.status(400).json({ erro: 'Usuário desativado: reative para simular o acesso dele.' });
    if (alvo.super_usuario) return res.status(403).json({ erro: 'O acesso do super usuário não pode ser simulado.' });
    if (alvo.tipo === 'admin_sistema' && admin.tipo !== 'admin_sistema' && !admin.super_usuario) {
      return res.status(403).json({ erro: 'Só um Admin Sistema pode simular outro Admin Sistema.' });
    }

    const tipo = alvo.tipo || 'admin_empresa';
    const payload = {
      id: alvo.id, nome: alvo.nome, email: alvo.email, empresa_id: alvo.empresa_id || 1, tipo,
      cliente_id: alvo.cliente_id || null, sv: alvo.sessao_versao || 0,
      simulado_por: admin.id
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
    await auditoria.registrar({ empresa_id, usuario_id: admin.id, acao: 'simular_acesso', entidade: 'usuario', entidade_id: alvo.id,
      detalhe: `${admin.nome} simulou o acesso de ${alvo.nome} (${alvo.email})` });
    res.json({
      token,
      usuario: {
        id: alvo.id, nome: alvo.nome, email: alvo.email, empresa_id: alvo.empresa_id || 1, tipo,
        cliente_id: alvo.cliente_id || null,
        empresa_nome: alvo.empresa_fantasia || alvo.empresa_nome || 'Marsh Consultoria',
        tema: alvo.tema || 'sereno',
        simulado_por: admin.id, simulado_por_nome: admin.nome
      }
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao simular o acesso', detalhe: err.message });
  }
});

// Não deixa a empresa sem nenhum administrador ativo
async function ehUltimoAdmin(id, empresa_id) {
  const r = await pool.query(
    `SELECT tipo, (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $2 AND ativo AND tipo IN ('admin_empresa','admin_sistema') AND id <> $1)::int AS outros
     FROM usuarios WHERE id = $1 AND empresa_id = $2`, [id, empresa_id]);
  const u = r.rows[0];
  return !!u && ['admin_empresa', 'admin_sistema'].includes(u.tipo) && u.outros === 0;
}

// DELETE /:id/definitivo — apaga de verdade, só se o usuário não tem histórico (chamados, comentários, etc.).
// Com histórico, fica desativado: apagar deixaria chamados e comentários sem autor.
router.delete('/:id/definitivo', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;
  const id = parseInt(req.params.id);
  if (id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode excluir a sua própria conta.' });
  const client = await pool.connect();
  try {
    const alvo = (await client.query('SELECT id, nome, tipo FROM usuarios WHERE id = $1 AND empresa_id = $2', [id, empresa_id])).rows[0];
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (alvo.tipo === 'admin_sistema' && req.usuario.tipo !== 'admin_sistema') {
      return res.status(403).json({ erro: 'Só um Admin Sistema pode excluir outro Admin Sistema.' });
    }
    if (await ehUltimoAdmin(id, empresa_id)) return res.status(400).json({ erro: 'Este é o último administrador ativo: cadastre outro antes de excluí-lo.' });

    const hist = (await client.query(
      `SELECT (SELECT COUNT(*) FROM chamados WHERE aberto_por_usuario_id = $1 OR atribuido_para_usuario_id = $1)::int AS chamados,
              (SELECT COUNT(*) FROM atendimentos WHERE usuario_id = $1)::int AS comentarios,
              (SELECT COUNT(*) FROM chamados_status_log WHERE usuario_id = $1)::int AS mudancas,
              (SELECT COUNT(*) FROM chamados_anexos WHERE usuario_id = $1)::int AS anexos,
              (SELECT COUNT(*) FROM chamados_avaliacao WHERE usuario_id = $1)::int AS avaliacoes,
              (SELECT COUNT(*) FROM oportunidades_historico WHERE usuario_id = $1)::int AS notas,
              (SELECT COUNT(*) FROM contratos_conector WHERE gestor_usuario_id = $1)::int AS gestor,
              (SELECT COUNT(*) FROM certificados WHERE usuario_id = $1)::int AS certificados,
              (SELECT COUNT(*) FROM licencas WHERE usuario_id = $1)::int AS licencas,
              (SELECT COUNT(*) FROM pedidos WHERE usuario_id = $1)::int AS pedidos`, [id])).rows[0];
    const partes = [
      hist.chamados && `${hist.chamados} chamado(s)`, hist.comentarios && `${hist.comentarios} comentário(s)`,
      hist.mudancas && `${hist.mudancas} mudança(s) de status`, hist.anexos && `${hist.anexos} anexo(s)`,
      hist.avaliacoes && `${hist.avaliacoes} avaliação(ões)`, hist.notas && `${hist.notas} registro(s) no funil`,
      hist.gestor && `gestor de ${hist.gestor} contrato(s) do Conector`, hist.certificados && `${hist.certificados} certificado(s)`,
      hist.licencas && `${hist.licencas} licença(s) do Conector emitida(s)`, hist.pedidos && `${hist.pedidos} compra(s) na loja`
    ].filter(Boolean);
    const desativar = async (motivo) => {
      await client.query('UPDATE usuarios SET ativo = FALSE WHERE id = $1', [id]);
      return res.status(409).json({
        erro: `${alvo.nome} tem histórico no sistema (${motivo}) e não pode ser apagado sem quebrar esse histórico. Ele foi desativado: não acessa mais o sistema.`,
        desativado: true
      });
    };
    if (partes.length) return desativar(partes.join(', '));
    await client.query('BEGIN');
    // Vagas que a pessoa ocupa (ou convite pendente) voltam a ficar livres para outra pessoa
    const vagas = (await client.query(
      `UPDATE contratos_conector_vagas SET usuario_id = NULL, data_atribuicao = NULL, estado = 'livre', convidado_em = NULL
       WHERE usuario_id = $1 RETURNING id, contrato_id, perfil`, [id])).rows;
    const vagasCursos = (await client.query(
      `UPDATE contratos_cursos_vagas SET usuario_id = NULL, data_atribuicao = NULL, estado = 'livre', convidado_em = NULL
       WHERE usuario_id = $1 RETURNING id, contrato_id`, [id])).rows;
    await client.query('DELETE FROM cursos_progresso WHERE usuario_id = $1', [id]);
    await client.query('DELETE FROM atendimentos_lidos WHERE usuario_id = $1', [id]);
    try {
      await client.query('SAVEPOINT apagar');
      await client.query('DELETE FROM usuarios WHERE id = $1', [id]);
    } catch (err) {
      // Outra ligação no banco que o sistema ainda não conhece: não apaga, desativa
      if (err.code !== '23503') throw err;
      await client.query('ROLLBACK');
      return desativar(`ligado a ${err.table || 'outro registro'}`);
    }
    for (const v of vagas) {
      await auditoria.registrar({ empresa_id, usuario_id: req.usuario.id, acao: 'vaga.liberada', entidade: 'vaga_conector', entidade_id: v.id,
        antes: { contrato_id: v.contrato_id, perfil: v.perfil, usuario_id: id }, detalhe: 'Usuário excluído' }, client);
    }
    for (const v of vagasCursos) {
      await auditoria.registrar({ empresa_id, usuario_id: req.usuario.id, acao: 'vaga.liberada', entidade: 'vaga_cursos', entidade_id: v.id,
        antes: { contrato_cursos_id: v.contrato_id, usuario_id: id }, detalhe: 'Usuário excluído' }, client);
    }
    await client.query('COMMIT');
    await auditoria.registrar({ empresa_id, usuario_id: req.usuario.id, acao: 'usuario.excluido', entidade: 'usuario', entidade_id: id, antes: { nome: alvo.nome, tipo: alvo.tipo } });
    const livres = vagas.length + vagasCursos.length;
    res.json({ mensagem: `Usuário ${alvo.nome} excluído.${livres ? ` ${livres} vaga(s) que ele ocupava ficaram livres.` : ''}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ erro: 'Erro ao excluir usuário', detalhe: err.message });
  } finally { client.release(); }
});

router.delete('/:id', apenasAdmin, async (req, res) => {
  const empresa_id = req.usuario.empresa_id || 1;

  if (parseInt(req.params.id) === req.usuario.id) {
    return res.status(400).json({ erro: 'Você não pode desativar sua própria conta' });
  }

  try {
    if (await ehUltimoAdmin(parseInt(req.params.id), empresa_id)) {
      return res.status(400).json({ erro: 'Este é o último administrador ativo: cadastre outro antes de desativá-lo.' });
    }
    const result = await pool.query(
      'UPDATE usuarios SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING id, nome',
      [req.params.id, empresa_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }
    await auditoria.registrar({ empresa_id, usuario_id: req.usuario.id, acao: 'usuario.desativado', entidade: 'usuario', entidade_id: result.rows[0].id });
    res.json({ mensagem: `Usuário ${result.rows[0].nome} desativado.` });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao desativar usuário', detalhe: err.message });
  }
});

module.exports = router;
