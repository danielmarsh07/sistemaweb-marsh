// Financeiro → Consumo de IA: gasto na OpenAI e na Anthropic (APIs de custos, chave de ADMINISTRADOR de cada uma)
// e saldo estimado pelas recargas lançadas aqui. Nenhum provedor informa o saldo por API.
// Gráfico: colunas por dia (colunaArredondada e escalaPasso vêm de relatorios.js).
const IA_CORES = { openai: 'var(--viz-1, #2a78d6)', anthropic: 'var(--viz-2, #d95926)' };
const usd = v => (v == null ? '—' : `US$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
let _consumoIa = null;

async function loadConsumoIa() {
  const alvo = document.getElementById('consumo-ia-cards');
  alvo.innerHTML = '<p class="fin-muted">Carregando...</p>';
  const res = await apiFetch(`${API_URL}/consumo-ia`);
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alvo.innerHTML = `<p class="fin-muted">${escapeHtml(r.erro)}</p>`; return; }
  _consumoIa = r;
  alvo.innerHTML = Object.entries(r.provedores).map(([id, p]) => cartaoConsumoIa(id, p, r.cifra)).join('');
  for (const [id, p] of Object.entries(r.provedores)) graficoGastoDiario(document.getElementById(`ia-grafico-${id}`), p.serie, IA_CORES[id]);
}

function cartaoConsumoIa(id, p, cifraOk) {
  const saldoBaixo = p.saldo_estimado != null && p.limite_alerta_usd != null && p.saldo_estimado < p.limite_alerta_usd;
  const sinc = p.ultima_sincronizacao ? `atualizado ${formatDataHora(p.ultima_sincronizacao)}` : 'ainda não sincronizado';
  return `
    <section class="rel-card ia-card">
      <header class="ia-topo">
        <h3>${escapeHtml(p.nome)}</h3>
        ${p.configurado ? chipLicenca('Conectado', '#10b981') : chipLicenca('Sem chave de administrador', '#64748b')}
        <span class="fin-muted ia-sinc">${escapeHtml(sinc)}</span>
      </header>
      <p class="fin-muted ia-onde">Usado por: ${escapeHtml(p.onde)}</p>
      ${p.ultimo_erro ? `<p class="ia-erro">Última busca falhou: ${escapeHtml(p.ultimo_erro)}</p>` : ''}
      <div class="licenca-uso-resumo">
        <div class="${saldoBaixo ? 'ia-alerta' : ''}"><span>Saldo estimado</span><strong>${p.saldo_estimado == null ? '—' : usd(p.saldo_estimado)}</strong></div>
        <div><span>Gasto hoje</span><strong>${usd(p.gasto_hoje)}</strong></div>
        <div><span>Gasto no mês</span><strong>${usd(p.gasto_mes)}</strong></div>
        <div><span>Últimos 30 dias</span><strong>${usd(p.gasto_30d)}</strong></div>
      </div>
      <p class="ficha-resumo">${p.saldo_estimado == null
        ? 'Lance a recarga atual abaixo para o sistema calcular o saldo (as APIs não informam o saldo).'
        : `Saldo estimado = ${usd(p.total_recargas)} em recargas − gasto desde ${diaBr(p.recargas[p.recargas.length - 1].data)}. Confira o valor exato no site da ${escapeHtml(p.nome)}.`}</p>
      <h4 class="ia-sub">Gasto por dia (30 dias)</h4>
      <div id="ia-grafico-${id}" class="ia-grafico"></div>
      ${p.itens_mes.length ? `
      <h4 class="ia-sub">No mês, por item</h4>
      <div class="table-container"><table>
        <thead><tr><th>Item</th><th>Gasto</th></tr></thead>
        <tbody>${p.itens_mes.slice(0, 8).map(i => `<tr><td data-label="Item">${escapeHtml(i.item)}</td><td data-label="Gasto">${usd(i.valor)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
      <h4 class="ia-sub">Recargas</h4>
      ${p.recargas.length ? `<ul class="fin-lista-itens">${p.recargas.map(rc => `
        <li><strong>${usd(rc.valor_usd)}</strong> em ${diaBr(rc.data)}${rc.observacao ? ` · ${escapeHtml(rc.observacao)}` : ''}
          <a href="#" onclick="removerRecargaIa(${rc.id}); return false;">remover</a></li>`).join('')}</ul>` : '<p class="fin-muted">Nenhuma recarga lançada.</p>'}
      <form class="form-row ia-form" onsubmit="lancarRecargaIa(event, '${id}')">
        <div class="form-group"><label>Data</label><input type="date" name="data" required value="${isoLocal()}"></div>
        <div class="form-group"><label>Valor (US$)</label><input type="number" name="valor_usd" min="0.01" step="0.01" required></div>
        <div class="form-group"><label>Observação</label><input type="text" name="observacao" maxlength="200" placeholder="Opcional"></div>
        <div class="form-group"><button type="submit" class="btn btn-secondary">Lançar recarga</button></div>
      </form>
      <h4 class="ia-sub">Conexão</h4>
      <form class="form-row ia-form" onsubmit="salvarProvedorIa(event, '${id}')">
        <div class="form-group"><label>Chave de administrador ${p.chave_prefixo ? `<small class="fin-muted">(atual: ${escapeHtml(p.chave_prefixo)})</small>` : ''}</label>
          <input type="password" name="admin_chave" autocomplete="off" placeholder="${id === 'openai' ? 'sk-admin-...' : 'sk-ant-admin...'}" ${cifraOk ? '' : 'disabled'}></div>
        <div class="form-group"><label>Avisar quando o saldo ficar abaixo de (US$)</label>
          <input type="number" name="limite_alerta_usd" min="0" step="1" value="${p.limite_alerta_usd ?? ''}"></div>
        <div class="form-group"><button type="submit" class="btn btn-primary">Salvar</button></div>
      </form>
      <small class="form-hint">${id === 'openai'
        ? 'Crie em platform.openai.com → Organization → Admin keys (de preferência só leitura). Não é a chave da Ivy.'
        : 'Crie em platform.claude.com → Settings → Admin keys (só organizações). Não é a chave de uso do sap_analytics.'}
        Fica cifrada no servidor; a tela só mostra o começo dela.</small>
    </section>`;
}

// Colunas por dia, eixo em US$, valor de cada dia no título (passe o mouse)
function graficoGastoDiario(el, serie, cor) {
  if (!el) return;
  const hoje = new Date();
  const dias = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoje.getTime() - i * 86400000).toLocaleDateString('sv-SE', { timeZone: FUSO_BR });
    dias.push({ dia: d, valor: (serie.find(s => s.dia === d) || {}).valor || 0 });
  }
  const W = Math.max(el.clientWidth, 280), H = 170, m = { t: 12, r: 8, b: 22, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(0.01, ...dias.map(d => d.valor));
  const passo = escalaPasso(max / 3);
  const topo = Math.ceil(max / passo) * passo;
  const y = v => m.t + ih - (v / topo) * ih;
  const banda = iw / dias.length, larg = Math.max(2, Math.min(14, banda * 0.7));
  let svg = '';
  for (let v = 0; v <= topo + 1e-9; v += passo) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'viz-base' : 'viz-grade'}"/>
            <text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" class="viz-eixo">${v < 10 ? v.toFixed(2) : Math.round(v)}</text>`;
  }
  dias.forEach((d, i) => {
    const x = m.l + banda * i + (banda - larg) / 2;
    if (d.valor > 0) svg += `<path d="${colunaArredondada(x, y(d.valor), larg, y(0) - y(d.valor))}" fill="${cor}"><title>${diaBr(d.dia)}: ${usd(d.valor)}</title></path>`;
    if (i % 7 === 2 || i === dias.length - 1) svg += `<text x="${m.l + banda * i + banda / 2}" y="${H - 6}" text-anchor="middle" class="viz-eixo">${d.dia.slice(8)}/${d.dia.slice(5, 7)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Gasto diário em US$ nos últimos 30 dias">${svg}</svg>`;
}

async function sincronizarConsumoIa(btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch(`${API_URL}/consumo-ia/sincronizar`, { method: 'POST' });
    if (!res) return;
    const r = await res.json();
    const falhas = Object.entries(r.resultado || {}).filter(([, v]) => !v.ok);
    if (falhas.length) alert(falhas.map(([k, v]) => `${k}: ${v.erro}`).join('\n'));
  } finally {
    if (btn) btn.disabled = false;
    loadConsumoIa();
  }
}

async function salvarProvedorIa(ev, provedor) {
  ev.preventDefault();
  const f = ev.target;
  const corpo = { limite_alerta_usd: f.limite_alerta_usd.value };
  if (f.admin_chave.value.trim()) corpo.admin_chave = f.admin_chave.value.trim();
  const res = await apiFetch(`${API_URL}/consumo-ia/${provedor}`, { method: 'PUT', body: JSON.stringify(corpo) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  if (corpo.admin_chave) await sincronizarConsumoIa(); else loadConsumoIa();
}

async function lancarRecargaIa(ev, provedor) {
  ev.preventDefault();
  const f = ev.target;
  const res = await apiFetch(`${API_URL}/consumo-ia/${provedor}/recargas`, { method: 'POST',
    body: JSON.stringify({ data: f.data.value, valor_usd: f.valor_usd.value, observacao: f.observacao.value }) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  // Recarga antes do período já buscado: sincroniza para trazer o gasto desde ela
  await sincronizarConsumoIa();
}

async function removerRecargaIa(id) {
  if (!confirm('Remover esta recarga? O saldo estimado é recalculado.')) return;
  const res = await apiFetch(`${API_URL}/consumo-ia/recargas/${id}`, { method: 'DELETE' });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  loadConsumoIa();
}
