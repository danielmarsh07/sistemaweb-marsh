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

// Registro de cada envio (para quem, assunto, se saiu). Falhar ao registrar nunca impede o e-mail.
function registrarEnvio(to, subject, ok, erro) {
  const para = (Array.isArray(to) ? to.map(u => (typeof u === 'string' ? u : u.email)) : [to]).filter(Boolean).join(', ');
  if (!para) return;
  require('../db').query('INSERT INTO emails_enviados (para, assunto, ok, erro) VALUES ($1, $2, $3, $4)',
    [para.slice(0, 2000), String(subject || '').slice(0, 300), ok, erro ? String(erro).slice(0, 1000) : null]).catch(() => {});
}

// Retorna true só quando o Resend aceitou o envio. Cada tentativa fica registrada em emails_enviados.
async function enviar(opcoes) {
  const { ok, erro } = await enviarSemRegistro(opcoes);
  registrarEnvio(opcoes.to, opcoes.subject, ok, erro);
  return ok;
}

async function enviarSemRegistro({ to, subject, html, cc, semAlerta }) {
  const resend = getResend();
  if (!resend) {
    // Fora do ar no servidor (Render define RENDER=true) é problema; no ambiente local é de propósito
    if (process.env.RENDER && !semAlerta) {
      require('./alertas').registrarAlerta({
        chave: 'email:sem-chave', titulo: 'E-mails não estão sendo enviados',
        detalhe: `RESEND_API_KEY não está configurada no servidor. Não saiu: "${subject}".`
      });
    }
    return { ok: false, erro: 'envio de e-mail desligado (sem RESEND_API_KEY)' };
  }
  try {
    const destinatarios = Array.isArray(to) ? to.map(u => (typeof u === 'string' ? u : u.email)) : [to];
    if (!destinatarios.length) return { ok: false, erro: 'sem destinatário' };
    const r = await resend.emails.send({ from: FROM, to: destinatarios, subject, html, ...(cc ? { cc } : {}) });
    if (r && r.error) throw new Error(r.error.message);
    return { ok: true, erro: null };
  } catch (err) {
    console.error('[Email] Erro ao enviar:', err.message);
    // O próprio e-mail de alerta não gera alerta (evita laço quando o envio está fora do ar)
    if (!semAlerta) {
      require('./alertas').registrarAlerta({
        chave: 'email:falha', titulo: 'Falha ao enviar e-mail',
        detalhe: `"${subject}" para ${(Array.isArray(to) ? to.map(u => u.email || u) : [to]).join(', ')}: ${err.message}`
      });
    }
    return { ok: false, erro: err.message };
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
    preheader: `${esc(aberto_por)} abriu um novo chamado: ${esc(chamado.titulo)}`,
    corpo: `
      <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">Novo chamado aberto</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">por <strong>${esc(aberto_por)}</strong></p>

      <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:24px;border-left:4px solid #0ea5e9">
        <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#0f172a">#${chamado.id} — ${esc(chamado.titulo)}</p>
        <p style="margin:0 0 12px;color:#64748b;font-size:14px;white-space:pre-line">${chamado.descricao ? esc(chamado.descricao) : 'Sem descrição.'}</p>
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
    ligacao: 'Ligação registrada',
    aprovacao: 'Chamado aprovado',
    recusa: 'Chamado recusado'
  };
  const labelTipo = tipoLabel[atendimento.tipo] || 'Novo atendimento';

  const corpo = `
    <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">${labelTipo}</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px">
      por <strong>${esc(remetente_nome)}</strong> no chamado <strong>#${chamado.id}</strong>
    </p>

    <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:24px;border-left:4px solid #0ea5e9">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#0f172a">${esc(chamado.titulo)}</p>
      <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;white-space:pre-line">${esc(atendimento.descricao)}</p>
    </div>

    <a href="https://www.marshconsultoria.com.br/login.html"
       style="display:inline-block;background:#0ea5e9;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
      ${ehCliente ? 'Ver no sistema →' : 'Acompanhar no portal →'}
    </a>
  `;

  const html = templateBase({
    titulo: `${labelTipo} no chamado #${chamado.id}`,
    preheader: `${esc(remetente_nome)}: ${esc(atendimento.descricao.substring(0, 80))}...`,
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
  // Cobrança PIX do Asaas (valor exato + baixa automática) tem prioridade sobre a chave PIX fixa
  const pixCobranca = fatura.status === 'aberta' && fatura.pix_status === 'pendente' && fatura.pix_payload
    ? `<div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;padding:16px 20px;margin-bottom:20px">
        <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#1d6fd8">Pague com PIX</p>
        <p style="margin:0 0 6px;font-size:13px;color:#334155">Copie o código abaixo e use "PIX copia e cola" no app do seu banco. A baixa é automática.</p>
        <p style="margin:0 0 12px;font-family:monospace;font-size:12px;color:#0f172a;word-break:break-all;background:#fff;border-radius:6px;padding:10px">${esc(fatura.pix_payload)}</p>
        ${fatura.pix_url ? `<a href="${esc(fatura.pix_url)}" style="color:#1d6fd8;font-size:13px;font-weight:600">Ver QR code →</a>` : ''}
      </div>` : '';
  const pix = !pixCobranca && config && config.pix_chave
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
    ${pixCobranca}
    ${pix || instr ? `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:20px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#64748b">${pixCobranca ? 'Ou por transferência' : 'Como pagar'}</p>
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

// ===== Sistema: alertas e acesso =====

/** Falha importante no sistema (enviado pelo services/alertas.js). Não gera alerta se o próprio envio falhar. */
async function enviarAlertaSistema({ para, titulo, detalhe, ocorrencias }) {
  const html = templateBase({
    titulo: 'Alerta do sistema', preheader: titulo,
    corpo: `
      <h2 style="margin:0 0 8px;color:#b42318;font-size:20px">⚠ ${esc(titulo)}</h2>
      <p style="margin:0 0 16px;color:#64748b;font-size:14px">${ocorrencias > 1 ? `Ocorreu ${ocorrencias} vezes até agora.` : 'Primeira ocorrência.'} Você recebe no máximo um aviso a cada 6 horas para o mesmo problema.</p>
      <pre style="white-space:pre-wrap;background:#f8fafc;border-radius:8px;padding:14px;font-size:12px;color:#0f172a;border-left:4px solid #b42318">${esc(detalhe || 'sem detalhe')}</pre>
      <a href="${esc(process.env.APP_URL || 'https://marshconsultoria.com.br')}/dashboard.html" style="display:inline-block;margin-top:16px;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Ver em Sistema → Alertas</a>`
  });
  return enviar({ to: para, subject: `[Marsh] Alerta: ${titulo}`, html, semAlerta: true });
}

/** Convite (criar a senha) ou redefinição de senha — o link vale uma vez e expira */
async function enviarLinkSenha({ nome, email, link, tipo, horas }) {
  const convite = tipo === 'convite';
  const html = templateBase({
    titulo: convite ? 'Seu acesso ao Sistema Marsh' : 'Redefinir senha',
    preheader: convite ? 'Crie sua senha para acessar' : 'Link para criar uma nova senha',
    corpo: `
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:20px">${convite ? 'Bem-vindo ao Sistema Marsh' : 'Redefinição de senha'}</h2>
      <p style="margin:0 0 20px;color:#334155;font-size:14px">Olá, ${esc(nome)}. ${convite
        ? 'Seu acesso foi criado. Clique no botão abaixo para criar a sua senha.'
        : 'Recebemos um pedido para redefinir a sua senha. Se não foi você, ignore este e-mail: a senha atual continua valendo.'}</p>
      <a href="${esc(link)}" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">${convite ? 'Criar minha senha' : 'Criar nova senha'} →</a>
      <p style="margin:20px 0 0;color:#64748b;font-size:13px">O link vale por ${horas} horas e só pode ser usado uma vez. Seu login é <strong>${esc(email)}</strong>.</p>`
  });
  return enviar({ to: [email], subject: convite ? '[Marsh] Seu acesso ao Sistema Marsh' : '[Marsh] Redefinição de senha', html });
}

/** Boas-vindas para quem foi criado com senha definida pelo administrador (sem convite). Não leva a senha. */
async function enviarBoasVindas({ nome, email, tipo }) {
  const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
  const oQueFaz = tipo === 'cliente'
    ? 'Pelo portal você abre e acompanha chamados de suporte, envia anexos e consulta suas faturas e notas fiscais.'
    : 'Pelo sistema você acompanha chamados, clientes e o restante da operação da Marsh.';
  const html = templateBase({
    titulo: 'Bem-vindo ao Sistema Marsh',
    preheader: 'Sua conta foi criada',
    corpo: `
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:20px">Bem-vindo ao Sistema Marsh</h2>
      <p style="margin:0 0 12px;color:#334155;font-size:14px">Olá, ${esc(nome)}. Sua conta foi criada. ${oQueFaz}</p>
      <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin-bottom:20px;border-left:4px solid #1d6fd8">
        <table>
          <tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Login</td><td style="font-size:13px;font-weight:600;color:#0f172a">${esc(email)}</td></tr>
          <tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Senha</td><td style="font-size:13px;color:#0f172a">a que foi combinada com quem criou o seu acesso</td></tr>
        </table>
      </div>
      <a href="${esc(base)}/login.html" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Acessar o sistema →</a>
      <p style="margin:20px 0 0;color:#64748b;font-size:13px">Não sabe a senha? Na tela de entrada, use "Esqueci minha senha" para receber um link e criar uma nova.</p>`
  });
  return enviar({ to: [email], subject: '[Marsh] Bem-vindo ao Sistema Marsh', html });
}

// ===== Comercial (funil e propostas) =====

/** Proposta enviada ao contato da oportunidade, com o link público para ver e responder */
async function enviarProposta({ proposta, para, nomeContato, link, copia }) {
  const linhas = [
    Number(proposta.total_mensal) > 0 && `<tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Mensal</td><td style="font-size:16px;font-weight:700;color:#0f172a">${moeda(proposta.total_mensal)}/mês</td></tr>`,
    Number(proposta.total_unico) > 0 && `<tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Valor único</td><td style="font-size:16px;font-weight:700;color:#0f172a">${moeda(proposta.total_unico)}</td></tr>`
  ].filter(Boolean).join('');
  const html = templateBase({
    titulo: `Proposta ${proposta.numero}`,
    preheader: `${proposta.titulo} — válida até ${diaBr(proposta.validade)}`,
    corpo: `
      <h2 style="margin:0 0 4px;color:#0f172a;font-size:20px">${esc(proposta.titulo)}</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">Olá${nomeContato ? `, ${esc(nomeContato)}` : ''}. Segue a nossa proposta comercial nº ${esc(proposta.numero)}.</p>
      <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:20px;border-left:4px solid #1d6fd8">
        <table>${linhas}
          <tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b">Válida até</td><td style="font-size:13px;font-weight:600;color:#0f172a">${diaBr(proposta.validade)}</td></tr>
        </table>
      </div>
      <a href="${esc(link)}" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
        Ver proposta completa →
      </a>
      <p style="margin:20px 0 0;color:#64748b;font-size:13px">Na própria página dá para aceitar a proposta ou nos dizer o que ajustar.</p>`
  });
  return enviar({ to: [para], cc: copia ? [copia] : undefined, subject: `[Marsh] Proposta ${proposta.numero} — ${proposta.titulo}`, html });
}

/** Aviso interno para os administradores da empresa (lead novo, proposta aceita/recusada) */
async function notificarAdminsComercial({ empresa_id, assunto, titulo, linhas, link }) {
  const admins = await emailsAdmins(empresa_id);
  if (!admins.length) return false;
  const html = templateBase({
    titulo, preheader: assunto,
    corpo: `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:20px">${esc(titulo)}</h2>
      <div style="background:#f8fafc;border-radius:10px;padding:20px;margin-bottom:20px;border-left:4px solid #1d6fd8">
        <table>${linhas.filter(([, v]) => v).map(([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#64748b;vertical-align:top">${esc(k)}</td><td style="font-size:13px;color:#0f172a;white-space:pre-line">${esc(v)}</td></tr>`).join('')}</table>
      </div>
      ${link ? `<a href="${esc(link)}" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Abrir no sistema →</a>` : ''}`
  });
  return enviar({ to: admins, subject: `[Marsh] ${assunto}`, html });
}

/** Licenças do Conector perto do fim: aviso aos administradores da empresa. */
async function enviarAvisoVencimentoLicencas({ para, cliente, fim, dias, renova }) {
  const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
  const data = String(fim).slice(0, 10).split('-').reverse().join('/');
  const html = templateBase({
    titulo: 'Licenças do Conector perto do vencimento', preheader: `As licenças vencem em ${dias} dia(s).`,
    corpo: `
      <h2 style="margin:0 0 12px;color:#0f172a;font-size:20px">Licenças do Conector SAP — ${esc(cliente)}</h2>
      <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6">O contrato das licenças vence em <strong>${data}</strong> (${dias} dia(s)).
        ${renova ? 'Ele será renovado automaticamente por mais 12 meses; a cobrança da nova anuidade segue pelo Financeiro.'
          : 'Para continuar usando o Conector e os cursos inclusos, fale com a Marsh para renovar.'}</p>
      <a href="${esc(base)}/login.html" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Abrir o portal →</a>`
  });
  return enviar({ to: para, subject: `Licenças do Conector vencem em ${dias} dia(s)`, html });
}

/** Loja: licenças do Conector pagas. Quem comprou administra: convida a equipe pelo portal. */
async function enviarLicencasLiberadas({ nome, email, q, fim, linkSenha, teste }) {
  const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
  const nomes = { abap: 'ABAP', funcional: 'Funcional', ambos: 'ABAP + Funcional' };
  const lista = Object.entries(q || {}).filter(([, n]) => n > 0).map(([p, n]) => `${n} ${nomes[p] || p}`).join(', ');
  const ate = String(fim).slice(0, 10).split('-').reverse().join('/');
  const html = templateBase({
    titulo: 'Suas licenças do Conector SAP', preheader: `Licenças liberadas até ${ate}.`,
    corpo: `
      ${teste ? '<p style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:13px">Compra de TESTE (homologação): nenhum valor foi cobrado.</p>' : ''}
      <h2 style="margin:0 0 12px;color:#0f172a;font-size:20px">Olá, ${esc(String(nome || '').split(' ')[0])}!</h2>
      <p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.6">Recebemos o pagamento. Suas licenças do Conector SAP (<strong>${esc(lista)}</strong>) valem até <strong>${ate}</strong>.</p>
      <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6">No portal, em <strong>Licenças do Conector SAP da empresa</strong>, convide cada pessoa pelo e-mail.
        Ela faz os cursos do perfil e, ao concluir, recebe o certificado e o instalador já configurado.</p>
      ${linkSenha
        ? `<a href="${esc(linkSenha)}" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Criar minha senha →</a>
           <p style="margin:10px 0 0;color:#64748b;font-size:12px">O link vale 72 horas.</p>`
        : `<a href="${esc(base)}/login.html" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Entrar no portal →</a>`}`
  });
  return enviar({ to: email, subject: `${teste ? '[TESTE] ' : ''}Licenças do Conector SAP liberadas`, html });
}

/** Loja: pagamento confirmado, curso liberado. linkSenha = criar a senha (primeiro acesso). */
async function enviarCursoLiberado({ nome, email, curso, fim, linkSenha, teste }) {
  const base = process.env.APP_URL || 'https://marshconsultoria.com.br';
  const ate = fim ? `até ${String(fim).slice(0, 10).split('-').reverse().join('/')}` : 'sem prazo de validade';
  const html = templateBase({
    titulo: 'Seu curso foi liberado', preheader: `${curso} já está disponível no portal.`,
    corpo: `
      ${teste ? '<p style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:13px">Compra de TESTE (homologação): nenhum valor foi cobrado.</p>' : ''}
      <h2 style="margin:0 0 12px;color:#0f172a;font-size:20px">Olá, ${esc(String(nome || '').split(' ')[0])}!</h2>
      <p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6">Recebemos o seu pagamento. O curso <strong>${esc(curso)}</strong> está liberado ${esc(ate)}.</p>
      ${linkSenha
        ? `<p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6">Para o primeiro acesso, crie a sua senha (o link vale 72 horas):</p>
           <a href="${esc(linkSenha)}" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Criar minha senha →</a>`
        : `<a href="${esc(base)}/login.html" style="display:inline-block;background:#1d6fd8;color:#fff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Entrar no portal →</a>`}`
  });
  return enviar({ to: email, subject: `${teste ? '[TESTE] ' : ''}Curso liberado: ${curso}`, html });
}

module.exports = {
  enviarCursoLiberado,
  enviarLicencasLiberadas,
  enviarAvisoVencimentoLicencas,
  notificarNovoChamado,
  notificarAtualizacaoStatus,
  notificarNovoAtendimento,
  enviarFatura,
  enviarLembreteFatura,
  enviarProposta,
  enviarAlertaSistema,
  enviarLinkSenha,
  enviarBoasVindas,
  notificarAdminsComercial,
  emailConfigurado: () => !!process.env.RESEND_API_KEY
};
