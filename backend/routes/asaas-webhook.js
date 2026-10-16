/**
 * POST /api/asaas/webhook — eventos de NFS-e (INVOICE_*) e de cobrança PIX (PAYMENT_*) do Asaas (rota pública).
 * Autenticação: header asaas-access-token igual a ASAAS_WEBHOOK_TOKEN (cadastrado no painel do Asaas).
 * Sempre responde 200 para eventos válidos: o Asaas pausa a fila do webhook quando recebe erro.
 * Cada evento (campo "id" do Asaas) é registrado em asaas_eventos: o mesmo evento reenviado depois de
 * processado com sucesso é só confirmado, sem reprocessar.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const asaas = require('../services/asaas');
const fat = require('../services/faturamento');
const { registrarAlerta } = require('../services/alertas');

function tokenOk(recebido) {
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Registra o evento; devolve true se ele já foi processado com sucesso antes (repetição)
async function jaProcessado(eventoId, evento) {
  if (!eventoId) return false;
  const r = await pool.query(
    `INSERT INTO asaas_eventos (id, evento) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET tentativas = asaas_eventos.tentativas + 1, ultima_em = NOW()
     RETURNING processado_em`, [eventoId, String(evento || '').slice(0, 60)]);
  return !!r.rows[0].processado_em;
}

async function marcar(eventoId, resultado) {
  if (!eventoId) return;
  await pool.query(
    `UPDATE asaas_eventos SET resultado = $2::varchar, processado_em = CASE WHEN $2::varchar = 'erro' THEN NULL ELSE NOW() END WHERE id = $1`,
    [eventoId, resultado]).catch(() => {});
}

router.post('/', async (req, res) => {
  if (!tokenOk(req.get('asaas-access-token'))) {
    registrarAlerta({ chave: 'webhook:token', nivel: 'aviso', titulo: 'Webhook do Asaas recusado: token não confere',
      detalhe: 'Confira se o token configurado no painel do Asaas é igual ao ASAAS_WEBHOOK_TOKEN do Render.' });
    return res.status(401).json({ erro: 'Token inválido' });
  }

  const { id: eventoId, event, invoice, payment } = req.body || {};
  const evId = eventoId ? String(eventoId).slice(0, 100) : null;

  try {
    if (await jaProcessado(evId, event)) return res.json({ ok: true, repetido: true });
  } catch (err) {
    // Sem o registro, segue processando: as baixas já são idempotentes pelo estado da fatura
    console.error('[webhook] registrar evento:', err.message);
  }

  // Cobrança PIX: recebido → baixa automática; excluída/estornada → só atualiza o status do PIX
  if (payment && String(event || '').startsWith('PAYMENT_')) {
    try {
      const ref = /^cobranca-fatura-(\d+)$/.exec(payment.externalReference || '');
      const r = await pool.query(
        'SELECT id, empresa_id FROM faturas WHERE pix_asaas_id = $1 OR id = $2 LIMIT 1',
        [payment.id, ref ? Number(ref[1]) : 0]);
      if (!r.rows.length) { await marcar(evId, 'ignorado'); return res.json({ ok: true, ignorado: true }); }
      await fat.aplicarCobrancaNaFatura(r.rows[0].id, r.rows[0].empresa_id,
        event === 'PAYMENT_DELETED' ? { ...payment, deleted: true } : payment);
      await marcar(evId, 'ok');
      return res.json({ ok: true });
    } catch (err) {
      await marcar(evId, 'erro');
      registrarAlerta({ chave: 'webhook:pix', titulo: 'Webhook do Asaas: falha ao processar pagamento PIX', detalhe: `${event} ${payment.id}: ${err.message}` });
      return res.json({ ok: false });
    }
  }

  if (!invoice || !String(event || '').startsWith('INVOICE_')) { await marcar(evId, 'ignorado'); return res.json({ ok: true, ignorado: true }); }

  try {
    const ref = /^fatura-(\d+)$/.exec(invoice.externalReference || '');
    const r = await pool.query(
      'SELECT id, empresa_id FROM faturas WHERE nfse_asaas_id = $1 OR id = $2 LIMIT 1',
      [invoice.id, ref ? Number(ref[1]) : 0]);
    if (!r.rows.length) { await marcar(evId, 'ignorado'); return res.json({ ok: true, ignorado: true }); }

    const { id, empresa_id } = r.rows[0];
    await asaas.aplicarNotaNaFatura(id, invoice);
    await fat.aposAtualizarNota(id, empresa_id);
    await marcar(evId, 'ok');
    res.json({ ok: true });
  } catch (err) {
    await marcar(evId, 'erro');
    registrarAlerta({ chave: 'webhook:nfse', titulo: 'Webhook do Asaas: falha ao processar nota fiscal', detalhe: `${event} ${invoice.id}: ${err.message}` });
    res.json({ ok: false }); // não trava a fila; a rotina periódica re-sincroniza
  }
});

module.exports = router;
