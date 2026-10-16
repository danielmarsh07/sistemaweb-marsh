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
const loja = require('../services/loja');
const { registrarAlerta } = require('../services/alertas');

function igual(recebido, esperado) {
  if (!esperado || !recebido) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Token principal = a conta do Asaas do sistema (faturas e pedidos do mesmo ambiente);
// ASAAS_SANDBOX_WEBHOOK_TOKEN = conta de testes da loja (só pedidos em modo teste).
function origemDoToken(recebido) {
  if (igual(recebido, process.env.ASAAS_WEBHOOK_TOKEN)) return { principal: true, modo: asaas.ambiente() === 'producao' ? 'producao' : 'teste' };
  if (igual(recebido, process.env.ASAAS_SANDBOX_WEBHOOK_TOKEN)) return { principal: false, modo: 'teste' };
  return null;
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
  const origem = origemDoToken(req.get('asaas-access-token'));
  if (!origem) {
    registrarAlerta({ chave: 'webhook:token', nivel: 'aviso', titulo: 'Webhook do Asaas recusado: token não confere',
      detalhe: 'Confira se o token configurado no painel do Asaas é igual ao ASAAS_WEBHOOK_TOKEN do Render.' });
    return res.status(401).json({ erro: 'Token inválido' });
  }

  const { id: eventoId, event, invoice, payment } = req.body || {};
  // Eventos da conta de testes ganham prefixo: não se confundem com os ids da conta principal
  const evId = eventoId ? `${origem.principal ? '' : 'sbx:'}${String(eventoId)}`.slice(0, 100) : null;

  try {
    if (await jaProcessado(evId, event)) return res.json({ ok: true, repetido: true });
  } catch (err) {
    // Sem o registro, segue processando: as baixas já são idempotentes pelo estado da fatura
    console.error('[webhook] registrar evento:', err.message);
  }

  // Pedido da loja de cursos (externalReference pedido-N): libera, estorna ou cancela conforme o evento
  if (payment && String(event || '').startsWith('PAYMENT_') && /^pedido-[0-9]+$/.test(payment.externalReference || '')) {
    try {
      const resultado = await loja.aplicarEvento(event, payment, origem.modo);
      await marcar(evId, resultado === 'modo_diferente' ? 'ignorado' : 'ok');
      return res.json({ ok: true, resultado });
    } catch (err) {
      await marcar(evId, 'erro');
      registrarAlerta({ chave: 'webhook:loja', titulo: 'Webhook do Asaas: falha ao processar pedido da loja', detalhe: `${event} ${payment.id}: ${err.message}` });
      return res.json({ ok: false });
    }
  }
  // Daqui em diante: faturas, só da conta principal
  if (!origem.principal) { await marcar(evId, 'ignorado'); return res.json({ ok: true, ignorado: true }); }

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
