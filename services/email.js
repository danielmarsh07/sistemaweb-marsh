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

// Retorna true só quando o Resend aceitou o envio
async function enviar({ to, subject, html, cc }) {
  const resend = getResend();
  if (!resend) return false; // chave não configurada
  try {
    const destinatarios = Array.isArray(to) ? to.map(u => (typeof u === 'string' ? u : u.email)) : [to];
    if (!destinatarios.length) return false;
    const r = await resend.emails.send({ from: FROM, to: destinatarios, subject, html, ...(cc ? { cc } : {}) });
    if (r && r.error) throw new Error(r.error.message);
    return true;
  } catch (err) {
    console.error('[Email] Erro ao enviar:', err.message);
    return false;
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

// --- Financeiro ---

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const diaBr = d => String(d).slice(0, 10).split('-').reverse().join('/');
const mesAno = d => {
  const [a, m] = String(d).slice(0, 7).split('-');
  return `${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][Number(m) - 1]}/${a}`;
};

// Destinatários de cobrança: e-mail financeiro do cliente; se não houver, o e-mail do cadastro
function destinatariosFatura(cliente) {
  return [cliente.email_financeiro, cliente.email]
    .filter(Boolean)
    .flatMap(e => String(e).split(/[;,]/).map(x => x.trim()).filter(Boolean))
    .filter((e, i, arr) => arr.indexOf(e) === i)
    .slice(0, 5);
}

// Valor da nota → retenções do tomador → valor a pagar (quando não há retenção, só "Valor")
function linhasValor(fatura) {
  const td = 'padding:4px 16px 4px 0;font-size:13px;color:#64748b';
  const liquido = fatura.valor_liquido ?? fatura.valor;
  if (Number(liquido) >= Number(fatura.valor)) {
    return `<tr><td style="${td}">Valor</td><td style="font-size:16px;font-weight:700;color:#0f172a">${moeda(fatura.valor)}</td></tr>`;
  }
  const nomes = { ret_ir: 'IRRF', ret_csll: 'CSLL', ret_pis: 'PIS', ret_cofins: 'COFINS', ret_inss: 'INSS' };
  const ret = Object.entries(nomes)
    .filter(([k]) => Number(fatura[k]) > 0)
    .map(([k, n]) => `${n} ${String(fatura[k]).replace('.', ',')}%`);
  if (fatura.reter_iss && Number(fatura.aliquota_iss) > 0) ret.push(`ISS ${String(fatura.aliquota_iss).replace('.', ',')}%`);
  return `
    <tr><td style="${td}">Valor da nota</td><td style="font-size:13px;color:#0f172a">${moeda(fatura.valor)}</td></tr>
    <tr><td style="${td}">Retenções</td><td style="font-size:13px;color:#0f172a">− ${moeda(fatura.valor - liquido)} <span style="color:#64748b">(${ret.join(', ')})</span></td></tr>
    <tr><td style="${td}">Valor a pagar</td><td style="font-size:16px;font-weight:700;color:#0f172a">${moeda(liquido)}</td></tr>`;
}

function blocoFatura({ fatura, config }) {
  const nota = fatura.nfse_pdf_url
    ? `<tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Nota fiscal</td>
         <td style="font-size:13px;color:#0f172a">NFS-e nº ${esc(fatura.nfse_numero || '-')} ·
           <a href="${esc(fatura.nfse_pdf_url)}" style="color:#1d6fd8">PDF</a>${fatura.nfse_xml_url ? ` · <a href="${esc(fatura.nfse_xml_url)}" style="color:#1d6fd8">XML</a>` : ''}</td></tr>`
    : '';
  const pix = config && config.pix_chave
    ? `<p style="margin:0 0 6px;font-size:14px;color:#0f172a"><strong>PIX:</strong> ${esc(config.pix_chave)}</p>` : '';
  const instr = config && config.instrucoes_pagamento
    ? `<p style="margin:0;font-size:13px;color:#334155;white-space:pre-line">${esc(config.instrucoes_pagamento)}</p>` : '';
  return `
    <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:20px;border-left:4px solid #1d6fd8">
      <p style="margin:0 0 12px;font-size:15px;color:#0f172a;white-space:pre-line">${esc(fatura.descricao)}</p>
      <table>
        <tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Competência</td><td style="font-size:13px;color:#0f172a">${mesAno(fatura.competencia)}</td></tr>
        ${linhasValor(fatura)}
        <tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Vencimento</td><td style="font-size:13px;font-weight:600;color:#0f172a">${diaBr(fatura.data_vencimento)}</td></tr>
        ${nota}
      </table>
    </div>
    ${pix || instr ? `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#64748b">Como pagar</p>
      ${pix}${instr}
    </div>` : ''}
    <a href="https://www.marshconsultoria.com.br/login.html"
       style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
      Ver no Portal do Cliente →
    </a>`;
}

/** Fatura aprovada (com a NFS-e, se já emitida) — vai para o financeiro do cliente */
async function enviarFatura({ fatura, cliente, config }) {
  const to = destinatariosFatura(cliente);
  if (!to.length) return false;
  const nome = cliente.nome_fantasia || cliente.razao_social || cliente.nome;
  const html = templateBase({
    titulo: `Fatura ${mesAno(fatura.competencia)}`,
    preheader: `Fatura de ${mesAno(fatura.competencia)} — ${moeda(fatura.valor_liquido ?? fatura.valor)}, vencimento ${diaBr(fatura.data_vencimento)}`,
    corpo: `
      <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">Sua fatura de ${mesAno(fatura.competencia)}</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">Olá, ${esc(nome)}. Segue o faturamento do período.</p>
      ${blocoFatura({ fatura, config })}`
  });
  return enviar({
    to, cc: config && config.email_copia ? [config.email_copia] : undefined,
    subject: `[Marsh] Fatura ${mesAno(fatura.competencia)} — ${moeda(fatura.valor_liquido ?? fatura.valor)} · vence ${diaBr(fatura.data_vencimento)}`,
    html
  });
}

/** Lembrete de fatura vencida e não paga */
async function enviarLembreteFatura({ fatura, cliente, config }) {
  const to = destinatariosFatura(cliente);
  if (!to.length) return false;
  const html = templateBase({
    titulo: 'Fatura em aberto',
    preheader: `A fatura de ${mesAno(fatura.competencia)} venceu em ${diaBr(fatura.data_vencimento)}`,
    corpo: `
      <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">Lembrete: fatura em aberto</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">
        Não identificamos o pagamento da fatura abaixo, vencida em ${diaBr(fatura.data_vencimento)}.
        Se já pagou, desconsidere este aviso — obrigado!</p>
      ${blocoFatura({ fatura, config })}`
  });
  return enviar({
    to, cc: config && config.email_copia ? [config.email_copia] : undefined,
    subject: `[Marsh] Lembrete: fatura ${mesAno(fatura.competencia)} vencida em ${diaBr(fatura.data_vencimento)}`,
    html
  });
}

module.exports = {
  notificarNovoChamado,
  notificarAtualizacaoStatus,
  notificarNovoAtendimento,
  enviarFatura,
  enviarLembreteFatura,
  emailConfigurado: () => !!process.env.RESEND_API_KEY
};
