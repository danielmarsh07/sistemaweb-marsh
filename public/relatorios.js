// ===== RELATÓRIOS: MRR, faturado × recebido, clientes, atraso, recebimento, funil e exportação CSV =====
// Usa helpers do script.js (apiFetch, API_URL, escapeHtml, formatMoeda) e do financeiro.js (mesAnoBr, MESES_CURTOS).
// Gráficos em SVG próprio: cores pelas variáveis --viz-* (validadas para os temas claro e escuro em styles.css).

let _rel = null;

const moedaCurta = v => {
  const a = Math.abs(v);
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `R$ ${Math.round(v)}`;
};

async function loadRelatorios() {
  const meses = document.getElementById('rel-meses').value;
  document.getElementById('rel-tiles').innerHTML = '<p class="fin-muted">Carregando...</p>';
  const res = await apiFetch(`${API_URL}/financeiro/relatorios?meses=${meses}`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { document.getElementById('rel-tiles').innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }
  _rel = d;
  document.getElementById('rel-periodo').textContent = `${mesAnoBr(d.inicio)} a ${mesAnoBr(d.mes_atual)}`;
  renderRelatorios();
}

function renderRelatorios() {
  if (!_rel) return;
  const d = _rel;
  const ult = d.meses[d.meses.length - 1];
  const pri = d.meses[0];
  const recebido = d.meses.reduce((s, m) => s + m.recebido, 0);
  const faturado = d.meses.reduce((s, m) => s + m.faturado, 0);
  const rc = d.recebimento;
  const fn = d.funil;
  const fechadas = fn.ganhas + fn.perdidas;
  const variacao = pri.mrr ? ((ult.mrr - pri.mrr) / pri.mrr) * 100 : null;

  const tile = (rotulo, valor, detalhe, delta) => `
    <div class="rel-tile">
      <span class="rel-tile-rotulo">${rotulo}</span>
      <span class="rel-tile-valor">${valor}</span>
      ${delta || ''}
      <span class="rel-tile-detalhe">${detalhe}</span>
    </div>`;
  const deltaHtml = variacao === null ? '' : `<span class="rel-delta ${variacao >= 0 ? 'sobe' : 'desce'}">
    ${variacao >= 0 ? '▲' : '▼'} ${Math.abs(variacao).toFixed(1).replace('.', ',')}% desde ${mesAnoBr(pri.mes)}</span>`;
  document.getElementById('rel-tiles').innerHTML = [
    tile('MRR atual', formatMoeda(ult.mrr), `${ult.contratos} contrato(s) vigente(s)`, deltaHtml),
    tile('Recebido no período', formatMoeda(recebido), `faturado ${formatMoeda(faturado)}`),
    tile('Prazo de recebimento', rc.pagas ? `${rc.dias_medio > 0 ? '+' : ''}${String(rc.dias_medio).replace('.', ',')} dias` : '—',
      rc.pagas ? `em relação ao vencimento · ${Math.round((rc.em_dia / rc.pagas) * 100)}% pagas em dia` : 'nenhuma fatura paga no período'),
    tile('Conversão do funil', fechadas ? `${Math.round((fn.ganhas / fechadas) * 100)}%` : '—',
      `${fn.ganhas} ganha(s) de ${fechadas} fechada(s)${fn.ciclo_dias != null ? ` · ciclo ${fn.ciclo_dias} dias` : ''}`)
  ].join('');

  graficoColunas(document.getElementById('rel-graf-mrr'), d.meses, [{ chave: 'mrr', nome: 'MRR', cor: 'var(--viz-1)' }],
    m => [['MRR', formatMoeda(m.mrr)], ['Novos', formatMoeda(m.novo)], ['Encerrados', formatMoeda(m.encerrado)], ['Contratos', m.contratos]]);
  graficoColunas(document.getElementById('rel-graf-fat'), d.meses,
    [{ chave: 'faturado', nome: 'Faturado', cor: 'var(--viz-1)' }, { chave: 'recebido', nome: 'Recebido', cor: 'var(--viz-2)' }],
    m => [['Faturado', formatMoeda(m.faturado)], ['Recebido', formatMoeda(m.recebido)]]);

  // Tabela mês a mês (a visão em tabela dos dois gráficos)
  const col = (v, neg) => `<td class="fin-num${neg && v < 0 ? ' fin-negativo' : ''}">${v ? formatMoeda(v) : '<span class="fin-muted">—</span>'}</td>`;
  document.getElementById('rel-tabela-meses').innerHTML = `
    <table>
      <thead><tr><th>Mês</th><th>MRR</th><th>Novos</th><th>Encerrados</th><th>Variação</th><th>Contratos</th><th>Faturado</th><th>Recebido</th></tr></thead>
      <tbody>${d.meses.map(m => `
        <tr><th scope="row">${mesAnoBr(m.mes)}</th>${col(m.mrr)}${col(m.novo)}${col(-m.encerrado, true)}${col(m.liquido, true)}
          <td class="fin-num">${m.contratos}</td>${col(m.faturado)}${col(m.recebido)}</tr>`).join('')}
      </tbody>
    </table>`;

  // Receita por cliente: barra de participação (meter) + valores
  document.getElementById('rel-clientes').innerHTML = d.clientes.length ? `
    <div class="rel-clientes">${d.clientes.slice(0, 10).map(c => `
      <div class="rel-cliente">
        <div class="rel-cliente-topo"><span>${escapeHtml(c.cliente)}</span><strong>${formatMoeda(c.faturado)}</strong></div>
        <div class="rel-barra" role="meter" aria-valuenow="${c.participacao}" aria-valuemin="0" aria-valuemax="100"
             aria-label="${escapeHtml(c.cliente)}: ${String(c.participacao).replace('.', ',')}% do faturado">
          <span style="width:${Math.max(c.participacao, 1)}%"></span></div>
        <div class="rel-cliente-rodape"><span>${String(c.participacao).replace('.', ',')}% do total</span>
          <span>recebido ${formatMoeda(c.recebido)}</span></div>
      </div>`).join('')}
    </div>
    ${d.clientes[0].participacao >= 50 ? `<p class="fin-aviso rel-aviso">${escapeHtml(d.clientes[0].cliente)} concentra ${String(d.clientes[0].participacao).replace('.', ',')}% do faturamento do período.</p>` : ''}`
    : '<p class="fin-muted">Nenhuma fatura no período.</p>';

  // Aging (status: rótulo + valor; cor só reforça)
  const faixas = { a_vencer: ['A vencer', 'ok'], d1_30: ['1 a 30 dias', 'alerta'], d31_60: ['31 a 60 dias', 'serio'], d61_90: ['61 a 90 dias', 'critico'], d90: ['Mais de 90 dias', 'critico'] };
  document.getElementById('rel-aging').innerHTML = `<div class="rel-aging">${d.aging.map(a => `
    <div class="rel-aging-item rel-${faixas[a.faixa][1]}">
      <span>${faixas[a.faixa][0]}</span><strong>${formatMoeda(a.total)}</strong><small>${a.qtd} fatura(s)</small>
    </div>`).join('')}</div>`;

  document.getElementById('rel-funil').innerHTML = `
    <div class="rel-funil">
      <div><span>Oportunidades criadas</span><strong>${fn.criadas}</strong></div>
      <div><span>Ganhas / perdidas</span><strong>${fn.ganhas} / ${fn.perdidas}</strong></div>
      <div><span>Ticket médio mensal (ganhas)</span><strong>${fn.ticket_mensal ? formatMoeda(fn.ticket_mensal) : '—'}</strong></div>
    </div>
    ${fn.motivos.length ? `<p class="fin-muted rel-motivos">Motivos de perda: ${fn.motivos.map(m => `${escapeHtml(m.motivo)} (${m.qtd})`).join(' · ')}</p>` : ''}`;
}

// Colunas (1 ou 2 séries) com baseline única, ticks redondos, rótulo só no último ponto e tooltip por mês
function graficoColunas(el, dados, series, linhasTooltip) {
  const W = Math.max(el.clientWidth, 280), H = 230;
  const m = { t: 18, r: 8, b: 26, l: 62 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...dados.flatMap(d => series.map(s => d[s.chave])));
  const passo = escalaPasso(max / 4);
  const topo = Math.ceil(max / passo) * passo;
  const y = v => m.t + ih - (v / topo) * ih;
  const banda = iw / dados.length;
  const larg = Math.min(24, (banda * 0.7 - 2 * (series.length - 1)) / series.length);
  const grupo = larg * series.length + 2 * (series.length - 1);
  const cada = Math.max(1, Math.ceil(44 / banda)); // rótulo do mês a cada N colunas, sem encostar

  let svg = '';
  for (let v = 0; v <= topo; v += passo) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'viz-base' : 'viz-grade'}"/>
            <text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" class="viz-eixo">${moedaCurta(v)}</text>`;
  }
  dados.forEach((d, i) => {
    const x0 = m.l + banda * i + (banda - grupo) / 2;
    series.forEach((s, j) => {
      const v = d[s.chave];
      if (v > 0) svg += `<path d="${colunaArredondada(x0 + j * (larg + 2), y(v), larg, y(0) - y(v))}" fill="${s.cor}"/>`;
    });
    if ((dados.length - 1 - i) % cada === 0) { // conta a partir do último mês, que sempre aparece
      svg += `<text x="${m.l + banda * i + banda / 2}" y="${H - 8}" text-anchor="middle" class="viz-eixo">${MESES_CURTOS[Number(d.mes.slice(5)) - 1]}${d.mes.slice(5) === '01' || i === (dados.length - 1) % cada ? `/${d.mes.slice(2, 4)}` : ''}</text>`;
    }
    svg += `<rect x="${m.l + banda * i}" y="${m.t}" width="${banda}" height="${ih}" class="viz-alvo" data-i="${i}"/>`;
  });
  // Rótulo direto só no último mês da primeira série
  const u = dados[dados.length - 1];
  if (series.length === 1 && u[series[0].chave] > 0) {
    svg += `<text x="${m.l + banda * (dados.length - 1) + banda / 2}" y="${y(u[series[0].chave]) - 6}" text-anchor="end" class="viz-rotulo">${moedaCurta(u[series[0].chave])}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" aria-hidden="true">${svg}</svg>`;

  const tip = document.getElementById('rel-tooltip');
  el.querySelectorAll('.viz-alvo').forEach(r => {
    const mostrar = ev => {
      const d = dados[Number(r.dataset.i)];
      el.querySelectorAll('.viz-alvo').forEach(o => o.classList.toggle('ativo', o === r));
      tip.innerHTML = `<strong>${mesAnoBr(d.mes)}</strong>${linhasTooltip(d).map(([k, v], idx) => `
        <div>${series[idx] ? `<i style="background:${series[idx].cor}"></i>` : '<i class="vazio"></i>'}<span>${k}</span><b>${v}</b></div>`).join('')}`;
      tip.hidden = false;
      const px = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const py = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, px + 14))}px`;
      tip.style.top = `${py + 14}px`;
    };
    r.addEventListener('mousemove', mostrar);
    r.addEventListener('touchstart', mostrar, { passive: true });
    r.addEventListener('mouseleave', () => { tip.hidden = true; r.classList.remove('ativo'); });
  });
}

// Coluna com topo arredondado (4px) e base reta
function colunaArredondada(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function escalaPasso(bruto) {
  const p = Math.pow(10, Math.floor(Math.log10(bruto)));
  const n = bruto / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// Exporta o mesmo período da tela; usa fetch com o token e baixa como arquivo
async function exportarCsv(tipo) {
  const meses = Number(document.getElementById('rel-meses').value);
  const fim = new Date();
  const ini = new Date(fim.getFullYear(), fim.getMonth() - (meses - 1), 1);
  const f = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const res = await apiFetch(`${API_URL}/financeiro/exportar/${tipo}.csv?inicio=${f(ini)}&fim=${f(fim)}`);
  if (!res) return;
  if (!res.ok) { const e = await res.json(); alert(e.erro); return; }
  const blob = await res.blob();
  const nome = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || `${tipo}.csv`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nome });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Redesenha ao mudar a largura (os gráficos são medidos pelo contêiner)
let _relResize;
window.addEventListener('resize', () => {
  clearTimeout(_relResize);
  _relResize = setTimeout(() => { if (_rel && document.getElementById('relatorios-page').classList.contains('active')) renderRelatorios(); }, 200);
});
document.addEventListener('scroll', () => { const t = document.getElementById('rel-tooltip'); if (t) t.hidden = true; }, { passive: true });
