/**
 * /api/licencas-conector — rotas PÚBLICAS chamadas pelo conector Claude <-> SAP no cliente.
 * Autenticação = a própria chave da licença (MRSH-...). Com limite de requisições.
 *
 * POST /ativar       { chave, maquina_hash, nome_maquina, usuario_windows?, versao? }
 *                                                        -> dados da licença + conexões SAP (instalador)
 * POST /validar      { chave, sid, versao, usuario_hash, maquina_hash?, nome_maquina? } -> licença assinada (Ed25519)
 * POST /uso          { chave, sid, usuario_hash, data, contadores: { ferramenta: {chamadas, recusas} } }
 * GET  /chave-publica                                    -> PEM para conferir a assinatura
 *
 * Nunca recebe código-fonte nem dados do SAP: só contadores, hash do usuário e identificação da máquina.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { PLANOS, VALIDADE_DIAS, hashChave, chavePublicaPem, assinar, listaSids, conexoesDosSids } = require('../services/licenca');

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
  // maquina_hash é opcional: conectores antigos não mandam e seguem funcionando como antes
  let maquina = null;
  const mh = req.body?.maquina_hash;
  if (mh !== undefined && mh !== null && mh !== '') {
    const lido = lerMaquina(req.body, false);
    if (lido.erro) return res.status(400).json({ erro: lido.erro });
    maquina = lido.maquina;
  }
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

    if (maquina) {
      const recusaMaquina = await registrarMaquina(l, maquina);
      if (recusaMaquina) return negar(res, ...recusaMaquina);
    }

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
      expira_em: expira.toISOString()
    };
    // Só entra no payload assinado quando o conector mandou: a licença fica presa àquela máquina
    if (maquina) payload.maquina_hash = maquina.maquina_hash;
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

module.exports = router;
