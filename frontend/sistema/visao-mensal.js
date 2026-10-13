// ===== VISÃO MENSAL: o controle de custos que substitui a planilha =====
// Matriz linha × mês (pelo vencimento). Usa helpers do script.js (apiFetch, API_URL, escapeHtml, formatMoeda)
// e do financeiro.js (mesAnoBr, MESES_CURTOS, hojeIso, pill, abrirNovaConta, editarConta, abrirPagarFatura).

let _vm = null;
let _vmOrdemMes = null; // { mes, dir } — clique no cabeçalho de um mês (tem prioridade sobre o select "Ordenar")

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
  if (_vmOrdemMes && !d.meses.includes(_vmOrdemMes.mes)) _vmOrdemMes = null;
  vmPreencherCategorias();
  renderVisaoMensal();
}

const vmValor = v => (v ? formatMoeda(v).replace(/ /g, ' ') : '');
const vmNorm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function vmPreencherCategorias() {
  const sel = document.getElementById('vm-categoria');
  const atual = sel.value;
  const cats = [...new Set(_vm.secoes.flatMap(s => s.linhas.map(l => l.categoria)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  sel.innerHTML = '<option value="">Todas as categorias</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = cats.includes(atual) ? atual : '';
}

let _vmTimerBusca = null;
function vmAgendarRender() { clearTimeout(_vmTimerBusca); _vmTimerBusca = setTimeout(renderVisaoMensal, 200); }

function vmMudarOrdem() { _vmOrdemMes = null; renderVisaoMensal(); }

// Clique no mês: maior → menor → ordem padrão
function vmOrdenarMes(mes) {
  if (!_vmOrdemMes || _vmOrdemMes.mes !== mes) _vmOrdemMes = { mes, dir: 'desc' };
  else if (_vmOrdemMes.dir === 'desc') _vmOrdemMes = { mes, dir: 'asc' };
  else _vmOrdemMes = null;
  renderVisaoMensal();
}

function vmFiltrosAtuais() {
  return {
    natureza: document.getElementById('vm-natureza').value,
    busca: vmNorm(document.getElementById('vm-busca').value).split(/\s+/).filter(Boolean),
    categoria: document.getElementById('vm-categoria').value,
    tipo: document.getElementById('vm-tipo').value,
    situacao: document.getElementById('vm-situacao').value,
    ordem: document.getElementById('vm-ordem').value
  };
}

function vmLinhaPassa(l, f, meses) {
  if (f.natureza && l.natureza !== f.natureza) return false;
  if (f.categoria && l.categoria !== f.categoria) return false;
  if (f.tipo === 'assinatura' && !l.recorrente) return false;
  if (f.tipo === 'parcelado' && (l.recorrente || !l.total_parcelas)) return false;
  if (f.tipo === 'avulso' && (l.recorrente || l.total_parcelas)) return false;
  if (f.situacao) {
    const sts = meses.map(m => l.celulas[m].status).filter(Boolean);
    if (f.situacao === 'pendente' && !sts.some(s => s === 'aberta' || s === 'vencida' || s === 'misto')) return false;
    if (f.situacao === 'vencida' && !sts.includes('vencida')) return false;
    if (f.situacao === 'paga' && (!sts.length || sts.some(s => s !== 'paga'))) return false;
  }
  if (f.busca.length) {
    const texto = vmNorm([l.descricao, l.categoria, l.meio].filter(Boolean).join(' '));
    if (!f.busca.every(t => texto.includes(t))) return false;
  }
  return true;
}

// Métrica usada para ordenar linhas e seções: valor do mês clicado ou total do período
function vmComparador(f, meses) {
  const total = celulas => (_vmOrdemMes ? celulas[_vmOrdemMes.mes] : meses.reduce((t, m) => t + celulas[m], 0));
  if (_vmOrdemMes) return (a, b) => (_vmOrdemMes.dir === 'desc' ? total(b.v) - total(a.v) : total(a.v) - total(b.v));
  if (f.ordem === 'total_desc') return (a, b) => total(b.v) - total(a.v);
  if (f.ordem === 'total_asc') return (a, b) => total(a.v) - total(b.v);
  if (f.ordem === 'nome') return (a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true });
  return null;
}

// Seções e linhas como aparecem na tela (filtradas e ordenadas). Cada linha guarda _i = índice original
// na seção, e cada seção guarda iSecao = índice original: é o que os cliques usam.
function vmSecoesVisiveis(f) {
  const d = _vm;
  const valoresPorMes = l => Object.fromEntries(d.meses.map(m => [m, l.celulas[m].valor]));
  const cmp = vmComparador(f, d.meses);
  const secoes = d.secoes.map((s, iSecao) => {
    let linhas = s.linhas.map((l, i) => ({ ...l, _i: i })).filter(l => vmLinhaPassa(l, f, d.meses));
    if (cmp) {
      linhas = linhas.map(l => ({ l, v: valoresPorMes(l), nome: l.descricao })).sort(cmp).map(x => x.l);
    }
    const totais = Object.fromEntries(d.meses.map(m => [m, linhas.reduce((t, l) => t + l.celulas[m].valor, 0)]));
    return { ...s, iSecao, linhas, totais };
  }).filter(s => s.linhas.length);
  if (cmp) return secoes.map(s => ({ s, v: s.totais, nome: s.titulo })).sort(cmp).map(x => x.s);
  return secoes;
}

// Receitas: só sem filtro de despesa (categoria, tipo, situação) e fora do "só pessoal"; a busca vale também aqui
function vmReceitasVisiveis(f) {
  if (f.natureza === 'pessoal' || f.categoria || f.tipo || f.situacao) return [];
  let rec = _vm.receitas.filter(l => !f.busca.length || f.busca.every(t => vmNorm(l.descricao).includes(t)));
  const cmp = vmComparador(f, _vm.meses);
  if (cmp) {
    rec = rec.map(l => ({ l, v: Object.fromEntries(_vm.meses.map(m => [m, l.celulas[m].valor])), nome: l.descricao }))
      .sort(cmp).map(x => x.l);
  }
  return rec;
}

function renderVisaoMensal() {
  if (!_vm) return;
  const d = _vm;
  const f = vmFiltrosAtuais();
  const filtrando = !!(f.natureza || f.busca.length || f.categoria || f.tipo || f.situacao);
  const colAtual = m => (m === d.mes_atual ? ' fin-col-atual' : '');
  const th = d.meses.map(m => {
    const ativo = _vmOrdemMes && _vmOrdemMes.mes === m;
    const aria = ativo ? ` aria-sort="${_vmOrdemMes.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col" class="th-ordenavel${colAtual(m)}"${aria}>
      <button type="button" class="th-ordenar" title="Ordenar pelo valor de ${mesAnoBr(m + '-01')}" onclick="vmOrdenarMes('${m}')">
        <span>${mesAnoBr(m + '-01')}</span><span class="th-seta" aria-hidden="true"></span></button></th>`;
  }).join('');

  const secoes = vmSecoesVisiveis(f);

  const celulaDespesa = (l, m, iSecao) => {
    const c = l.celulas[m];
    const titulo = c.ids.length
      ? `${l.descricao} — ${mesAnoBr(m + '-01')}${c.parcela ? ` · parcela ${c.parcela}` : ''} · ${{ paga: 'pago', aberta: 'em aberto', vencida: 'vencido', misto: 'parte paga' }[c.status]}`
      : `Lançar ${l.descricao} em ${mesAnoBr(m + '-01')}`;
    return `<td class="vm-cel vm-st-${c.status || 'vazia'}${colAtual(m)}">
      <button type="button" class="vm-btn" title="${escapeHtml(titulo)}" aria-label="${escapeHtml(titulo)}"
        onclick="vmCliqueCelula(${iSecao}, ${l._i}, '${m}')">${c.ids.length ? vmValor(c.valor) : '<span class="vm-mais">+</span>'}</button></td>`;
  };

  const linhasSecao = s => {
    const cabecalho = `
      <tr class="vm-secao">
        <th scope="rowgroup">${escapeHtml(s.titulo)}${s.cartao ? ' <span class="vm-tag">cartão</span>' : ''}</th>
        ${d.meses.map(m => {
          const total = s.totais[m];
          // Com filtro o total é parcial: pagar a fatura só com a seção inteira na tela
          const pagavel = s.cartao && total && s.fatura_paga && s.fatura_paga[m] === false && !filtrando;
          const paga = s.cartao && s.fatura_paga && s.fatura_paga[m] === true;
          return `<td class="fin-num${colAtual(m)}">${pagavel
            ? `<button type="button" class="vm-btn vm-fatura" title="Pagar a fatura de ${mesAnoBr(m + '-01')}" onclick="vmPagarFatura(${s.iSecao}, '${m}')">${vmValor(total)}</button>`
            : `${vmValor(total)}${paga ? ' <span class="vm-ok" title="Fatura paga">✓</span>' : ''}`}</td>`;
        }).join('')}
      </tr>`;
    const corpo = s.linhas.map(l => `
      <tr>
        <th scope="row" class="vm-item">
          <span class="vm-item-nome">${escapeHtml(l.descricao)}</span>
          <span class="vm-item-sub">${[
            l.natureza === 'pessoal' ? '<span class="vm-tag vm-tag-pessoal">pessoal</span>' : '',
            escapeHtml(s.cartao || _vm.agrupar === 'categoria' ? (l.meio || '') : (l.categoria || '')),
            l.recorrente ? 'assinatura' : l.total_parcelas ? `${l.total_parcelas}x` : ''
          ].filter(Boolean).join(' · ')}</span>
        </th>
        ${d.meses.map(m => celulaDespesa(l, m, s.iSecao)).join('')}
      </tr>`).join('');
    return cabecalho + corpo;
  };

  // Receitas (faturas + contratos estimados)
  const receitas = vmReceitasVisiveis(f);
  const totRec = Object.fromEntries(d.meses.map(m => [m, receitas.reduce((t, l) => t + l.celulas[m].valor, 0)]));
  const linhasReceita = receitas.map(l => `
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
  const comReceita = f.natureza !== 'pessoal' && receitas.length > 0;

  const totalLinhas = d.secoes.reduce((t, s) => t + s.linhas.length, 0);
  const visiveis = secoes.reduce((t, s) => t + s.linhas.length, 0);
  document.getElementById('vm-contador').textContent = filtrando ? `${visiveis} de ${totalLinhas} lançamento(s)` : `${totalLinhas} lançamento(s)`;

  document.getElementById('vm-tabela').innerHTML = `
    <table>
      <thead><tr><th scope="col"></th>${th}</tr></thead>
      <tbody>
        ${secoes.map(linhasSecao).join('') ||
          `<tr><td colspan="${d.meses.length + 1}" class="vm-vazio">${filtrando
            ? 'Nenhum lançamento com esses filtros.' : 'Nenhum lançamento no período. Use "+ Lançamento".'}</td></tr>`}
        ${receitas.length ? `
        <tr class="vm-secao vm-secao-receita"><th scope="rowgroup">Receitas (líquido de retenções)</th>${d.meses.map(m =>
          `<td class="fin-num${colAtual(m)}">${vmValor(totRec[m])}</td>`).join('')}</tr>
        ${linhasReceita}` : ''}
        ${linhaTotal('Total a pagar', totPagar, 'vm-total')}
        ${comReceita ? linhaTotal('Total a receber', totRec, 'vm-total') : ''}
        ${comReceita ? linhaTotal('Saldo do mês', saldo, 'vm-saldo') : ''}
      </tbody>
    </table>`;
}

// Célula de despesa: com lançamento → editar (ou escolher, se houver mais de um); vazia → lançar naquele mês
async function vmCliqueCelula(iSecao, iLinha, mes) {
  const linha = _vm.secoes[iSecao].linhas[iLinha];
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
  const total = s.linhas.reduce((t, l) => t + l.celulas[mes].valor, 0);
  abrirPagarFatura(s.cartao.id, mes, total, abertas.reduce((t, c) => t + c.ids.length, 0));
}

function vmAbrirFaturamento(mes) {
  // A fatura do mês M (vencimento) normalmente é da competência anterior; abre o faturamento nessa competência
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  document.getElementById('fin-competencia').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  showPage('faturamento');
}

// Exporta exatamente o que está na tela, com os mesmos filtros e a mesma ordem (CSV para Excel pt-BR: ; e vírgula decimal, com BOM)
function exportarVisaoMensal() {
  if (!_vm) return;
  const f = vmFiltrosAtuais();
  const num = v => (v ? String(Math.round(v * 100) / 100).replace('.', ',') : '');
  const campo = v => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const linhas = [['Seção', 'Item', 'Categoria', 'Natureza', ..._vm.meses.map(m => mesAnoBr(m + '-01'))]];
  for (const s of vmSecoesVisiveis(f)) {
    for (const l of s.linhas) {
      linhas.push([s.titulo, l.descricao, l.categoria || '', l.natureza, ..._vm.meses.map(m => num(l.celulas[m].valor))]);
    }
  }
  for (const l of vmReceitasVisiveis(f)) {
    linhas.push(['Receitas', l.descricao, '', 'empresa', ..._vm.meses.map(m => num(l.celulas[m].valor))]);
  }
  const csv = '﻿' + linhas.map(l => l.map(campo).join(';')).join('\r\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `visao-mensal_${_vm.meses[0]}_a_${_vm.meses[_vm.meses.length - 1]}.csv`
  });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
