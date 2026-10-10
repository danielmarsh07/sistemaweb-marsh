// Rotina periódica do financeiro (roda dentro do próprio servidor, a cada hora):
//  1. Consulta no Asaas as NFS-e ainda em processamento (caso o webhook não tenha chegado)
//  2. Envia lembrete por e-mail de faturas vencidas e não pagas
const pool = require('../db');
const asaas = require('./asaas');
const email = require('./email');
const fat = require('./faturamento');

const UMA_HORA = 60 * 60 * 1000;
let rodando = false;

async function sincronizarNotasPendentes() {
  if (!asaas.configurado()) return;
  const r = await pool.query(
    `SELECT id, empresa_id FROM faturas
     WHERE nfse_status IN ('processando', 'cancelando') AND nfse_asaas_id IS NOT NULL
       AND COALESCE(data_atualizacao, data_criacao) < NOW() - INTERVAL '5 minutes'
     LIMIT 50`);
  for (const { id, empresa_id } of r.rows) {
    try {
      const f = await fat.carregarFatura(id, empresa_id);
      await fat.sincronizarNfse(f);
    } catch (err) {
      console.error(`[financeiro-jobs] sincronizar NFS-e fatura ${id}:`, err.message);
    }
  }
}

async function enviarLembretes() {
  if (!email.emailConfigurado()) return;
  // Vencidas há até 60 dias, sem lembrete ou com o último há mais de N dias (N = dias_lembrete; 0 desliga)
  const r = await pool.query(
    `SELECT f.id, f.empresa_id FROM faturas f
     LEFT JOIN financeiro_config cfg ON cfg.empresa_id = f.empresa_id
     WHERE f.status = 'aberta'
       AND f.data_vencimento < CURRENT_DATE
       AND f.data_vencimento >= CURRENT_DATE - 60
       AND COALESCE(cfg.dias_lembrete, 3) > 0
       AND f.data_vencimento <= CURRENT_DATE - COALESCE(cfg.dias_lembrete, 3)
       AND (f.lembrete_enviado_em IS NULL
            OR f.lembrete_enviado_em < NOW() - (COALESCE(cfg.dias_lembrete, 3) * INTERVAL '1 day'))
     LIMIT 50`);
  for (const { id, empresa_id } of r.rows) {
    try {
      const f = await fat.carregarFatura(id, empresa_id);
      const [cliente, config] = await Promise.all([fat.carregarCliente(f.cliente_id), fat.carregarConfig(empresa_id)]);
      if (await email.enviarLembreteFatura({ fatura: f, cliente, config })) {
        await pool.query('UPDATE faturas SET lembrete_enviado_em = NOW() WHERE id = $1', [id]);
      }
    } catch (err) {
      console.error(`[financeiro-jobs] lembrete fatura ${id}:`, err.message);
    }
  }
}

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    await sincronizarNotasPendentes();
    await enviarLembretes();
  } catch (err) {
    console.error('[financeiro-jobs]', err.message);
  } finally {
    rodando = false;
  }
}

function iniciar() {
  setTimeout(ciclo, 60 * 1000); // primeira passada 1 min após subir
  setInterval(ciclo, UMA_HORA);
}

module.exports = { iniciar, ciclo };
