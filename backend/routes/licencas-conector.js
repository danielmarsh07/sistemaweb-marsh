/**
 * /api/licencas-conector — rotas PÚBLICAS chamadas pelo conector Claude <-> SAP no cliente.
 * Autenticação = a própria chave da licença (MRSH-...). Com limite de requisições.
 *
 * POST /validar      { chave, sid, versao, usuario_hash } -> licença assinada (Ed25519)
 * POST /uso          { chave, sid, usuario_hash, data, contadores: { ferramenta: {chamadas, recusas} } }
 * GET  /chave-publica                                    -> PEM para conferir a assinatura
 *
 * Nunca recebe código-fonte nem dados do SAP: só contadores e hash do usuário.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { PLANOS, VALIDADE_DIAS, hashChave, chavePublicaPem, assinar, listaSids } = require('../services/licenca');

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

router.get('/chave-publica', (req, res) => {
  const pem = chavePublicaPem();
  if (!pem) return res.status(503).json({ erro: 'Assinatura de licença não configurada no servidor.' });
  res.type('text/plain').send(pem);
});

router.post('/validar', async (req, res) => {
  const { chave, versao } = req.body || {};
  const sid = String(req.body?.sid || '').toUpperCase();
  const usuario_hash = String(req.body?.usuario_hash || '').toLowerCase();
  if (!RE_SID.test(sid) || !RE_HASH.test(usuario_hash)) {
    return res.status(400).json({ erro: 'sid e usuario_hash são obrigatórios.' });
  }
  try {
    const l = await buscarLicenca(chave);
    if (!l) return negar(res, 'chave', 'Licença inválida.');
    if (l.status !== 'ativa') return negar(res, l.status, `Licença ${l.status}. Fale com a Marsh Consultoria.`);

    const hoje = dataIso(new Date());
    const fim = dataIso(l.data_fim);
    if (fim < hoje) return negar(res, 'vencida', `Licença vencida em ${fim}. Fale com a Marsh Consultoria.`);

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
      emitida_em: agora.toISOString(),
      expira_em: expira.toISOString()
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

module.exports = router;
