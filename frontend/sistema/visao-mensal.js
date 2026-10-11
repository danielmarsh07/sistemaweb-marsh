// ===== VISÃO MENSAL: o controle de custos que substitui a planilha =====
// Matriz linha × mês (pelo vencimento). Usa helpers do script.js (apiFetch, API_URL, escapeHtml, formatMoeda)
// e do financeiro.js (mesAnoBr, MESES_CURTOS, hojeIso, pill, abrirNovaConta, editarConta, abrirPagarFatura).

let _vm = null;

async function loadVisaoMensal() {
  const inicio = document.getElementById('vm-inicio');
  if (!inicio.value) inicio.value = hojeIso().slice(0, 7);
  const meses = document.getElementById('vm-meses').value;
  const agrupar = document.getElementById('vm-agrupar').value;
  const box = document.getElementById('vm-tabela');
  if (!_vm) box.innerHTML = '<p class="fin-muted vm-carregando">Carregando...</p>';
  const res = await apiFetch(`${API_URL}/financeiro/visao-mensal?inicio=${inicio.value}&meses=${meses}&agrupar=${agrupar}`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="fin-muted">${escapeHtml(d.erro)}</p>`; return; }
  _vm = d;
  renderVisaoMensal();
}

const vmValor = v => (v ? formatMoeda(v).replace(/ /g, ' ') : '');

function renderVisaoMensal() {
  if (!_vm) return;
  const d = _vm;
  const natureza = document.getElementById('vm-natureza').value;
  const colAtual = m => (m === d.mes_atual ? ' fin-col-atual' : '');
  const th = d.meses.map(m => `<th scope="col" class="${colAtual(m).trim()}">${mesAnoBr(m + '-01')}</th>`).join('');

  // Filtro empresa/pessoal: refaz os totais com as linhas visíveis
  const secoes = d.secoes.map(s => {
    const linhas = s.linhas.filter(l => !natureza || l.natureza === natureza);
    const totais = Object.fromEntries(d.meses.map(m => [m, linhas.reduce((t, l) => t + l.celulas[m].valor, 0)]));
    return { ...s, linhas, totais };
  }).filter(s => s.linhas.length);

  const celulaDespesa = (l, m, iLinha, iSecao) => {
    const c = l.celulas[m];
    const titulo = c.ids.length
      ? `${l.descricao} — ${mesAnoBr(m + '-01')}${c.parcela ? ` · parcela ${c.parcela}` : ''} · ${{ paga: 'pago', aberta: 'em aberto', vencida: 'vencido', misto: 'parte paga' }[c.status]}`
      : `Lançar ${l.descricao} em ${mesAnoBr(m + '-01')}`;
    return `<td class="vm-cel vm-st-${c.status || 'vazia'}${colAtual(m)}">
      <button type="button" class="vm-btn" title="${escapeHtml(titulo)}" aria-label="${escapeHtml(titulo)}"
        onclick="vmCliqueCelula(${iSecao}, ${iLinha}, '${m}')">${c.ids.length ? vmValor(c.valor) : '<span class="vm-mais">+</span>'}</button></td>`;
  };

  const linhasSecao = (s, iSecao) => {
    const cabecalho = `
      <tr class="vm-secao">
        <th scope="rowgroup">${escapeHtml(s.titulo)}${s.cartao ? ' <span class="vm-tag">cartão</span>' : ''}</th>
        ${d.meses.map(m => {
          const total = s.totais[m];
          const pagavel = s.cartao && total && s.fatura_paga && s.fatura_paga[m] === false && !natureza;
          const paga = s.cartao && s.fatura_paga && s.fatura_paga[m] === true;
          return `<td class="fin-num${colAtual(m)}">${pagavel
            ? `<button type="button" class="vm-btn vm-fatura" title="Pagar a fatura de ${mesAnoBr(m + '-01')}" onclick="vmPagarFatura(${iSecao}, '${m}')">${vmValor(total)}</button>`
            : `${vmValor(total)}${paga ? ' <span class="vm-ok" title="Fatura paga">✓</span>' : ''}`}</td>`;
        }).join('')}
      </tr>`;
    const corpo = s.linhas.map((l, iLinha) => `
      <tr>
        <th scope="row" class="vm-item">
          <span class="vm-item-nome">${escapeHtml(l.descricao)}</span>
          <span class="vm-item-sub">${[
            l.natureza === 'pessoal' ? '<span class="vm-tag vm-tag-pessoal">pessoal</span>' : '',
            escapeHtml(s.cartao || _vm.agrupar === 'categoria' ? (l.meio || '') : (l.categoria || '')),
            l.recorrente ? 'assinatura' : l.total_parcelas ? `${l.total_parcelas}x` : ''
          ].filter(Boolean).join(' · ')}</span>
        </th>
        ${d.meses.map(m => celulaDespesa(l, m, iLinha, iSecao)).join('')}
      </tr>`).join('');
    return cabecalho + corpo;
  };

  // Receitas (faturas + contratos estimados)
  const receitas = !natureza || natureza === 'empresa' ? d.receitas : [];
  const totRec = Object.fromEntries(d.meses.map(m => [m, receitas.reduce((t, l) => t + l.celulas[m].valor, 0)]));
  const linhasReceita = receitas.map((l, i) => `
      <tr>
        <th scope="row" class="vm-item"><span class="vm-item-nome">${escapeHtml(l.descricao)}</span></th>
        ${d.meses.map(m => {
          const c = l.celulas[m];
          const st = c.status || 'vazia';
          const titulo = c.estimado && !c.ids.length ? 'Estimado: contrato ativo ainda sem fatura gerada' : 'Abrir o faturamento deste mês';
          return `<td class="vm-cel vm-st-${st}${colAtual(m)}">${c.valor
            ? `<button type="button" class="vm-btn" title="${titulo}" onclick="vmAbrirFaturamento('${m}')">${vmValor(c.valor)}</button>` : ''}</td>`;
        }).join('')}
      </tr>`).join('');

  const totPagar = Object.fromEntries(d.meses.map(m => [m, secoes.reduce((t, s) => t + s.totais[m], 0)]));
  const linhaTotal = (rotulo, valores, classe) => `
      <tr class="${classe}"><th scope="row">${rotulo}</th>${d.meses.map(m =>
        `<td class="fin-num${colAtual(m)}${valores[m] < 0 ? ' fin-negativo' : ''}">${formatMoeda(valores[m])}</td>`).join('')}</tr>`;
  const saldo = Object.fromEntries(d.meses.map(m => [m, totRec[m] - totPagar[m]]));

  document.getElementById('vm-tabela').innerHTML = `
    <table>
      <thead><tr><th scope="col"></th>${th}</tr></thead>
      <tbody>
        ${secoes.map(s => linhasSecao(s, d.secoes.findIndex(x => x.chave === s.chave))).join('') ||
          `<tr><td colspan="${d.meses.length + 1}" class="vm-vazio">Nenhum lançamento no período. Use "+ Lançamento".</td></tr>`}
        ${receitas.length ? `
        <tr class="vm-secao vm-secao-receita"><th scope="rowgroup">Receitas (líquido de retenções)</th>${d.meses.map(m =>
          `<td class="fin-num${colAtual(m)}">${vmValor(totRec[m])}</td>`).join('')}</tr>
        ${linhasReceita}` : ''}
        ${linhaTotal('Total a pagar', totPagar, 'vm-total')}
        ${natureza !== 'pessoal' ? linhaTotal('Total a receber', totRec, 'vm-total') : ''}
        ${natureza !== 'pessoal' ? linhaTotal('Saldo do mês', saldo, 'vm-saldo') : ''}
      </tbody>
    </table>`;
}

// Célula de despesa: com lançamento → editar (ou escolher, se houver mais de um); vazia → lançar naquele mês
async function vmCliqueCelula(iSecao, iLinha, mes) {
  const natureza = document.getElementById('vm-natureza').value;
  const secao = _vm.secoes[iSecao];
  const linha = secao.linhas.filter(l => !natureza || l.natureza === natureza)[iLinha];
  const cel = linha.celulas[mes];
  if (!cel.ids.length) return abrirNovaConta({ ...linha.modelo, mes });
  if (cel.ids.length === 1) return editarConta(cel.ids[0]);
  // Mais de um lançamento na mesma célula (ex.: mesma descrição lançada duas vezes no mês)
  const escolha = prompt(`Há ${cel.ids.length} lançamentos de "${linha.descricao}" em ${mesAnoBr(mes + '-01')}. Qual abrir? (1 a ${cel.ids.length})`, '1');
  const n = Number(escolha);
  if (n >= 1 && n <= cel.ids.length) editarConta(cel.ids[n - 1]);
}

function vmPagarFatura(iSecao, mes) {
  const s = _vm.secoes[iSecao];
  const abertas = s.linhas.map(l => l.celulas[mes]).filter(c => c.ids.length && c.status !== 'paga');
  abrirPagarFatura(s.cartao.id, mes, s.totais[mes], abertas.reduce((t, c) => t + c.ids.length, 0));
}

function vmAbrirFaturamento(mes) {
  // A fatura do mês M (vencimento) normalmente é da competência anterior; abre o faturamento nessa competência
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  document.getElementById('fin-competencia').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  showPage('faturamento');
}

// Exporta exatamente o que está na tela (CSV para Excel pt-BR: ; e vírgula decimal, com BOM)
function exportarVisaoMensal() {
  if (!_vm) return;
  const natureza = document.getElementById('vm-natureza').value;
  const num = v => (v ? String(Math.round(v * 100) / 100).replace('.', ',') : '');
  const campo = v => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const linhas = [['Seção', 'Item', 'Categoria', 'Natureza', ..._vm.meses.map(m => mesAnoBr(m + '-01'))]];
  for (const s of _vm.secoes) {
    for (const l of s.linhas.filter(x => !natureza || x.natureza === natureza)) {
      linhas.push([s.titulo, l.descricao, l.categoria || '', l.natureza, ..._vm.meses.map(m => num(l.celulas[m].valor))]);
    }
  }
  if (natureza !== 'pessoal') {
    for (const l of _vm.receitas) linhas.push(['Receitas', l.descricao, '', 'empresa', ..._vm.meses.map(m => num(l.celulas[m].valor))]);
  }
  const csv = '﻿' + linhas.map(l => l.map(campo).join(';')).join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `visao-mensal_${_vm.meses[0]}_a_${_vm.meses[_vm.meses.length - 1]}.csv`
  });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
