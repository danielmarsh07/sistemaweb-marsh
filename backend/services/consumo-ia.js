// Consumo de IA (Financeiro → Consumo de IA): gasto diário na OpenAI e na Anthropic pelas APIs de custos de cada uma
// (exigem a chave de ADMINISTRADOR da organização, guardada cifrada) e saldo estimado pelas recargas lançadas à mão.
// Nenhum dos dois provedores informa o saldo de crédito por API: saldo estimado = recargas − gasto desde a 1ª recarga.
//   OpenAI:    GET /v1/organization/costs   (Authorization: Bearer <admin key>; amount { value (US$), currency })
//   Anthropic: GET /v1/organizations/cost_report (x-api-key: <admin key sk-ant-admin...>; amount em centavos, texto)
const pool = require('../db');
const cifra = require('./cifra');
const email = require('./email');

const PROVEDORES = {
  openai: { nome: 'OpenAI', prefixo: /^sk-admin-/, onde: 'Ivy (assistente de voz do sistema: conversa e voz)' },
  anthropic: { nome: 'Anthropic', prefixo: /^sk-ant-admin/, onde: 'sap_analytics (pasta SAP) e Agente ABAP (workspace "Agente ABAP")' }
};
// URLs trocáveis só para o teste automático (servidor falso local)
const URL_OPENAI = () => (process.env.CONSUMO_IA_OPENAI_URL || 'https://api.openai.com').replace(/\/+$/, '');
const URL_ANTHROPIC = () => (process.env.CONSUMO_IA_ANTHROPIC_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const DIA_MS = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = corpo?.error?.message || corpo?.error?.type || corpo?.erro || `HTTP ${r.status}`;
    const e = new Error(r.status === 401 || r.status === 403
      ? `Chave de administrador recusada (${msg}). Confira se é a chave ADMIN da organização.` : msg);
    e.status = r.status;
    throw e;
  }
  return corpo;
}

/** { 'AAAA-MM-DD': { total, itens: { descricao: valor } } } a partir de `desde` (Date) até hoje. */
async function custosOpenAI(chave, desde) {
  const dias = {};
  let page = null;
  for (let i = 0; i < 40; i++) {
    const qs = new URLSearchParams({ start_time: String(Math.floor(desde.getTime() / 1000)), bucket_width: '1d', limit: '31' });
    qs.append('group_by', 'line_item');
    if (page) qs.set('page', page);
    const r = await getJson(`${URL_OPENAI()}/v1/organization/costs?${qs}`, { Authorization: `Bearer ${chave}` });
    for (const b of r.data || []) {
      const dia = iso(Number(b.start_time) * 1000);
      const d = dias[dia] || (dias[dia] = { total: 0, itens: {} });
      for (const x of b.results || []) {
        const valor = Number(typeof x.amount === 'object' && x.amount ? x.amount.value : x.amount) || 0;
        d.total += valor;
        const item = x.line_item || 'Outros';
        d.itens[item] = (d.itens[item] || 0) + valor;
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return dias;
}

async function custosAnthropic(chave, desde) {
  const dias = {};
  let page = null;
  for (let i = 0; i < 40; i++) {
    const qs = new URLSearchParams({ starting_at: desde.toISOString().replace(/\.\d{3}Z$/, 'Z'), bucket_width: '1d', limit: '31' });
    qs.append('group_by[]', 'description');
    if (page) qs.set('page', page);
    const r = await getJson(`${URL_ANTHROPIC()}/v1/organizations/cost_report?${qs}`,
      { 'x-api-key': chave, 'anthropic-version': '2023-06-01' });
    for (const b of r.data || []) {
      const dia = iso(b.starting_at);
      const d = dias[dia] || (dias[dia] = { total: 0, itens: {} });
      for (const x of b.results || []) {
        const valor = (Number(x.amount) || 0) / 100; // centavos de US$ em texto decimal
        d.total += valor;
        const item = x.description || x.model || x.cost_type || 'Outros';
        d.itens[item] = (d.itens[item] || 0) + valor;
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return dias;
}

/** Busca o gasto de cada provedor configurado e grava por dia. Volta 35 dias (ou desde a 1ª recarga, até 1 ano). */
async function sincronizar(empresaId = 1) {
  const provs = (await pool.query(
    'SELECT * FROM ia_provedores WHERE empresa_id = $1 AND admin_chave_cifrada IS NOT NULL', [empresaId])).rows;
  const resultado = {};
  for (const p of provs) {
    try {
      const chave = cifra.decifrar(p.admin_chave_cifrada);
      const primeira = (await pool.query(
        'SELECT MIN(data) AS d FROM ia_recargas WHERE empresa_id = $1 AND provedor = $2', [empresaId, p.provedor])).rows[0].d;
      const ultimaSinc = p.ultima_sincronizacao ? new Date(p.ultima_sincronizacao) : null;
      let desde = new Date(Date.now() - 35 * DIA_MS);
      // primeira sincronização (ou recarga antiga lançada depois): busca o histórico desde a recarga
      if (primeira && (!ultimaSinc || new Date(primeira) < desde)) desde = new Date(Math.max(new Date(primeira).getTime(), Date.now() - 365 * DIA_MS));
      desde = new Date(`${iso(desde)}T00:00:00Z`);
      const dias = p.provedor === 'openai' ? await custosOpenAI(chave, desde) : await custosAnthropic(chave, desde);
      for (const [dia, d] of Object.entries(dias)) {
        await pool.query(
          `INSERT INTO ia_custos_diarios (empresa_id, provedor, dia, valor_usd, detalhe, atualizado_em)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (empresa_id, provedor, dia) DO UPDATE SET valor_usd = EXCLUDED.valor_usd, detalhe = EXCLUDED.detalhe, atualizado_em = NOW()`,
          [empresaId, p.provedor, dia, d.total.toFixed(6), JSON.stringify(d.itens)]);
      }
      await pool.query(`UPDATE ia_provedores SET ultima_sincronizacao = NOW(), ultimo_erro = NULL WHERE empresa_id = $1 AND provedor = $2`,
        [empresaId, p.provedor]);
      resultado[p.provedor] = { ok: true, dias: Object.keys(dias).length };
    } catch (err) {
      await pool.query(`UPDATE ia_provedores SET ultimo_erro = $3 WHERE empresa_id = $1 AND provedor = $2`,
        [empresaId, p.provedor, String(err.message).slice(0, 500)]);
      resultado[p.provedor] = { ok: false, erro: err.message };
    }
  }
  return resultado;
}

/** Resumo do painel: por provedor, gasto hoje/mês/30 dias, série diária, itens do mês, recargas e saldo estimado. */
async function resumo(empresaId = 1) {
  const hoje = iso(Date.now());
  const inicioMes = `${hoje.slice(0, 7)}-01`;
  const saida = {};
  for (const [id, info] of Object.entries(PROVEDORES)) {
    const p = (await pool.query('SELECT * FROM ia_provedores WHERE empresa_id = $1 AND provedor = $2', [empresaId, id])).rows[0];
    const recargas = (await pool.query(
      `SELECT id, to_char(data, 'YYYY-MM-DD') AS data, valor_usd::float AS valor_usd, observacao FROM ia_recargas
       WHERE empresa_id = $1 AND provedor = $2 ORDER BY data DESC, id DESC`, [empresaId, id])).rows;
    const serie = (await pool.query(
      `SELECT to_char(dia, 'YYYY-MM-DD') AS dia, valor_usd::float AS valor, detalhe FROM ia_custos_diarios
       WHERE empresa_id = $1 AND provedor = $2 AND dia >= CURRENT_DATE - 29 ORDER BY dia`, [empresaId, id])).rows;
    const soma = async (desde) => Number((await pool.query(
      `SELECT COALESCE(SUM(valor_usd), 0)::float AS s FROM ia_custos_diarios WHERE empresa_id = $1 AND provedor = $2 AND dia >= $3`,
      [empresaId, id, desde])).rows[0].s);
    const itensMes = {};
    for (const d of (await pool.query(
      `SELECT detalhe FROM ia_custos_diarios WHERE empresa_id = $1 AND provedor = $2 AND dia >= $3`, [empresaId, id, inicioMes])).rows) {
      for (const [k, v] of Object.entries(d.detalhe || {})) itensMes[k] = (itensMes[k] || 0) + Number(v);
    }
    const primeira = recargas.length ? recargas[recargas.length - 1].data : null;
    const totalRecargas = recargas.reduce((s, r) => s + r.valor_usd, 0);
    const gastoDesdeRecarga = primeira ? await soma(primeira) : 0;
    saida[id] = {
      nome: info.nome, onde: info.onde,
      configurado: !!(p && p.admin_chave_cifrada), chave_prefixo: p?.chave_prefixo || null,
      ultima_sincronizacao: p?.ultima_sincronizacao || null, ultimo_erro: p?.ultimo_erro || null,
      limite_alerta_usd: p?.limite_alerta_usd != null ? Number(p.limite_alerta_usd) : null,
      gasto_hoje: await soma(hoje), gasto_mes: await soma(inicioMes),
      gasto_30d: serie.reduce((s, d) => s + d.valor, 0),
      serie: serie.map(d => ({ dia: d.dia, valor: d.valor })),
      itens_mes: Object.entries(itensMes).map(([item, valor]) => ({ item, valor })).sort((a, b) => b.valor - a.valor),
      recargas, total_recargas: totalRecargas,
      saldo_estimado: primeira ? totalRecargas - gastoDesdeRecarga : null
    };
  }
  return saida;
}

/** Saldo estimado abaixo do limite: e-mail aos administradores (no máximo 1 por dia por provedor). */
async function avisarSaldoBaixo(empresaId = 1) {
  const r = await resumo(empresaId);
  for (const [id, s] of Object.entries(r)) {
    if (s.saldo_estimado == null || s.limite_alerta_usd == null || s.saldo_estimado >= s.limite_alerta_usd) continue;
    const marcou = (await pool.query(
      `UPDATE ia_provedores SET alerta_enviado_em = NOW() WHERE empresa_id = $1 AND provedor = $2
         AND (alerta_enviado_em IS NULL OR alerta_enviado_em < NOW() - INTERVAL '1 day') RETURNING provedor`, [empresaId, id])).rows.length;
    if (!marcou) continue;
    const usd = v => `US$ ${Number(v).toFixed(2).replace('.', ',')}`;
    await email.notificarAdminsComercial({
      empresa_id: empresaId,
      assunto: `Crédito de IA baixo: ${s.nome} com saldo estimado de ${usd(s.saldo_estimado)}`,
      titulo: `Crédito ${s.nome} perto do fim`,
      linhas: [['Saldo estimado', usd(s.saldo_estimado)], ['Limite de alerta', usd(s.limite_alerta_usd)],
        ['Gasto no mês', usd(s.gasto_mes)], ['Usado por', s.onde],
        ['O que fazer', `Recarregue no site da ${s.nome} e lance a recarga em Financeiro → Consumo de IA.`]],
      link: `${process.env.APP_URL || 'https://marshconsultoria.com.br'}/dashboard.html`
    }).catch(() => {});
  }
}

/** Rotina: a cada 6 horas busca o gasto de quem tem chave cadastrada e avisa saldo baixo. */
function iniciar() {
  const rodar = async () => {
    try {
      const emps = (await pool.query('SELECT DISTINCT empresa_id FROM ia_provedores WHERE admin_chave_cifrada IS NOT NULL')).rows;
      for (const { empresa_id } of emps) {
        await sincronizar(empresa_id);
        await avisarSaldoBaixo(empresa_id);
      }
    } catch (err) {
      require('./alertas').registrarAlerta({ chave: 'job:consumo-ia', titulo: 'Rotina: falha ao buscar o consumo de IA', detalhe: err.message });
    }
  };
  setTimeout(rodar, 2 * 60 * 1000);
  setInterval(rodar, 6 * 60 * 60 * 1000);
}

module.exports = { PROVEDORES, sincronizar, resumo, avisarSaldoBaixo, custosOpenAI, custosAnthropic, iniciar };
