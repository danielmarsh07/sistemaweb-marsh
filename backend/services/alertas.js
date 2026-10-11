// Alertas do sistema: registra falhas importantes (tabela alertas_sistema) e avisa os administradores por e-mail.
// - Mesma "chave" ainda não lida = mesma linha (soma ocorrências), e-mail no máximo a cada 6 h por chave.
// - Destinatários: ALERTA_EMAIL (vírgula separa vários) ou os administradores ativos da empresa 1.
// - Nunca lança: um alerta que falha não pode derrubar o que estava sendo feito.
const pool = require('../db');

const INTERVALO_EMAIL_H = 6;
const corta = (s, n) => String(s == null ? '' : s).slice(0, n);

async function destinatarios() {
  if (process.env.ALERTA_EMAIL) return process.env.ALERTA_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
  const r = await pool.query(
    `SELECT email FROM usuarios WHERE empresa_id = 1 AND tipo IN ('admin_empresa','admin_sistema') AND ativo = TRUE`);
  return r.rows.map(x => x.email);
}

async function registrarAlerta({ chave, titulo, detalhe, nivel = 'erro' }) {
  try {
    chave = corta(chave || titulo, 200);
    console.error(`[ALERTA] ${titulo}${detalhe ? ' — ' + corta(detalhe, 300) : ''}`);
    const r = await pool.query(
      `UPDATE alertas_sistema SET ocorrencias = ocorrencias + 1, ultima_em = NOW(), detalhe = $2, titulo = $3
       WHERE chave = $1 AND NOT lido
       RETURNING id, (email_enviado_em IS NULL OR email_enviado_em < NOW() - make_interval(hours => $4)) AS avisar, ocorrencias`,
      [chave, corta(detalhe, 4000), corta(titulo, 255), INTERVALO_EMAIL_H]);
    let alerta = r.rows[0];
    if (!alerta) {
      alerta = (await pool.query(
        `INSERT INTO alertas_sistema (chave, nivel, titulo, detalhe) VALUES ($1, $2, $3, $4)
         RETURNING id, TRUE AS avisar, ocorrencias`, [chave, nivel, corta(titulo, 255), corta(detalhe, 4000)])).rows[0];
    }
    if (!alerta.avisar) return;
    const email = require('./email'); // tardio: email.js também chama registrarAlerta
    const para = await destinatarios();
    if (!para.length || !email.emailConfigurado()) return;
    const ok = await email.enviarAlertaSistema({ para, titulo, detalhe, ocorrencias: alerta.ocorrencias });
    if (ok) await pool.query('UPDATE alertas_sistema SET email_enviado_em = NOW() WHERE id = $1', [alerta.id]);
  } catch (err) {
    console.error('[ALERTA] não foi possível registrar:', err.message);
  }
}

// Middleware: toda resposta 5xx vira alerta (agrupado por método + rota, com os ids trocados por :id)
function alertarErros500(req, res, next) {
  const jsonOriginal = res.json;
  res.json = function (corpo) { res.locals.corpoResposta = corpo; return jsonOriginal.call(this, corpo); };
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    const rota = `${req.method} ${(req.baseUrl || '') + (req.path || '')}`.replace(/\/\d+(?=\/|$)/g, '/:id');
    const c = res.locals.corpoResposta || {};
    registrarAlerta({
      chave: `http:${rota}`,
      titulo: `Erro ${res.statusCode} em ${rota}`,
      detalhe: [c.erro, c.detalhe].filter(Boolean).join(' — ') || 'sem detalhe'
    });
  });
  next();
}

module.exports = { registrarAlerta, alertarErros500 };
