/**
 * /api/licencas-conector — rotas PÚBLICAS chamadas pelo conector Claude <-> SAP no cliente.
 * Autenticação = a própria chave da licença (MRSH-...). Com limite de requisições.
 *
 * POST /ativar       { chave, maquina_hash, nome_maquina, usuario_windows?, versao? }
 *                                                        -> dados da licença + conexões SAP (instalador)
 * POST /validar      { chave, sid, versao, usuario_hash, maquina_hash, nome_maquina? } -> licença assinada (Ed25519)
 * POST /uso          { chave, sid, usuario_hash, data, contadores: { ferramenta: {chamadas, recusas} } }
 * GET  /chave-publica                                    -> PEM para conferir a assinatura
 * POST /chamados          { chave, sid, usuario_hash, maquina_hash, titulo, tipo, modulo, pedido, especificacao, ... }
 *                                                        -> abre chamado (ferramenta abrir_chamado do conector)
 * POST /chamados/listar   { chave, usuario_hash, maquina_hash, todos? } -> chamados do conector desta licença
 *
 * Nunca recebe código-fonte nem dados do SAP: só contadores, hash do usuário e identificação da máquina.
 * Exceção consciente: /chamados recebe o texto que o consultor do cliente aprovou enviar (pedido +
 * especificação em markdown + nomes dos objetos Z) — é o próprio conteúdo do chamado.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { PLANOS, VALIDADE_DIAS, hashChave, chavePublicaPem, assinar, listaSids, conexoesDosSids } = require('../services/licenca');
const { notificarNovoChamado } = require('../services/email');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' }
});
router.use(limiter);

const RE_HASH = /^[a-f0-9]{64}$/;
const RE_SID = /^[A-Z0-9]{3}$/;
const RE_FERRAMENTA = /^[a-z_]{1,50}$/;

async function buscarLicenca(chave) {
  if (!/^MRSH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(String(chave || '').trim())) return null;
  const r = await pool.query(
    `SELECT l.*, COALESCE(c.razao_social, c.nome) AS cliente_nome
     FROM licencas l JOIN clientes c ON c.id = l.cliente_id
     WHERE l.chave_hash = $1 AND l.ativo = TRUE`,
    [hashChave(chave)]
  );
  return r.rows[0] || null;
}

const negar = (res, motivo, erro) => res.status(403).json({ erro, motivo });
const dataIso = d => new Date(d).toISOString().slice(0, 10);

/** Status e vencimento (comuns a /ativar e /validar). Devolve [motivo, erro] ou null. */
function recusaContrato(l) {
  if (l.status !== 'ativa') return [l.status, `Licença ${l.status}. Fale com a Marsh Consultoria.`];
  const fim = dataIso(l.data_fim);
  if (fim < dataIso(new Date())) return ['vencida', `Licença vencida em ${fim}. Fale com a Marsh Consultoria.`];
  return null;
}

/** Campos da máquina vindos do corpo. Devolve { erro } ou { maquina }. */
function lerMaquina(body, nomeObrigatorio) {
  const maquina_hash = String(body?.maquina_hash || '').trim().toLowerCase();
  const nome_maquina = String(body?.nome_maquina || '').trim();
  const usuario_windows = String(body?.usuario_windows || '').trim();
  if (!RE_HASH.test(maquina_hash)) return { erro: 'maquina_hash deve ter 64 caracteres hexadecimais.' };
  if (nomeObrigatorio && !nome_maquina) return { erro: 'nome_maquina é obrigatório.' };
  if (nome_maquina.length > 100) return { erro: 'nome_maquina deve ter até 100 caracteres.' };
  if (usuario_windows.length > 100) return { erro: 'usuario_windows deve ter até 100 caracteres.' };
  return {
    maquina: {
      maquina_hash,
      nome_maquina: nome_maquina || null,
      usuario_windows: usuario_windows || null,
      versao: String(body?.versao || '').trim().slice(0, 30) || null
    }
  };
}

/**
 * Regra de máquina (usada por /ativar e /validar):
 * - máquina revogada nesta licença -> recusa 'maquina_revogada';
 * - máquina nova com o limite de máquinas não revogadas atingido -> recusa 'maquinas';
 * - senão grava/atualiza a ativação (nome, usuário, versão, última validação).
 * Roda numa transação com a linha da licença travada, para duas ativações simultâneas não furarem o limite.
 * Devolve [motivo, erro] ou null.
 */
async function registrarMaquina(l, m) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM licencas WHERE id = $1 FOR UPDATE', [l.id]);
    const atual = await client.query(
      'SELECT revogada FROM licencas_ativacoes WHERE licenca_id = $1 AND maquina_hash = $2',
      [l.id, m.maquina_hash]);
    if (atual.rows[0]?.revogada) {
      await client.query('ROLLBACK');
      return ['maquina_revogada', 'Esta máquina foi desativada nesta licença. Fale com a Marsh Consultoria.'];
    }
    if (!atual.rows.length && l.max_maquinas) {
      const n = (await client.query(
        'SELECT COUNT(*)::int AS n FROM licencas_ativacoes WHERE licenca_id = $1 AND revogada = FALSE',
        [l.id])).rows[0].n;
      if (n >= l.max_maquinas) {
        await client.query('ROLLBACK');
        return ['maquinas', `Limite de ${l.max_maquinas} máquina(s) da licença atingido. Fale com a Marsh Consultoria.`];
      }
    }
    await client.query(
      `INSERT INTO licencas_ativacoes (licenca_id, maquina_hash, nome_maquina, usuario_windows, versao_conector, ultima_validacao)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (licenca_id, maquina_hash) DO UPDATE SET
         nome_maquina = COALESCE(EXCLUDED.nome_maquina, licencas_ativacoes.nome_maquina),
         usuario_windows = COALESCE(EXCLUDED.usuario_windows, licencas_ativacoes.usuario_windows),
         versao_conector = COALESCE(EXCLUDED.versao_conector, licencas_ativacoes.versao_conector),
         ultima_validacao = NOW()`,
      [l.id, m.maquina_hash, m.nome_maquina, m.usuario_windows, m.versao]);
    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

router.get('/chave-publica', (req, res) => {
  const pem = chavePublicaPem();
  if (!pem) return res.status(503).json({ erro: 'Assinatura de licença não configurada no servidor.' });
  res.type('text/plain').send(pem);
});

// POST /ativar — chamado pelo instalador: registra a máquina e devolve o que ele pré-preenche
router.post('/ativar', async (req, res) => {
  const { erro, maquina } = lerMaquina(req.body, true);
  if (erro) return res.status(400).json({ erro });
  try {
    const l = await buscarLicenca(req.body?.chave);
    if (!l) return negar(res, 'chave', 'Licença inválida.');
    const recusa = recusaContrato(l) || await registrarMaquina(l, maquina);
    if (recusa) return negar(res, ...recusa);

    await pool.query(
      'UPDATE licencas SET ultima_validacao = NOW(), versao_conector = COALESCE($1, versao_conector) WHERE id = $2',
      [maquina.versao, l.id]);

    const sids = listaSids(l.sids);
    res.json({
      cliente: l.cliente_nome,
      titular_nome: l.titular_nome,
      titular_email: l.titular_email,
      plano: l.plano,
      permite_escrita: !!PLANOS[l.plano]?.permite_escrita,
      data_fim: dataIso(l.data_fim),
      sids,
      conexoes: conexoesDosSids(l.conexoes, sids),
      max_maquinas: l.max_maquinas
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao ativar licença', detalhe: err.message });
  }
});

router.post('/validar', async (req, res) => {
  const { chave, versao } = req.body || {};
  const sid = String(req.body?.sid || '').toUpperCase();
  const usuario_hash = String(req.body?.usuario_hash || '').toLowerCase();
  if (!RE_SID.test(sid) || !RE_HASH.test(usuario_hash)) {
    return res.status(400).json({ erro: 'sid e usuario_hash são obrigatórios.' });
  }
  // maquina_hash é obrigatório (conector 0.4.0+): sem ele o limite de máquinas e a revogação não valeriam
  const { erro: erroMaquina, maquina } = lerMaquina(req.body, false);
  if (erroMaquina) return res.status(400).json({ erro: 'Conector desatualizado: reinstale pelo portal da Marsh.' });
  try {
    const l = await buscarLicenca(chave);
    if (!l) return negar(res, 'chave', 'Licença inválida.');
    const recusa = recusaContrato(l);
    if (recusa) return negar(res, ...recusa);
    const fim = dataIso(l.data_fim);

    const sids = listaSids(l.sids);
    if (!sids.includes(sid)) return negar(res, 'sid', `Sistema ${sid} não está nesta licença (${sids.join(', ')}).`);

    if (l.max_usuarios) {
      const u = await pool.query(
        `SELECT COUNT(DISTINCT usuario_hash)::int AS n,
                BOOL_OR(usuario_hash = $2) AS ja_conta
         FROM licencas_uso WHERE licenca_id = $1 AND data >= CURRENT_DATE - 30`,
        [l.id, usuario_hash]);
      const { n, ja_conta } = u.rows[0];
      if (!ja_conta && n >= l.max_usuarios) {
        return negar(res, 'usuarios', `Limite de ${l.max_usuarios} usuários da licença atingido.`);
      }
    }

    const recusaMaquina = await registrarMaquina(l, maquina);
    if (recusaMaquina) return negar(res, ...recusaMaquina);

    await pool.query('UPDATE licencas SET ultima_validacao = NOW(), versao_conector = $1 WHERE id = $2',
      [String(versao || '').slice(0, 30) || null, l.id]);

    const agora = new Date();
    const fimContrato = new Date(`${fim}T23:59:59Z`);
    const expira = new Date(Math.min(agora.getTime() + VALIDADE_DIAS * 86400000, fimContrato.getTime()));
    const payload = {
      licenca_id: l.id,
      cliente: l.cliente_nome,
      plano: l.plano,
      permite_escrita: !!PLANOS[l.plano]?.permite_escrita,
      sids,
      max_usuarios: l.max_usuarios,
      contrato_ate: fim,
      sid,
      usuario_hash,
      // Sistemas SAP do próprio cliente: o conector recusa URL/mandante fora desta lista
      conexoes: conexoesDosSids(l.conexoes, sids).map(c => ({ sid: c.sid, url: c.url, mandante: c.mandante })),
      emitida_em: agora.toISOString(),
      expira_em: expira.toISOString(),
      // A licença assinada fica presa àquela máquina (cache copiado para outra não serve)
      maquina_hash: maquina.maquina_hash
    };
    try {
      res.json(assinar(payload));
    } catch (e) {
      res.status(503).json({ erro: 'Assinatura de licença não configurada no servidor.' });
    }
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao validar licença', detalhe: err.message });
  }
});

router.post('/uso', async (req, res) => {
  const { chave, contadores } = req.body || {};
  const sid = String(req.body?.sid || '').toUpperCase();
  const usuario_hash = String(req.body?.usuario_hash || '').toLowerCase();
  const data = String(req.body?.data || '');
  if (!RE_SID.test(sid) || !RE_HASH.test(usuario_hash) || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ erro: 'sid, usuario_hash e data (AAAA-MM-DD) são obrigatórios.' });
  }
  const dias = Math.abs(Date.now() - Date.parse(`${data}T12:00:00Z`)) / 86400000;
  if (!(dias <= 3)) return res.status(400).json({ erro: 'Data fora da janela aceita.' });
  const itens = Object.entries(contadores || {});
  if (!itens.length || itens.length > 50) return res.status(400).json({ erro: 'Contadores inválidos.' });

  try {
    const l = await buscarLicenca(chave);
    if (!l) return negar(res, 'chave', 'Licença inválida.');

    for (const [ferramenta, c] of itens) {
      const chamadas = Number(c?.chamadas) || 0;
      const recusas = Number(c?.recusas) || 0;
      if (!RE_FERRAMENTA.test(ferramenta) || chamadas < 0 || recusas < 0 ||
          chamadas > 100000 || recusas > 100000) continue;
      await pool.query(
        `INSERT INTO licencas_uso (licenca_id, data, sid, usuario_hash, ferramenta, chamadas, recusas)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (licenca_id, data, sid, usuario_hash, ferramenta)
         DO UPDATE SET chamadas = licencas_uso.chamadas + EXCLUDED.chamadas,
                       recusas  = licencas_uso.recusas  + EXCLUDED.recusas`,
        [l.id, data, sid, usuario_hash, ferramenta, Math.floor(chamadas), Math.floor(recusas)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar uso', detalhe: err.message });
  }
});

// ===== CHAMADOS PELO CONECTOR (ferramenta abrir_chamado) =====

const { TIPOS_DEMANDA, MODULOS } = require('../services/sap');
const PRIORIDADES = ['baixa', 'media', 'alta', 'critica'];
const RE_OBJETO = /^[A-Z0-9_/]+$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Teto de chamados por licença por hora (CONECTOR_CHAMADOS_POR_HORA só para teste/ajuste fino)
const CHAMADOS_POR_HORA = parseInt(process.env.CONECTOR_CHAMADOS_POR_HORA || '20', 10);

/** Texto do corpo: string (ou número) aparada; qualquer outra coisa vira null. */
const textoCorpo = v => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : null);

/**
 * Autenticação das rotas de chamado: chave válida, licença ativa e dentro da validade, SID da licença
 * (quando exigido) e máquina JÁ ativada pelo instalador e não revogada. Aqui nunca se ativa máquina nova.
 * Responde o erro e devolve null, ou devolve { l, sid, usuario_hash, maquina_hash, nome_maquina }.
 */
async function autenticarConector(req, res, exigirSid) {
  const b = req.body || {};
  const sid = String(b.sid || '').trim().toUpperCase();
  const usuario_hash = String(b.usuario_hash || '').trim().toLowerCase();
  const maquina_hash = String(b.maquina_hash || '').trim().toLowerCase();
  if (exigirSid && !RE_SID.test(sid)) { res.status(400).json({ erro: 'sid é obrigatório (3 letras/números, ex.: DEV).' }); return null; }
  if (!RE_HASH.test(usuario_hash)) { res.status(400).json({ erro: 'usuario_hash deve ter 64 caracteres hexadecimais.' }); return null; }
  if (!RE_HASH.test(maquina_hash)) { res.status(400).json({ erro: 'maquina_hash deve ter 64 caracteres hexadecimais.' }); return null; }

  const l = await buscarLicenca(b.chave);
  if (!l) { negar(res, 'chave', 'Licença inválida.'); return null; }
  const recusa = recusaContrato(l);
  if (recusa) { negar(res, ...recusa); return null; }
  if (exigirSid) {
    const sids = listaSids(l.sids);
    if (!sids.includes(sid)) { negar(res, 'sid', `Sistema ${sid} não está nesta licença (${sids.join(', ')}).`); return null; }
  }
  const m = await pool.query(
    'SELECT nome_maquina, revogada FROM licencas_ativacoes WHERE licenca_id = $1 AND maquina_hash = $2',
    [l.id, maquina_hash]);
  if (!m.rows.length) { negar(res, 'maquina', 'Máquina não ativada nesta licença. Rode o instalador.'); return null; }
  if (m.rows[0].revogada) {
    negar(res, 'maquina_revogada', 'Esta máquina foi desativada nesta licença. Fale com a Marsh Consultoria.');
    return null;
  }
  return { l, sid: exigirSid ? sid : null, usuario_hash, maquina_hash, nome_maquina: m.rows[0].nome_maquina };
}

/** Campos do chamado. Devolve { erro } ou { dados } já normalizados. */
function lerChamado(b) {
  const titulo = textoCorpo(b.titulo) || '';
  if (titulo.length < 5 || titulo.length > 200) return { erro: 'titulo é obrigatório, de 5 a 200 caracteres.' };

  const tipo = String(b.tipo || '').trim().toLowerCase();
  if (!TIPOS_DEMANDA.includes(tipo)) return { erro: `tipo inválido (${TIPOS_DEMANDA.join(', ')}).` };

  const modulo = String(b.modulo || '').trim().toUpperCase();
  if (!MODULOS.includes(modulo)) return { erro: `modulo inválido (${MODULOS.join(', ')}).` };

  const prioridade = b.prioridade === undefined || b.prioridade === null || b.prioridade === ''
    ? 'media' : String(b.prioridade).trim().toLowerCase();
  if (!PRIORIDADES.includes(prioridade)) return { erro: `prioridade inválida (${PRIORIDADES.join(', ')}).` };

  const pedido = textoCorpo(b.pedido) || '';
  if (!pedido) return { erro: 'pedido é obrigatório (o que o consultor pediu, com as palavras dele).' };
  if (pedido.length > 20000) return { erro: 'pedido deve ter até 20.000 caracteres.' };

  if (b.especificacao !== undefined && b.especificacao !== null && typeof b.especificacao !== 'string') {
    return { erro: 'especificacao deve ser texto (markdown).' };
  }
  const especificacao = (b.especificacao || '').trim();
  if (!especificacao && tipo !== 'duvida') return { erro: 'especificacao é obrigatória (exceto para tipo duvida).' };
  if (especificacao.length > 200000) return { erro: 'especificacao deve ter até 200.000 caracteres.' };

  let objetos = [];
  if (b.objetos !== undefined && b.objetos !== null) {
    if (!Array.isArray(b.objetos)) return { erro: 'objetos deve ser uma lista de { tipo, nome }.' };
    if (b.objetos.length > 100) return { erro: 'objetos: no máximo 100 itens.' };
    for (const [i, o] of b.objetos.entries()) {
      const ot = String(o?.tipo || '').trim().toUpperCase();
      const on = String(o?.nome || '').trim().toUpperCase();
      if (!ot || ot.length > 10 || !RE_OBJETO.test(ot)) {
        return { erro: `objetos[${i}].tipo inválido: até 10 caracteres A-Z, 0-9, _ ou / (ex.: PROG, CLAS).` };
      }
      if (!on || on.length > 60 || !RE_OBJETO.test(on)) {
        return { erro: `objetos[${i}].nome inválido: até 60 caracteres A-Z, 0-9, _ ou / (ex.: ZSDR0099).` };
      }
      objetos.push({ tipo: ot, nome: on });
    }
  }

  const solicitante_nome = textoCorpo(b.solicitante_nome) || '';
  if (!solicitante_nome) return { erro: 'solicitante_nome é obrigatório.' };
  if (solicitante_nome.length > 150) return { erro: 'solicitante_nome deve ter até 150 caracteres.' };
  const solicitante_email = textoCorpo(b.solicitante_email) || '';
  if (solicitante_email && !(RE_EMAIL.test(solicitante_email) && solicitante_email.length <= 150)) {
    return { erro: 'solicitante_email inválido.' };
  }
  const nome_maquina = textoCorpo(b.nome_maquina) || '';
  if (nome_maquina.length > 100) return { erro: 'nome_maquina deve ter até 100 caracteres.' };

  return {
    dados: { titulo, tipo, modulo, prioridade, pedido, especificacao: especificacao || null, objetos,
             solicitante_nome, solicitante_email: solicitante_email || null, nome_maquina: nome_maquina || null }
  };
}

/** Descrição curta do chamado (a especificação inteira fica na coluna própria). */
function descricaoCurta(pedido, temEspecificacao, sid) {
  const texto = pedido.length > 2000 ? `${pedido.slice(0, 2000)}…` : pedido;
  const rodape = temEspecificacao
    ? `Especificação anexa ao chamado (Conector SAP, sistema ${sid}).`
    : `Aberto pelo Conector SAP (sistema ${sid}).`;
  return `${texto}\n\n${rodape}`;
}

// POST /chamados — o consultor do cliente aprovou a especificação no Claude e o conector abre o chamado
router.post('/chamados', async (req, res) => {
  try {
    const auth = await autenticarConector(req, res, true);
    if (!auth) return;
    const { erro, dados: d } = lerChamado(req.body || {});
    if (erro) return res.status(400).json({ erro });
    const { l, sid } = auth;
    const nomeMaquina = d.nome_maquina || auth.nome_maquina || 'máquina sem nome';
    const aprovacao = l.chamados_exigem_aprovacao === false ? 'aprovado' : 'pendente';

    const client = await pool.connect();
    let chamado;
    try {
      await client.query('BEGIN');
      // Trava a licença: duas aberturas simultâneas não furam o limite por hora
      await client.query('SELECT id FROM licencas WHERE id = $1 FOR UPDATE', [l.id]);
      const n = (await client.query(
        `SELECT COUNT(*)::int AS n FROM chamados
         WHERE licenca_id = $1 AND origem = 'conector' AND data_criacao >= NOW() - INTERVAL '1 hour'`,
        [l.id])).rows[0].n;
      if (n >= CHAMADOS_POR_HORA) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          erro: `Limite de ${CHAMADOS_POR_HORA} chamados por hora desta licença atingido. Tente mais tarde ou fale com a Marsh Consultoria.`,
          motivo: 'limite_chamados'
        });
      }
      const r = await client.query(
        `INSERT INTO chamados (
           empresa_id, cliente_id, aberto_por_usuario_id, titulo, descricao, prioridade, categoria, status, ativo,
           origem, licenca_id, sid, modulo, tipo_demanda, pedido_original, especificacao, objetos_sap,
           solicitante_nome, solicitante_email, usuario_hash, maquina_hash, aprovacao_cliente
         ) VALUES ($1, $2, NULL, $3, $4, $5, 'Conector SAP', 'aberto', TRUE,
           'conector', $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17)
         RETURNING *`,
        [l.empresa_id || 1, l.cliente_id, d.titulo, descricaoCurta(d.pedido, !!d.especificacao, sid), d.prioridade,
         l.id, sid, d.modulo, d.tipo, d.pedido, d.especificacao, JSON.stringify(d.objetos),
         d.solicitante_nome, d.solicitante_email, auth.usuario_hash, auth.maquina_hash, aprovacao]);
      chamado = r.rows[0];
      await client.query(
        `INSERT INTO chamados_status_log (chamado_id, empresa_id, usuario_id, status_anterior, status_novo, observacao)
         VALUES ($1, $2, NULL, NULL, 'aberto', $3)`,
        [chamado.id, chamado.empresa_id,
         `Chamado aberto pelo Conector SAP (${nomeMaquina}, ${sid}) por ${d.solicitante_nome}` +
         (aprovacao === 'pendente' ? ' — aguardando aprovação do gestor do cliente' : '')]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    notificarNovoChamado({
      chamado,
      empresa_id: chamado.empresa_id,
      aberto_por: `${d.solicitante_nome} (Conector SAP, ${l.cliente_nome})`
    }).catch(() => {});

    res.status(201).json({
      id: chamado.id,
      numero: `#${chamado.id}`,
      status: chamado.status,
      aprovacao_cliente: chamado.aprovacao_cliente,
      mensagem: aprovacao === 'pendente'
        ? `Chamado #${chamado.id} aberto. Ele aguarda a aprovação do gestor de ${l.cliente_nome} no portal da Marsh antes de entrar na fila de desenvolvimento.`
        : `Chamado #${chamado.id} aberto e liberado para a equipe da Marsh Consultoria.`
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao abrir chamado', detalhe: err.message });
  }
});

// POST /chamados/listar — chamados do conector desta licença (só os do usuário, salvo todos: true)
router.post('/chamados/listar', async (req, res) => {
  try {
    const auth = await autenticarConector(req, res, false);
    if (!auth) return;
    const todos = req.body?.todos === true;
    const params = [auth.l.id];
    let filtroUsuario = '';
    if (!todos) { filtroUsuario = 'AND ch.usuario_hash = $2'; params.push(auth.usuario_hash); }
    // A timeline (atendimentos) é toda visível ao cliente no portal: não há comentário interno.
    // O histórico de status (chamados_status_log) é interno e não sai daqui.
    const r = await pool.query(
      `SELECT ch.id, ch.titulo, ch.status, ch.aprovacao_cliente, ch.prioridade, ch.modulo, ch.sid,
              ch.data_abertura,
              GREATEST(ch.data_abertura, ch.data_atualizacao, ch.data_aprovacao, ch.data_fechamento,
                       (SELECT MAX(a.data_atendimento) FROM atendimentos a WHERE a.chamado_id = ch.id)) AS ultima_atualizacao,
              (SELECT a.descricao FROM atendimentos a WHERE a.chamado_id = ch.id
                ORDER BY a.data_atendimento DESC, a.id DESC LIMIT 1) AS ultimo_comentario
       FROM chamados ch
       WHERE ch.licenca_id = $1 AND ch.origem = 'conector' AND ch.ativo = TRUE ${filtroUsuario}
       ORDER BY ch.data_abertura DESC, ch.id DESC
       LIMIT 30`, params);
    res.json(r.rows.map(c => ({
      id: c.id,
      numero: `#${c.id}`,
      titulo: c.titulo,
      status: c.status,
      aprovacao_cliente: c.aprovacao_cliente,
      prioridade: c.prioridade,
      modulo: c.modulo,
      sid: c.sid,
      data_abertura: c.data_abertura,
      ultima_atualizacao: c.ultima_atualizacao,
      ultimo_comentario: c.ultimo_comentario && c.ultimo_comentario.length > 2000
        ? `${c.ultimo_comentario.slice(0, 2000)}…` : c.ultimo_comentario
    })));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar chamados', detalhe: err.message });
  }
});

module.exports = router;
