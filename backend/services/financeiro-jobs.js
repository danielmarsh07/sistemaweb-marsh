// Rotina periódica do financeiro (roda dentro do próprio servidor, a cada hora):
//  0. Gera os rascunhos das faturas do mês a partir do dia configurado (o admin aprova)
//     e libera as licenças do Conector cujo convite expirou sem aceite
//  1. Consulta no Asaas as NFS-e ainda em processamento (caso o webhook não tenha chegado)
//  2. Consulta as cobranças PIX pendentes (baixa automática se o webhook de pagamento falhou)
//  3. Envia lembrete por e-mail de faturas vencidas e não pagas
//  4. Renova as assinaturas recorrentes de contas a pagar (sempre 12 meses à frente)
const pool = require('../db');
const asaas = require('./asaas');
const email = require('./email');
const fat = require('./faturamento');
const { registrarAlerta } = require('./alertas');

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
      registrarAlerta({ chave: 'job:nfse', titulo: 'Rotina: falha ao consultar NFS-e no Asaas', detalhe: `fatura ${id}: ${err.message}` });
    }
  }
}

// PIX pendente há mais de 10 min: consulta no Asaas (caso o webhook de pagamento não tenha chegado)
async function sincronizarPixPendentes() {
  if (!asaas.configurado()) return;
  const r = await pool.query(
    `SELECT id, empresa_id FROM faturas
     WHERE status = 'aberta' AND pix_status = 'pendente' AND pix_asaas_id IS NOT NULL
       AND COALESCE(data_atualizacao, data_criacao) < NOW() - INTERVAL '10 minutes'
     LIMIT 50`);
  for (const { id, empresa_id } of r.rows) {
    try {
      await fat.sincronizarPix(await fat.carregarFatura(id, empresa_id));
    } catch (err) {
      registrarAlerta({ chave: 'job:pix', titulo: 'Rotina: falha ao consultar PIX no Asaas', detalhe: `fatura ${id}: ${err.message}` });
    }
  }
}

// Assinaturas recorrentes: mantém sempre 12 meses lançados à frente.
// O vencimento N é calculado a partir da 1ª parcela (+N-1 meses) para não "escorregar" no fim do mês (31 → 28 → 28...).
async function estenderRecorrentes() {
  const series = await pool.query(
    `SELECT grupo_id, MAX(parcela) AS ultima, MAX(data_vencimento) AS ultimo_venc
     FROM contas_pagar WHERE recorrente AND grupo_id IS NOT NULL
     GROUP BY grupo_id
     HAVING MAX(data_vencimento) < CURRENT_DATE + INTERVAL '11 months'
     LIMIT 200`);
  for (const s of series.rows) {
    try {
      await pool.query(
        `INSERT INTO contas_pagar (empresa_id, fornecedor_id, categoria_id, descricao, documento, valor, competencia,
           data_vencimento, status, grupo_id, parcela, total_parcelas, observacoes, natureza, conta_financeira_id, recorrente)
         SELECT u.empresa_id, u.fornecedor_id, u.categoria_id, u.descricao, u.documento, u.valor,
                (p.competencia + make_interval(months => n - 1))::date,
                (p.data_vencimento + make_interval(months => n - 1))::date,
                'aberta', u.grupo_id, n, NULL, u.observacoes, u.natureza, u.conta_financeira_id, TRUE
         FROM (SELECT * FROM contas_pagar WHERE grupo_id = $1 ORDER BY parcela DESC LIMIT 1) u
         CROSS JOIN (SELECT * FROM contas_pagar WHERE grupo_id = $1 ORDER BY parcela LIMIT 1) p
         CROSS JOIN generate_series($2::int + 1, $2::int + 12) n
         WHERE (p.data_vencimento + make_interval(months => n - 1)) < CURRENT_DATE + INTERVAL '12 months'`,
        [s.grupo_id, s.ultima]);
    } catch (err) {
      registrarAlerta({ chave: 'job:assinaturas', titulo: 'Rotina: falha ao renovar assinatura de contas a pagar', detalhe: `série ${s.grupo_id}: ${err.message}` });
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
      registrarAlerta({ chave: 'job:lembrete', titulo: 'Rotina: falha ao enviar lembrete de fatura vencida', detalhe: `fatura ${id}: ${err.message}` });
    }
  }
}

// Rascunhos automáticos: a partir do dia_geracao (horário de Brasília), gera os rascunhos da competência do mês
// para os contratos que ainda não têm fatura nela. Idempotente: rodar de novo não duplica, e fatura cancelada
// pelo admin não é recriada. Avisa os administradores por e-mail quando há rascunhos novos para aprovar.
function hojeBrasilia() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
}

async function gerarRascunhosAutomaticos() {
  const hoje = hojeBrasilia();
  const competencia = hoje.slice(0, 7), dia = Number(hoje.slice(8, 10));
  const empresas = await pool.query(
    `SELECT DISTINCT ct.empresa_id FROM contratos ct
     LEFT JOIN financeiro_config cfg ON cfg.empresa_id = ct.empresa_id
     WHERE ct.status = 'ativo' AND COALESCE(cfg.geracao_automatica, TRUE) AND COALESCE(cfg.dia_geracao, 1) <= $1`, [dia]);
  for (const { empresa_id } of empresas.rows) {
    try {
      const geradas = await fat.gerarRascunhos({ empresa_id, competencia, automatico: true });
      if (geradas) {
        const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
        await email.notificarAdminsComercial({
          empresa_id, assunto: `${geradas} fatura(s) aguardando aprovação`,
          titulo: 'Faturas do mês geradas como rascunho',
          linhas: [['Competência', `${competencia.slice(5)}/${competencia.slice(0, 4)}`], ['Rascunhos novos', String(geradas)],
                   ['Próximo passo', 'Revise e aprove. Ao aprovar, a nota fiscal e o e-mail ao cliente seguem sozinhos.']],
          link: `${base}/dashboard.html#faturamento`
        }).catch(() => false);
      }
    } catch (err) {
      registrarAlerta({ chave: 'job:rascunhos', titulo: 'Rotina: falha ao gerar os rascunhos de faturas do mês', detalhe: `empresa ${empresa_id}: ${err.message}` });
    }
  }
}

// Convites de licença do Conector que expiraram sem aceite: a licença reservada volta a ficar livre
async function expirarConvitesConector() {
  try {
    const n = await require('./contratos-conector').expirarConvites();
    if (n) console.log(`[rotina] ${n} convite(s) do Conector expirado(s): licenças liberadas`);
  } catch (err) {
    registrarAlerta({ chave: 'job:convites', titulo: 'Rotina: falha ao expirar convites do Conector', detalhe: err.message });
  }
}

// Rastro de acessos aos cursos: registra expirações por data (contrato vencido, liberação vencida)
async function sincronizarAcessos() {
  try { await require('./acessos').sincronizarTodos(); }
  catch (err) { registrarAlerta({ chave: 'job:acessos', titulo: 'Rotina: falha ao sincronizar os acessos aos cursos', detalhe: err.message }); }
}

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    await gerarRascunhosAutomaticos();
    await expirarConvitesConector();
    await sincronizarAcessos();
    await sincronizarNotasPendentes();
    await sincronizarPixPendentes(); // antes dos lembretes: quem já pagou não recebe cobrança
    await enviarLembretes();
    await estenderRecorrentes();
  } catch (err) {
    registrarAlerta({ chave: 'job:ciclo', titulo: 'Rotina horária do financeiro falhou', detalhe: err.stack || err.message });
  } finally {
    rodando = false;
  }
}

function iniciar() {
  setTimeout(ciclo, 60 * 1000); // primeira passada 1 min após subir
  setInterval(ciclo, UMA_HORA);
}

module.exports = { iniciar, ciclo, estenderRecorrentes, gerarRascunhosAutomaticos };
