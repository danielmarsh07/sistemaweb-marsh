// Chamados abertos pelo Conector SAP (ferramenta abrir_chamado): selos da lista, bloco do detalhe,
// markdown seguro, baixar/copiar a especificação e aprovação do gestor do cliente.
// Usado pelo painel (dashboard.html) e pelo portal do cliente (portal.html). Estilos: chamado-conector.css.
//
// Segurança: o texto vem de fora (consultor do cliente + IA). Tudo é escapado ANTES de virar HTML;
// o conversor só gera tags fixas (títulos, listas, tabelas, código, negrito, citação) e nunca links/imagens.
(function () {
  const TIPOS = { melhoria: 'Melhoria', erro: 'Erro (correção)', nova_funcionalidade: 'Nova funcionalidade', duvida: 'Dúvida' };
  let especificacaoAtual = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function dataHora(v) {
    if (!v) return '-';
    const d = new Date(v);
    return isNaN(d) ? '-' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  // Inline: `código` e **negrito**. O texto é escapado por trecho; código não recebe negrito.
  function inline(texto) {
    const trechos = String(texto).split('`');
    const semPar = trechos.length % 2 === 0;   // crase sem fechamento: a última fica como texto
    return trechos.map((trecho, i) => {
      if (i % 2 === 1 && !(semPar && i === trechos.length - 1)) return `<code>${esc(trecho)}</code>`;
      return (i % 2 === 1 ? '`' : '') + esc(trecho)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    }).join('');
  }

  const celulas = linha => linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  /** Markdown -> HTML seguro (subconjunto: # títulos, listas, tabelas, ``` código, > citação, ---, **negrito**). */
  function markdownSeguro(md) {
    const linhas = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let lista = null;      // 'ul' | 'ol'
    let paragrafo = [];
    const fecharParagrafo = () => { if (paragrafo.length) { out.push(`<p>${paragrafo.join('<br>')}</p>`); paragrafo = []; } };
    const fecharLista = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
    const fecharTudo = () => { fecharParagrafo(); fecharLista(); };

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];

      if (/^\s*```/.test(linha)) {                       // bloco de código
        fecharTudo();
        const codigo = [];
        for (i++; i < linhas.length && !/^\s*```/.test(linhas[i]); i++) codigo.push(linhas[i]);
        out.push(`<pre><code>${esc(codigo.join('\n'))}</code></pre>`);
        continue;
      }
      if (!linha.trim()) { fecharTudo(); continue; }

      let m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(linha);
      if (m) {                                           // título: # -> h3 ... #### -> h6
        fecharTudo();
        const n = Math.min(6, m[1].length + 2);
        out.push(`<h${n}>${inline(m[2])}</h${n}>`);
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(linha)) { fecharTudo(); out.push('<hr>'); continue; }

      if (/^\s*\|/.test(linha) && i + 1 < linhas.length && /^\s*\|?\s*:?-{2,}/.test(linhas[i + 1])) {   // tabela
        fecharTudo();
        const cab = celulas(linha);
        const corpo = [];
        for (i += 2; i < linhas.length && /^\s*\|/.test(linhas[i]); i++) corpo.push(celulas(linhas[i]));
        i--;
        out.push('<div class="cc-md-tabela"><table><thead><tr>' + cab.map(c => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' + corpo.map(l => '<tr>' + l.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }

      m = /^\s*>\s?(.*)$/.exec(linha);
      if (m) { fecharTudo(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }

      m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(linha);
      if (m) {                                           // listas (aninhamento vira recuo simples)
        fecharParagrafo();
        const tipo = /\d/.test(m[2]) ? 'ol' : 'ul';
        if (lista !== tipo) { fecharLista(); out.push(`<${tipo}>`); lista = tipo; }
        const recuo = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
        out.push(`<li${recuo ? ` class="cc-recuo-${recuo}"` : ''}>${inline(m[3])}</li>`);
        continue;
      }

      fecharLista();
      paragrafo.push(inline(linha.trim()));
    }
    fecharTudo();
    return out.join('\n');
  }

  /** Selos da lista: "Conector SAP" + situação da aprovação. portal = texto voltado ao cliente. */
  function selos(ch, portal) {
    if (!ch || ch.origem !== 'conector') return '';
    const aprov = {
      pendente: ['cc-selo-pendente', portal ? 'Aguardando sua aprovação' : 'Aguardando aprovação do cliente'],
      aprovado: ['cc-selo-aprovado', 'Aprovado'],
      recusado: ['cc-selo-recusado', 'Recusado']
    }[ch.aprovacao_cliente];
    return `<span class="cc-selo cc-selo-conector" title="Aberto pelo Conector SAP">Conector SAP</span>` +
      (aprov ? `<span class="cc-selo ${aprov[0]}">${aprov[1]}</span>` : '');
  }

  /**
   * Bloco do detalhe do chamado. opcoes:
   *   painel     -> mostra máquina e hash do usuário (equipe Marsh)
   *   podeAprovar / podeRecusar -> botões de decisão (só quando pendente)
   *   rotuloAprovar -> texto do botão de aprovar
   */
  function blocoHtml(ch, opcoes = {}) {
    if (!ch || ch.origem !== 'conector') { especificacaoAtual = ''; return ''; }
    especificacaoAtual = ch.especificacao || '';
    const objetos = Array.isArray(ch.objetos_sap) ? ch.objetos_sap : [];
    const pendente = ch.aprovacao_cliente === 'pendente';
    const decidido = ch.aprovacao_cliente === 'aprovado' || ch.aprovacao_cliente === 'recusado';

    const campos = [
      ['Sistema SAP', esc(ch.sid || '-')],
      ['Módulo', esc(ch.modulo || '-')],
      ['Tipo', esc(TIPOS[ch.tipo_demanda] || ch.tipo_demanda || '-')],
      ['Solicitante', esc(ch.solicitante_nome || '-') +
        (ch.solicitante_email ? `<small>${esc(ch.solicitante_email)}</small>` : '')]
    ];
    if (opcoes.painel) {
      campos.push(['Máquina', esc(ch.maquina_nome || '-')]);
      campos.push(['Usuário SAP (hash)', ch.usuario_hash
        ? `<code title="${esc(ch.usuario_hash)}">${esc(ch.usuario_hash.slice(0, 12))}…</code>` : '-']);
    }
    if (decidido) {
      campos.push([ch.aprovacao_cliente === 'aprovado' ? 'Aprovado por' : 'Recusado por',
        esc(ch.aprovado_por_nome || '-') + `<small>${esc(dataHora(ch.data_aprovacao))}</small>`]);
    }

    let aviso = '';
    if (pendente) {
      const botoes = [
        opcoes.podeAprovar ? `<button type="button" class="cc-btn cc-btn-primario" onclick="ChamadoConector.aprovar(${ch.id})">${esc(opcoes.rotuloAprovar || 'Aprovar')}</button>` : '',
        opcoes.podeRecusar ? `<button type="button" class="cc-btn cc-btn-perigo" onclick="ChamadoConector.recusar(${ch.id})">Recusar</button>` : ''
      ].join('');
      aviso = `<div class="cc-aviso">
          <p>${opcoes.painel
            ? 'Aguardando a aprovação do gestor do cliente no portal. A fábrica ABAP só começa depois da aprovação.'
            : 'Este chamado foi aberto pelo Conector SAP e aguarda a <strong>sua aprovação</strong> para a Marsh começar o desenvolvimento.'}</p>
          ${botoes ? `<div class="cc-acoes">${botoes}</div>` : ''}
        </div>`;
    }

    return `
      <div class="cc-bloco">
        <div class="cc-topo"><span class="cc-titulo">Conector SAP</span>${selos(ch, !opcoes.painel)}</div>
        <div class="cc-grid">${campos.map(([r, v]) => `<div><span class="cc-rotulo">${r}</span>${v}</div>`).join('')}</div>
        ${aviso}
        <div class="cc-secao">
          <h5>Objetos SAP</h5>
          ${objetos.length
            ? `<div class="cc-objetos">${objetos.map(o => `<code>${esc(o.tipo)} ${esc(o.nome)}</code>`).join('')}</div>`
            : '<p class="cc-vazio">Nenhum objeto informado.</p>'}
        </div>
        <div class="cc-secao">
          <h5>Pedido original</h5>
          <div class="cc-pedido">${esc(ch.pedido_original || '-')}</div>
        </div>
        <div class="cc-secao">
          <div class="cc-secao-topo">
            <h5>Especificação</h5>
            <div class="cc-acoes">
              <button type="button" class="cc-btn" onclick="ChamadoConector.baixar(${ch.id})">Baixar especificação (.md)</button>
              ${ch.especificacao ? '<button type="button" class="cc-btn" onclick="ChamadoConector.copiar(this)">Copiar especificação</button>' : ''}
            </div>
          </div>
          ${ch.especificacao
            ? `<div class="cc-md">${markdownSeguro(ch.especificacao)}</div>`
            : '<p class="cc-vazio">Sem especificação (dúvida).</p>'}
        </div>
      </div>`;
  }

  const cabecalhoAuth = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

  async function baixar(id) {
    try {
      const res = await fetch(`/api/chamados/${id}/especificacao.md`, { headers: cabecalhoAuth() });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.erro || 'Erro ao baixar a especificação.');
        return;
      }
      const disp = res.headers.get('Content-Disposition') || '';
      const nome = (/filename="([^"]+)"/.exec(disp) || [])[1] || `chamado-${id}.md`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      alert('Erro ao baixar a especificação: ' + err.message);
    }
  }

  async function copiar(btn) {
    if (!especificacaoAtual) return;
    try {
      await navigator.clipboard.writeText(especificacaoAtual);
    } catch {
      // Sem permissão de área de transferência (http, navegador antigo): cópia pelo textarea
      const ta = document.createElement('textarea');
      ta.value = especificacaoAtual;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const txt = btn.textContent;
      btn.textContent = 'Copiada!';
      setTimeout(() => { btn.textContent = txt; }, 1500);
    }
  }

  async function decidir(id, decisao, comentario) {
    const res = await fetch(`/api/chamados/${id}/aprovacao`, {
      method: 'POST',
      headers: { ...cabecalhoAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisao, comentario })
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) { alert(r.erro || 'Erro ao registrar a decisão.'); return; }
    alert(r.mensagem);
    if (typeof ChamadoConector.aoDecidir === 'function') await ChamadoConector.aoDecidir(id);
  }

  function aprovar(id) {
    if (!confirm('Aprovar este chamado? Ele entra na fila de desenvolvimento da Marsh.')) return;
    const comentario = prompt('Comentário (opcional):', '');
    if (comentario === null) return;
    decidir(id, 'aprovado', comentario.trim());
  }

  function recusar(id) {
    const comentario = prompt('Motivo da recusa (obrigatório). O chamado será fechado:');
    if (comentario === null) return;
    if (!comentario.trim()) { alert('Informe o motivo da recusa.'); return; }
    decidir(id, 'recusado', comentario.trim());
  }

  window.ChamadoConector = { markdownSeguro, selos, blocoHtml, baixar, copiar, aprovar, recusar, aoDecidir: null };
})();
