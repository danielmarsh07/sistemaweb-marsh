// ===== Loja de cursos (painel): ofertas, pedidos e cupons =====
// Regras no backend (services/loja.js, routes/loja.js). Usa helpers do script.js e do financeiro.js (pill, botao).
let _ofertas = [];
let _ofertaEmEdicao = null;

const STATUS_PEDIDO = {
  pendente: ['Aguardando pagamento', '#1d6fd8'], pago: ['Pago', '#2e7d4f'], vencido: ['Vencido', '#b7791f'],
  cancelado: ['Cancelado', '#94a3b8'], expirado: ['Expirado', '#94a3b8'], recusado: ['Recusado', '#b42318'],
  estornado: ['Estornado', '#b42318'], contestado: ['Contestado', '#b42318']
};
const linkOferta = slug => `${location.origin}/curso.html?o=${encodeURIComponent(slug)}`;

async function loadLoja() {
  const st = await apiFetch(`${API_URL}/loja/status`);
  if (st && st.ok) {
    const s = await st.json();
    document.getElementById('loja-status').innerHTML = [
      s.teste_configurado ? 'Homologação (teste) pronta.' : '<strong>Homologação sem chave do sandbox:</strong> defina ASAAS_SANDBOX_API_KEY no servidor.',
      s.webhook_teste ? '' : 'Sem webhook de teste: use "Simular pagamento" para liberar o curso.',
      s.producao_configurado ? `Produção: Asaas ${s.ambiente_principal === 'producao' ? 'conectado' : 'em sandbox'}.` : 'Produção: Asaas não configurado.'
    ].filter(Boolean).join(' ');
  }
  await Promise.all([loadOfertasLoja(), loadPedidosLoja(), loadCuponsLoja()]);
}

async function loadOfertasLoja() {
  const tbody = document.getElementById('loja-ofertas');
  const res = await apiFetch(`${API_URL}/loja/ofertas`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6" class="text-center">${escapeHtml(d.erro)}</td></tr>`; return; }
  _ofertas = d;
  tbody.innerHTML = d.length ? d.map(o => `
    <tr>
      <td data-label="Oferta"><strong>${escapeHtml(o.titulo)}</strong><span class="loja-sub">${escapeHtml(o.curso_titulo)}${o.curso_status !== 'publicado' ? ' (curso em rascunho)' : ''}</span>
        <a href="${linkOferta(o.slug)}" target="_blank" rel="noopener" class="loja-sub">${escapeHtml(linkOferta(o.slug))}</a></td>
      <td data-label="Preço" class="fin-num">${o.preco_atual > 0 ? formatMoeda(o.preco_atual) : 'Gratuito'}${o.preco_atual < o.preco ? `<span class="loja-sub">de ${formatMoeda(o.preco)}</span>` : ''}</td>
      <td data-label="Acesso">${o.duracao_meses ? `${o.duracao_meses} meses` : 'Sem prazo'}</td>
      <td data-label="Modo">${o.modo === 'teste' ? pill('Teste', '#b7791f') : pill('Produção', '#2e7d4f')} ${o.em_venda ? '' : pill('Fora de venda', '#94a3b8')}</td>
      <td data-label="Vendas">${o.vendidos} · ${formatMoeda(o.receita)}</td>
      <td data-label="Ações" class="td-acoes">
        ${botao('edit', 'Editar', `abrirOferta(${o.id})`, 'btn-edit')}
        <button class="btn btn-secondary btn-sm" onclick="copiarLinkOferta('${escapeHtml(o.slug)}')">Copiar link</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="text-center">Nenhuma oferta. Use "+ Nova oferta".</td></tr>';
}

function copiarLinkOferta(slug) {
  const link = linkOferta(slug);
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => alert('Link copiado.')).catch(() => prompt('Copie o link:', link));
  else prompt('Copie o link:', link);
}

async function abrirOferta(id) {
  _ofertaEmEdicao = id || null;
  const o = id ? _ofertas.find(x => x.id === id) : null;
  const f = document.getElementById('form-oferta');
  f.reset();
  const rc = await apiFetch(`${API_URL}/treinamentos/cursos`);
  const cursos = rc && rc.ok ? await rc.json() : [];
  f.curso_id.innerHTML = '<option value="">Selecione…</option>' + cursos.map(c => `<option value="${c.id}">${escapeHtml(c.titulo)}${c.status !== 'publicado' ? ' (rascunho)' : ''}</option>`).join('');
  if (o) {
    ['curso_id', 'titulo', 'slug', 'descricao', 'preco', 'preco_promocional', 'promo_inicio', 'promo_fim', 'venda_inicio', 'venda_fim', 'modo']
      .forEach(k => { f[k].value = o[k] ?? ''; });
    f.duracao_meses.value = o.duracao_meses ?? '';
    f.ativa.checked = o.ativa;
  } else {
    f.duracao_meses.value = 12;
    f.modo.value = 'teste';
    f.ativa.checked = true;
    f.curso_id.onchange = () => {
      const c = cursos.find(x => String(x.id) === f.curso_id.value);
      if (c && !f.titulo.value) f.titulo.value = c.titulo;
      if (c && !f.slug.value) f.slug.value = c.titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    };
  }
  document.getElementById('modal-oferta-titulo').textContent = o ? `Oferta — ${o.titulo}` : 'Nova oferta';
  showModal('#modal-oferta');
}

async function salvarOferta() {
  const f = document.getElementById('form-oferta');
  const dados = Object.fromEntries(['curso_id', 'titulo', 'slug', 'descricao', 'preco', 'preco_promocional', 'duracao_meses',
    'promo_inicio', 'promo_fim', 'venda_inicio', 'venda_fim', 'modo'].map(k => [k, f[k].value]));
  dados.ativa = f.ativa.checked;
  const antes = _ofertaEmEdicao && _ofertas.find(x => x.id === _ofertaEmEdicao);
  if (dados.modo === 'producao' && (!antes || antes.modo !== 'producao')
    && !confirm('Colocar esta oferta em PRODUÇÃO? Os próximos pedidos serão cobrados de verdade no Asaas.')) return;
  const res = await apiFetch(_ofertaEmEdicao ? `${API_URL}/loja/ofertas/${_ofertaEmEdicao}` : `${API_URL}/loja/ofertas`,
    { method: _ofertaEmEdicao ? 'PUT' : 'POST', body: JSON.stringify(dados) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-oferta'));
  if (r.mensagem && r.mensagem.includes('PRODUÇÃO')) alert(r.mensagem);
  loadOfertasLoja();
}

async function loadPedidosLoja() {
  const tbody = document.getElementById('loja-pedidos');
  const q = new URLSearchParams();
  const st = document.getElementById('loja-filtro-status').value, modo = document.getElementById('loja-filtro-modo').value;
  if (st) q.set('status', st);
  if (modo) q.set('modo', modo);
  const res = await apiFetch(`${API_URL}/loja/pedidos?${q}`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6" class="text-center">${escapeHtml(d.erro)}</td></tr>`; return; }
  tbody.innerHTML = d.length ? d.map(p => {
    const [txt, cor] = STATUS_PEDIDO[p.status] || [p.status, '#64748b'];
    const acoes = [
      p.modo === 'teste' && ['pendente', 'vencido'].includes(p.status) && `<button class="btn btn-secondary btn-sm" onclick="acaoPedidoLoja(${p.id}, 'confirmar-teste')">Simular pagamento</button>`,
      ['pendente', 'vencido'].includes(p.status) && `<button class="btn btn-secondary btn-sm" onclick="acaoPedidoLoja(${p.id}, 'cancelar')">Cancelar</button>`,
      ['pago', 'contestado'].includes(p.status) && `<button class="btn btn-secondary btn-sm" onclick="acaoPedidoLoja(${p.id}, 'estornar')">Registrar estorno</button>`,
      p.cliente_id && `<button class="btn btn-secondary btn-sm" onclick="abrirFichaCliente(${p.cliente_id})">Ficha</button>`
    ].filter(Boolean).join(' ');
    return `<tr>
      <td data-label="Pedido"><strong>#${p.id}</strong><span class="loja-sub">${new Date(p.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${p.origem ? ' · ' + escapeHtml(p.origem) : ''}</span></td>
      <td data-label="Comprador"><strong>${escapeHtml(p.nome)}</strong><span class="loja-sub">${escapeHtml(p.email)} · ${escapeHtml(p.cpf_cnpj || '')}</span></td>
      <td data-label="Oferta">${escapeHtml(p.oferta)}${p.cupom ? `<span class="loja-sub">cupom ${escapeHtml(p.cupom)}</span>` : ''}</td>
      <td data-label="Valor" class="fin-num">${formatMoeda(p.valor)}${p.desconto > 0 ? `<span class="loja-sub">−${formatMoeda(p.desconto)}</span>` : ''}</td>
      <td data-label="Status">${pill(txt, cor)} ${p.modo === 'teste' ? pill('Teste', '#b7791f') : ''}
        ${p.status === 'pago' && p.acesso_fim ? `<span class="loja-sub">acesso até ${diaBr(p.acesso_fim)}</span>` : ''}
        ${p.erro && p.status === 'pendente' ? `<span class="loja-sub" style="color:#b42318">${escapeHtml(p.erro)}</span>` : ''}</td>
      <td data-label="Ações" class="td-acoes">${acoes}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="text-center">Nenhum pedido.</td></tr>';
}

async function acaoPedidoLoja(id, acao) {
  const textos = {
    'confirmar-teste': 'Simular o pagamento deste pedido de TESTE? O curso é liberado e o comprador recebe o e-mail.',
    cancelar: 'Cancelar este pedido? A cobrança no Asaas é cancelada.',
    estornar: 'Registrar o estorno deste pedido? A pessoa perde o acesso ao curso comprado (o progresso fica guardado). Faça o estorno do dinheiro no painel do Asaas.'
  };
  if (!confirm(textos[acao])) return;
  const res = await apiFetch(`${API_URL}/loja/pedidos/${id}/${acao}`, { method: 'POST' });
  if (!res) return;
  const r = await res.json();
  alert(r.mensagem || r.erro);
  loadPedidosLoja();
  loadOfertasLoja();
}

async function loadCuponsLoja() {
  const tbody = document.getElementById('loja-cupons');
  const res = await apiFetch(`${API_URL}/loja/cupons`);
  if (!res) return;
  const d = await res.json();
  if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6" class="text-center">${escapeHtml(d.erro)}</td></tr>`; return; }
  tbody.innerHTML = d.length ? d.map(k => `
    <tr class="${k.ativo ? '' : 'fin-linha-cancelada'}">
      <td data-label="Código"><strong>${escapeHtml(k.codigo)}</strong></td>
      <td data-label="Desconto">${k.tipo === 'percentual' ? `${k.valor}%` : formatMoeda(k.valor)}</td>
      <td data-label="Vale para">${k.oferta_titulo ? escapeHtml(k.oferta_titulo) : 'Todas as ofertas'}</td>
      <td data-label="Usos">${k.usos}${k.usos_max ? ` de ${k.usos_max}` : ''}</td>
      <td data-label="Validade">${k.inicio || k.fim ? `${k.inicio ? diaBr(k.inicio) : '…'} a ${k.fim ? diaBr(k.fim) : '…'}` : 'Sem prazo'}</td>
      <td data-label="Ações" class="td-acoes"><button class="btn btn-secondary btn-sm" onclick="alternarCupom(${k.id}, ${!k.ativo})">${k.ativo ? 'Desativar' : 'Ativar'}</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="text-center">Nenhum cupom.</td></tr>';
}

function abrirCupom() {
  const f = document.getElementById('form-cupom');
  f.reset();
  f.oferta_id.innerHTML = '<option value="">Todas</option>' + _ofertas.map(o => `<option value="${o.id}">${escapeHtml(o.titulo)}</option>`).join('');
  showModal('#modal-cupom');
}

async function salvarCupom() {
  const f = document.getElementById('form-cupom');
  const dados = Object.fromEntries(['codigo', 'tipo', 'valor', 'oferta_id', 'usos_max', 'inicio', 'fim'].map(k => [k, f[k].value]));
  const res = await apiFetch(`${API_URL}/loja/cupons`, { method: 'POST', body: JSON.stringify(dados) });
  if (!res) return;
  const r = await res.json();
  if (!res.ok) { alert(r.erro); return; }
  closeModal(document.getElementById('modal-cupom'));
  loadCuponsLoja();
}

async function alternarCupom(id, ativo) {
  const res = await apiFetch(`${API_URL}/loja/cupons/${id}`, { method: 'PUT', body: JSON.stringify({ ativo }) });
  if (res) loadCuponsLoja();
}

document.addEventListener('DOMContentLoaded', () => {
  const sub = (id, fn) => document.getElementById(id).addEventListener('submit', e => { e.preventDefault(); fn(); });
  sub('form-oferta', salvarOferta);
  sub('form-cupom', salvarCupom);
  // A loja é dos administradores
  if (!usuario || !['admin_empresa', 'admin_sistema'].includes(usuario.tipo)) {
    const l = document.querySelector('.nav-link[data-page="loja"]');
    if (l) l.hidden = true;
  }
});
