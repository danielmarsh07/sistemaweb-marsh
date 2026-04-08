const { Resend } = require('resend');
const pool = require('../db');

const FROM = 'Marsh Consultoria <noreply@marshconsultoria.com.br>';

// Inicialização lazy — não quebra o servidor se a chave não estiver configurada
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

// --- Helpers para buscar destinatários ---

async function emailsAdmins(empresa_id) {
  const r = await pool.query(
    `SELECT email, nome FROM usuarios
     WHERE empresa_id = $1 AND tipo IN ('admin_empresa','tecnico') AND ativo = TRUE`,
    [empresa_id]
  );
  return r.rows; // [{ email, nome }]
}

async function emailsCliente(cliente_id) {
  const r = await pool.query(
    `SELECT email, nome FROM usuarios
     WHERE cliente_id = $1 AND tipo = 'cliente' AND ativo = TRUE`,
    [cliente_id]
  );
  return r.rows;
}

// --- Envio genérico com tratamento de erro silencioso ---

async function enviar({ to, subject, html }) {
  const resend = getResend();
  if (!resend) return; // chave não configurada
  try {
    const destinatarios = Array.isArray(to) ? to.map(u => u.email) : [to];
    if (!destinatarios.length) return;
    await resend.emails.send({ from: FROM, to: destinatarios, subject, html });
  } catch (err) {
    console.error('[Email] Erro ao enviar:', err.message);
  }
}

// --- Templates HTML ---

function templateBase({ titulo, preheader, corpo }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${titulo}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Arial,sans-serif">
  <span style="display:none;max-height:0;overflow:hidden">${preheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr><td style="background:#0f172a;border-radius:12px 12px 0 0;padding:24px 32px">
          <table width="100%"><tr>
            <td>
              <div style="width:40px;height:40px;background:linear-gradient(135deg,#0ea5e9,#0066cc);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;color:#fff;text-align:center;line-height:40px">M</div>
            </td>
            <td style="padding-left:12px;vertical-align:middle">
              <span style="color:#fff;font-weight:700;font-size:16px">Marsh Consultoria</span><br/>
              <span style="color:#94a3b8;font-size:12px">Portal de Atendimento</span>
            </td>
          </tr></table>
        </td></tr>

        <!-- Corpo -->
        <tr><td style="background:#fff;padding:32px">
          ${corpo}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0">
          <p style="margin:0;color:#94a3b8;font-size:12px">
            Marsh Consultoria · Bragança Paulista – SP<br/>
            <a href="mailto:daniel.marsh@marshconsultoria.com.br" style="color:#0ea5e9;text-decoration:none">daniel.marsh@marshconsultoria.com.br</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const labelStatus = {
  aberto: 'Aberto',
  em_andamento: 'Em Andamento',
  resolvido: 'Resolvido',
  fechado: 'Fechado'
};

const corStatus = {
  aberto: '#ef4444',
  em_andamento: '#f59e0b',
  resolvido: '#10b981',
  fechado: '#64748b'
};

function badgeStatus(status) {
  const cor = corStatus[status] || '#64748b';
  const label = labelStatus[status] || status;
  return `<span style="background:${cor}20;color:${cor};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600">${label}</span>`;
}

// --- Notificações ---

/**
 * Chamado aberto — avisa os admins/técnicos
 */
async function notificarNovoChamado({ chamado, empresa_id, aberto_por }) {
  const admins = await emailsAdmins(empresa_id);
  if (!admins.length) return;

  const html = templateBase({
    titulo: `Novo chamado #${chamado.id}`,
    preheader: `${aberto_por} abriu um novo chamado: ${chamado.titulo}`,
    corpo: `
      <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">Novo chamado aberto</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">por <strong>${aberto_por}</strong></p>

      <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:24px;border-left:4px solid #0ea5e9">
        <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#0f172a">#${chamado.id} — ${chamado.titulo}</p>
        <p style="margin:0 0 12px;color:#64748b;font-size:14px">${chamado.descricao || 'Sem descrição.'}</p>
        <table>
          <tr>
            <td style="padding-right:16px;font-size:13px;color:#64748b">Status:</td>
            <td>${badgeStatus(chamado.status)}</td>
          </tr>
          <tr>
            <td style="padding-right:16px;font-size:13px;color:#64748b">Prioridade:</td>
            <td style="font-size:13px;font-weight:600;color:#0f172a">${chamado.prioridade || 'Média'}</td>
          </tr>
        </table>
      </div>

      <a href="https://www.marshconsultoria.com.br/login.html"
         style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
        Ver no sistema →
      </a>
    `
  });

  await enviar({
    to: admins,
    subject: `[Marsh] Novo chamado #${chamado.id}: ${chamado.titulo}`,
    html
  });
}

/**
 * Status do chamado atualizado — avisa o cliente
 */
async function notificarAtualizacaoStatus({ chamado, statusAnterior, empresa_id }) {
  if (!chamado.cliente_id) return;
  const clientes = await emailsCliente(chamado.cliente_id);
  if (!clientes.length) return;

  const html = templateBase({
    titulo: `Chamado #${chamado.id} atualizado`,
    preheader: `O status do seu chamado foi atualizado para ${labelStatus[chamado.status] || chamado.status}`,
    corpo: `
      <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">Seu chamado foi atualizado</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">A equipe da Marsh Consultoria atualizou o status do seu chamado.</p>

      <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:24px;border-left:4px solid #0ea5e9">
        <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#0f172a">#${chamado.id} — ${chamado.titulo}</p>
        <table>
          <tr>
            <td style="padding-right:16px;font-size:13px;color:#64748b;padding-bottom:8px">Status anterior:</td>
            <td style="padding-bottom:8px">${badgeStatus(statusAnterior)}</td>
          </tr>
          <tr>
            <td style="padding-right:16px;font-size:13px;color:#64748b">Novo status:</td>
            <td>${badgeStatus(chamado.status)}</td>
          </tr>
        </table>
      </div>

      <a href="https://www.marshconsultoria.com.br/login.html"
         style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
        Acompanhar no portal →
      </a>
    `
  });

  await enviar({
    to: clientes,
    subject: `[Marsh] Chamado #${chamado.id} — Status atualizado: ${labelStatus[chamado.status] || chamado.status}`,
    html
  });
}

/**
 * Novo comentário/atendimento:
 * - Se quem comentou é admin/tecnico → avisa o cliente
 * - Se quem comentou é cliente → avisa os admins
 */
async function notificarNovoAtendimento({ atendimento, chamado, remetente_tipo, remetente_nome, empresa_id }) {
  const ehCliente = remetente_tipo === 'cliente';

  const tipoLabel = {
    comentario: 'Novo comentário',
    solucao: 'Solução registrada',
    atualizacao: 'Atualização',
    visita: 'Visita registrada',
    ligacao: 'Ligação registrada'
  };
  const labelTipo = tipoLabel[atendimento.tipo] || 'Novo atendimento';

  const corpo = `
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">${labelTipo}</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px">
      por <strong>${remetente_nome}</strong> no chamado <strong>#${chamado.id}</strong>
    </p>

    <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:24px;border-left:4px solid #0ea5e9">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#0f172a">${chamado.titulo}</p>
      <p style="margin:0;color:#374151;font-size:14px;line-height:1.6">${atendimento.descricao}</p>
    </div>

    <a href="https://www.marshconsultoria.com.br/login.html"
       style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
      ${ehCliente ? 'Ver no sistema →' : 'Acompanhar no portal →'}
    </a>
  `;

  const html = templateBase({
    titulo: `${labelTipo} no chamado #${chamado.id}`,
    preheader: `${remetente_nome}: ${atendimento.descricao.substring(0, 80)}...`,
    corpo
  });

  if (ehCliente) {
    // Cliente comentou → avisa admins
    const admins = await emailsAdmins(empresa_id);
    await enviar({
      to: admins,
      subject: `[Marsh] ${labelTipo} do cliente — Chamado #${chamado.id}: ${chamado.titulo}`,
      html
    });
  } else {
    // Admin/tecnico comentou → avisa cliente
    if (!chamado.cliente_id) return;
    const clientes = await emailsCliente(chamado.cliente_id);
    await enviar({
      to: clientes,
      subject: `[Marsh] ${labelTipo} no seu chamado #${chamado.id}: ${chamado.titulo}`,
      html
    });
  }
}

module.exports = {
  notificarNovoChamado,
  notificarAtualizacaoStatus,
  notificarNovoAtendimento
};
