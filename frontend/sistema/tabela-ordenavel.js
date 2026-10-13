// ===== LISTAGENS: ordenação por coluna, busca e filtros =====
// Trabalha sobre as linhas já renderizadas: cada página continua montando o <tbody> como antes, e o helper
// observa o tbody e reaplica a ordem e os filtros sempre que ele é redesenhado.
//
//   TabelaOrdenavel.ativar('tecnologias-tbody', { busca: 'Buscar tecnologia...', filtros: ['Categoria', 'Status'] });
//
// Opções:
//   busca      texto do placeholder → cria o campo de busca (procura em todas as colunas da linha)
//   filtros    títulos de coluna → cria um select por coluna com os valores que aparecem nela
//   limparCom  ids de selects "Ordenar" já existentes: ao mudar, a ordem por coluna é desfeita
//   servidor   (ordem, direcao, recarregar) → ordenação feita pela API (lista paginada); os <th> têm data-ordem
//
// Valor usado para ordenar: td[data-sort] se houver; senão o texto (datas dd/mm/aaaa, R$ e números são reconhecidos).
// No celular o cabeçalho some (a tabela vira card), então a barra ganha um select "Ordenar por".

const TabelaOrdenavel = (() => {
  const COLATOR = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const textoCelula = td => (td ? td.textContent.replace(/\s+/g, ' ').trim() : '');

  function valorOrdenacao(td) {
    if (!td) return null;
    if (td.dataset.sort !== undefined) {
      if (td.dataset.sort === '') return null;
      const n = Number(td.dataset.sort);
      return isNaN(n) ? td.dataset.sort : n;
    }
    const t = textoCelula(td);
    if (!t || t === '-' || t === '—') return null;
    let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return Number(m[3] + m[2] + m[1]);
    m = t.match(/^(-?)\s*R\$\s*(-?[\d.]+,\d{2})/);
    if (m) return Number(m[1] + m[2].replace(/\./g, '').replace(',', '.'));
    if (/^-?[\d.]+(,\d+)?\s*%?$/.test(t)) return Number(t.replace(/[%\s.]/g, '').replace(',', '.'));
    return t;
  }

  function comparar(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) return 1; // vazios sempre no fim
    if (b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return COLATOR.compare(String(a), String(b));
  }

  const ler = chave => { try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; } };
  const gravar = (chave, v) => { try { v ? localStorage.setItem(chave, JSON.stringify(v)) : localStorage.removeItem(chave); } catch { /* sem storage */ } };

  function ativar(tbodyId, opcoes = {}) {
    const tbody = document.getElementById(tbodyId);
    const tabela = tbody && tbody.closest('table');
    if (!tabela || tabela.dataset.ordenavel) return;
    tabela.dataset.ordenavel = '1';
    const chaveStorage = `tabela-ordem:${tbodyId}`;
    const ths = [...tabela.querySelectorAll('thead th')];
    const titulos = ths.map(th => th.textContent.replace(/\s+/g, ' ').trim());
    const indiceDe = titulo => titulos.findIndex(t => norm(t) === norm(titulo));

    // Colunas ordenáveis: todas menos Ações, checkbox e sem título
    const colunas = ths.map((th, i) => ({ th, i, titulo: titulos[i] }))
      .filter(c => c.titulo && norm(c.titulo) !== 'acoes' && !c.th.classList.contains('col-check') && !('semOrdem' in c.th.dataset)
        && (!opcoes.servidor || c.th.dataset.ordem));
    let estado = ler(chaveStorage); // { col, dir }
    if (estado && !colunas.some(c => c.i === estado.col)) estado = null;

    // ----- Cabeçalho clicável -----
    for (const c of colunas) {
      c.th.classList.add('th-ordenavel');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'th-ordenar';
      btn.title = `Ordenar por ${c.titulo}`;
      btn.innerHTML = `<span>${c.th.innerHTML}</span><span class="th-seta" aria-hidden="true"></span>`;
      c.th.textContent = '';
      c.th.appendChild(btn);
      btn.addEventListener('click', () => {
        // asc → desc → ordem original
        if (!estado || estado.col !== c.i) definir({ col: c.i, dir: 'asc' });
        else if (estado.dir === 'asc') definir({ col: c.i, dir: 'desc' });
        else definir(null);
      });
    }

    // ----- Barra de filtros (usa a da página, ou cria uma) -----
    let barra = null;
    const container = tabela.closest('.table-container') || tabela;
    const precisaBarra = opcoes.busca || (opcoes.filtros && opcoes.filtros.length) || colunas.length;
    if (precisaBarra) {
      let anterior = container.previousElementSibling;
      while (anterior && !anterior.classList.contains('filtros-bar') && !anterior.classList.contains('page-header')
        && anterior.tagName !== 'SECTION') anterior = anterior.previousElementSibling;
      if (anterior && anterior.classList.contains('filtros-bar')) barra = anterior;
      else {
        barra = document.createElement('div');
        barra.className = 'filtros-bar';
        container.parentNode.insertBefore(barra, container);
      }
    }

    let campoBusca = null;
    if (opcoes.busca) {
      campoBusca = document.createElement('input');
      campoBusca.type = 'text';
      campoBusca.className = 'filtro-select filtro-busca';
      campoBusca.placeholder = opcoes.busca;
      campoBusca.setAttribute('aria-label', opcoes.busca);
      let t = null;
      campoBusca.addEventListener('input', () => { clearTimeout(t); t = setTimeout(aplicar, 200); });
      barra.appendChild(campoBusca);
    }

    const selectsFiltro = (opcoes.filtros || []).map(titulo => {
      const i = indiceDe(titulo);
      if (i < 0) return null;
      const sel = document.createElement('select');
      sel.className = 'filtro-select';
      sel.setAttribute('aria-label', `Filtrar por ${titulo}`);
      sel.dataset.rotulo = `${titulos[i]}: todos`;
      sel.addEventListener('change', aplicar);
      barra.appendChild(sel);
      return { sel, i };
    }).filter(Boolean);

    // Ordenar no celular (o cabeçalho fica escondido nos cards). Páginas com select "Ordenar" próprio já têm um.
    let selOrdemMobile = null;
    if (colunas.length && !(opcoes.limparCom || []).length) {
      selOrdemMobile = document.createElement('select');
      selOrdemMobile.className = 'filtro-select ordenar-mobile';
      selOrdemMobile.setAttribute('aria-label', 'Ordenar por');
      selOrdemMobile.innerHTML = '<option value="">Ordem padrão</option>' + colunas.map(c =>
        `<option value="${c.i}:asc">${escapeHtml(c.titulo)} ↑</option><option value="${c.i}:desc">${escapeHtml(c.titulo)} ↓</option>`).join('');
      selOrdemMobile.addEventListener('change', () => {
        const [col, dir] = selOrdemMobile.value.split(':');
        definir(selOrdemMobile.value ? { col: Number(col), dir } : null);
      });
      barra.appendChild(selOrdemMobile);
    }

    let contador = null;
    if (campoBusca || selectsFiltro.length) {
      contador = barra.querySelector('.filtros-contador');
      if (!contador) {
        contador = document.createElement('span');
        contador.className = 'filtros-contador';
        barra.appendChild(contador);
      }
    }

    // Selects "Ordenar" que a página já tinha: escolher um deles desfaz a ordem por coluna
    for (const id of opcoes.limparCom || []) {
      const s = document.getElementById(id);
      if (s) s.addEventListener('change', () => definir(null, false));
    }

    function definir(novo, recarregarServidor = true) {
      estado = novo;
      gravar(chaveStorage, estado);
      if (opcoes.servidor) {
        const c = estado && colunas.find(x => x.i === estado.col);
        opcoes.servidor(c ? c.th.dataset.ordem : null, estado ? estado.dir : null, recarregarServidor);
        marcarCabecalho();
      } else aplicar();
    }

    function marcarCabecalho() {
      for (const c of colunas) {
        const ativo = estado && estado.col === c.i;
        if (ativo) c.th.setAttribute('aria-sort', estado.dir === 'asc' ? 'ascending' : 'descending');
        else c.th.removeAttribute('aria-sort');
      }
      if (selOrdemMobile) selOrdemMobile.value = estado ? `${estado.col}:${estado.dir}` : '';
    }

    // ----- Aplicar ordem e filtros sobre as linhas do tbody -----
    let contadorOrdem = 0;
    let aplicando = false;
    const ehLinhaDeDados = tr => !tr.classList.contains('linha-sem-resultado')
      && !(tr.children.length === 1 && tr.firstElementChild.colSpan > 1);

    function aplicar() {
      aplicando = true;
      tbody.querySelectorAll('tr.linha-sem-resultado').forEach(tr => tr.remove());
      const linhas = [...tbody.rows].filter(ehLinhaDeDados);
      const novas = linhas.filter(tr => tr.dataset.ordemOriginal === undefined);
      if (novas.length === linhas.length) contadorOrdem = 0; // tbody redesenhado inteiro
      novas.forEach(tr => { tr.dataset.ordemOriginal = contadorOrdem++; });

      // Opções dos selects: valores que aparecem na coluna (mantém a escolha atual)
      for (const f of selectsFiltro) {
        const atual = f.sel.value;
        const valores = [...new Set(linhas.map(tr => textoCelula(tr.cells[f.i])).filter(v => v && v !== '-'))]
          .sort(COLATOR.compare);
        f.sel.innerHTML = `<option value="">${escapeHtml(f.sel.dataset.rotulo)}</option>` +
          valores.map(v => `<option value="${escapeHtml(norm(v))}">${escapeHtml(v)}</option>`).join('');
        f.sel.value = valores.some(v => norm(v) === atual) ? atual : '';
      }

      const termos = campoBusca ? norm(campoBusca.value).split(' ').filter(Boolean) : [];
      let visiveis = 0;
      for (const tr of linhas) {
        const texto = termos.length ? norm(tr.textContent) : '';
        const ok = termos.every(t => texto.includes(t))
          && selectsFiltro.every(f => !f.sel.value || norm(textoCelula(tr.cells[f.i])) === f.sel.value);
        tr.classList.toggle('linha-oculta', !ok);
        if (ok) visiveis++;
      }

      if (!opcoes.servidor) {
        const ordenadas = [...linhas].sort((a, b) => {
          if (estado) {
            const r = comparar(valorOrdenacao(a.cells[estado.col]), valorOrdenacao(b.cells[estado.col]));
            if (r) return estado.dir === 'desc' ? -r : r;
          }
          return a.dataset.ordemOriginal - b.dataset.ordemOriginal;
        });
        // Só mexe no DOM se a ordem mudou
        if (ordenadas.some((tr, i) => tr !== linhas[i])) ordenadas.forEach(tr => tbody.appendChild(tr));
      }

      const filtrando = termos.length || selectsFiltro.some(f => f.sel.value);
      if (filtrando && linhas.length && !visiveis) {
        const tr = document.createElement('tr');
        tr.className = 'linha-sem-resultado';
        tr.innerHTML = `<td colspan="${ths.length}" class="text-center">Nada encontrado com esses filtros.</td>`;
        tbody.appendChild(tr);
      }
      if (contador) contador.textContent = filtrando ? `${visiveis} de ${linhas.length}` : `${linhas.length} item(ns)`;
      marcarCabecalho();
      observador.takeRecords(); // descarta as mudanças feitas aqui mesmo
      aplicando = false;
    }

    const observador = new MutationObserver(() => { if (!aplicando) aplicar(); });
    observador.observe(tbody, { childList: true });

    if (opcoes.servidor && estado) {
      const c = colunas.find(x => x.i === estado.col);
      opcoes.servidor(c.th.dataset.ordem, estado.dir, false);
    }
    aplicar();
  }

  return { ativar, valorOrdenacao };
})();

document.addEventListener('DOMContentLoaded', () => {
  // Cadastros
  TabelaOrdenavel.ativar('clientes-tbody', { limparCom: ['filtro-clientes-ordenar'] });
  TabelaOrdenavel.ativar('fornecedores-tbody', { limparCom: ['filtro-fornecedores-ordenar'] });
  TabelaOrdenavel.ativar('tecnologias-tbody', { busca: 'Buscar por nome, categoria ou fabricante...', filtros: ['Categoria', 'Status'] });
  TabelaOrdenavel.ativar('categorias-despesa-tbody', { busca: 'Buscar categoria...', filtros: ['Linha da DRE', 'Status'] });
  TabelaOrdenavel.ativar('contas-financeiras-tbody', { busca: 'Buscar conta ou cartão...', filtros: ['Tipo', 'Status'] });
  // Operação
  TabelaOrdenavel.ativar('chamados-tbody', {
    servidor: (ordem, direcao, recarregar) => {
      chamadosOrdem = ordem ? { ordem, direcao } : {};
      if (recarregar) { chamadosPaginacao.page = 1; loadChamados(); }
    }
  });
  TabelaOrdenavel.ativar('licencas-tbody', { busca: 'Buscar cliente...', filtros: ['Plano', 'Status'] });
  TabelaOrdenavel.ativar('cursos-tbody', { busca: 'Buscar curso...', filtros: ['Status'] });
  // Financeiro
  TabelaOrdenavel.ativar('contratos-tbody', { busca: 'Buscar cliente ou contrato...', filtros: ['Status'] });
  TabelaOrdenavel.ativar('faturas-tbody');
  TabelaOrdenavel.ativar('contas-pagar-tbody');
  // Sistema
  TabelaOrdenavel.ativar('usuarios-tbody', { limparCom: ['filtro-usuarios-ordenar'] });
});
