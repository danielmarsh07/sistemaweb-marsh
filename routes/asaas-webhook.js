/**
 * POST /api/asaas/webhook — eventos de NFS-e do Asaas (rota pública).
 * Autenticação: header asaas-access-token igual a ASAAS_WEBHOOK_TOKEN (cadastrado no painel do Asaas).
 * Sempre responde 200 para eventos válidos: o Asaas pausa a fila do webhook quando recebe erro.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const asaas = require('../services/asaas');
const fat = require('../services/faturamento');

function tokenOk(recebido) {
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  if (!tokenOk(req.get('asaas-access-token'))) return res.status(401).json({ erro: 'Token inválido' });

  const { event, invoice } = req.body || {};
  if (!invoice || !String(event || '').startsWith('INVOICE_')) return res.json({ ok: true, ignorado: true });

  try {
    const ref = /^fatura-(\d+)$/.exec(invoice.externalReference || '');
    const r = await pool.query(
      'SELECT id, empresa_id FROM faturas WHERE nfse_asaas_id = $1 OR id = $2 LIMIT 1',
      [invoice.id, ref ? Number(ref[1]) : 0]);
    if (!r.rows.length) return res.json({ ok: true, ignorado: true });

    const { id, empresa_id } = r.rows[0];
    await asaas.aplicarNotaNaFatura(id, invoice);
    await fat.aposAtualizarNota(id, empresa_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Asaas webhook]', err.message);
    res.json({ ok: false }); // não trava a fila; a rotina periódica re-sincroniza
  }
});

module.exports = router;
