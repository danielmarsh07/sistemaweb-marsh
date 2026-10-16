// Página da oferta de um curso (loja, fluxo novo fase 4): /curso.html?o=<slug>[&pedido=<token>][&utm_source=...]
(function () {
  const params = new URLSearchParams(location.search);
  const slug = params.get('o');
  const tokenPedido = params.get('pedido');
  const origem = params.get('utm_source') || params.get('origem') || (document.referrer ? new URL(document.referrer).hostname : '');
  const $ = id => document.getElementById(id);
  const moeda = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const br = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let oferta = null, desconto = 0;
  const ehLicencas = () => oferta && oferta.tipo === 'conector';
  // Licenças do Conector: quantidades por perfil e o total estimado (o valor final é calculado no servidor)
  function vagas() {
    const v = {};
    document.querySelectorAll('#licencas-perfis input').forEach(i => { v[i.name] = Math.max(0, Math.min(200, parseInt(i.value, 10) || 0)); });
    return v;
  }
  function subtotal() {
    if (!ehLicencas()) return oferta.preco;
    const v = vagas();
    return oferta.perfis.reduce((s, p) => s + (v[p.id] || 0) * p.preco_anual, 0);
  }

  function mensagem(texto, tipo = 'erro') { $('msg').innerHTML = texto ? `<p class="msg ${tipo}">${esc(texto)}</p>` : ''; }
  function total() { $('total').textContent = moeda(Math.max(0, subtotal() - desconto)) + (ehLicencas() ? ' por ano' : ''); }

  function semOferta(texto) {
    $('titulo').textContent = texto;
    $('conteudo').innerHTML = '<div class="cartao status" style="grid-column:1/-1"><p>Confira o link ou fale com a Marsh.</p></div>';
  }

  async function carregar() {
    if (!slug) return semOferta('Oferta não encontrada');
    const r = await fetch(`/api/publico/ofertas/${encodeURIComponent(slug)}`);
    if (!r.ok) return semOferta('Oferta não encontrada');
    oferta = await r.json();
    document.title = `${oferta.titulo} — Marsh Consultoria`;
    $('faixa-teste').hidden = !oferta.teste;
    $('titulo').textContent = oferta.titulo;
    $('curso-nome').textContent = oferta.curso !== oferta.titulo ? oferta.curso : '';
    $('meta').innerHTML = (ehLicencas() ? ['Licenças por pessoa', 'Vigência de 12 meses', 'Cursos inclusos por perfil']
      : [oferta.aulas && `${oferta.aulas} aulas`, oferta.carga_horaria, oferta.duracao_meses ? `Acesso por ${oferta.duracao_meses} meses` : 'Acesso sem prazo'])
      .filter(Boolean).map(esc).map(t => `<span>${t}</span>`).join('');
    if (ehLicencas()) $('selo').textContent = 'Conector SAP';
    $('descricao').innerHTML = `<h2>${ehLicencas() ? 'Sobre as licenças' : 'Sobre o curso'}</h2>${esc(oferta.descricao || 'Detalhes em breve.')}`;
    if (ehLicencas()) {
      const menor = Math.min(...oferta.perfis.map(p => p.preco_anual));
      $('bloco-preco').innerHTML = `<div class="preco-cheio" style="text-decoration:none">a partir de</div>
        <div class="preco">${moeda(menor)} <small>por licença/ano</small></div>`;
      $('bloco-licencas').hidden = false;
      $('ajuda-pagamento').textContent = 'Você paga com PIX, boleto ou cartão na página segura do Asaas. Confirmado o pagamento, as licenças são liberadas '
        + 'por 12 meses e você recebe por e-mail o acesso ao portal para convidar a sua equipe.';
      $('licencas-perfis').innerHTML = oferta.perfis.map(p => `
        <div class="licenca-perfil"><div><strong>${esc(p.nome)}</strong><span>${moeda(p.preco_anual)} por licença/ano</span></div>
          <input type="number" name="${p.id}" min="0" max="200" value="0" aria-label="Quantidade de licenças ${esc(p.nome)}"></div>`).join('');
      $('licencas-perfis').querySelector('input').value = 1;
      $('eu-perfil').innerHTML += oferta.perfis.map(p => `<option value="${p.id}">Sim, com uma licença ${esc(p.nome)}</option>`).join('');
      $('licencas-perfis').addEventListener('input', () => { desconto = 0; mensagem(''); total(); });
    } else $('bloco-preco').innerHTML = `
      ${oferta.promocional ? `<div class="preco-cheio">${moeda(oferta.preco_cheio)}</div>` : ''}
      <div class="preco">${oferta.preco > 0 ? moeda(oferta.preco) : 'Gratuito'} ${oferta.preco > 0 ? '<small>à vista</small>' : ''}</div>
      ${oferta.promocional && oferta.promo_fim ? `<span class="promo">Preço promocional até ${br(oferta.promo_fim)}</span>` : ''}`;
    if (!oferta.disponivel) {
      $('form-pedido').innerHTML = '<p class="msg erro">Esta oferta não está aberta para compra agora.</p>';
      return;
    }
    if (!ehLicencas() && oferta.preco === 0) document.querySelector('.cupom').hidden = true;
    $('btn-comprar').textContent = ehLicencas() || oferta.preco > 0 ? 'Ir para o pagamento' : 'Quero o curso';
    total();
  }

  async function aplicarCupom() {
    const cupom = $('form-pedido').cupom.value.trim();
    if (!cupom) { desconto = 0; total(); return mensagem(''); }
    const r = await fetch(`/api/publico/ofertas/${encodeURIComponent(slug)}/cupom`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cupom, vagas: ehLicencas() ? vagas() : undefined }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { desconto = 0; total(); return mensagem(d.erro || 'Cupom inválido.'); }
    desconto = d.desconto;
    total();
    if (ehLicencas()) { $('total').textContent = moeda(d.total) + ' por ano'; }
    mensagem(`Cupom aplicado: ${moeda(d.desconto)} de desconto.`, 'ok');
  }

  async function comprar(e) {
    e.preventDefault();
    const f = e.target;
    if (!f.nome.value.trim() || !f.email.value.trim() || !f.documento.value.trim()) return mensagem('Preencha nome, e-mail e CPF ou CNPJ.');
    const btn = $('btn-comprar');
    btn.disabled = true;
    mensagem('');
    try {
      const r = await fetch(`/api/publico/ofertas/${encodeURIComponent(slug)}/pedido`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: f.nome.value, email: f.email.value, documento: f.documento.value, telefone: f.telefone.value,
          cupom: f.cupom.value, website: f.website.value, origem,
          vagas: ehLicencas() ? vagas() : undefined, eu_perfil: ehLicencas() ? f.eu_perfil.value : undefined }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { mensagem(d.erro || 'Não foi possível concluir agora.'); return; }
      location.href = d.link; // página de pagamento do Asaas (ou a confirmação, se for gratuito)
    } finally { btn.disabled = false; }
  }

  // Volta do pagamento: mostra a situação do pedido (o webhook pode levar alguns segundos)
  async function mostrarPedido(tentativa = 0) {
    const r = await fetch(`/api/publico/pedidos/${encodeURIComponent(tokenPedido)}`);
    if (!r.ok) return;
    const p = await r.json();
    const box = $('compra');
    if (p.status === 'pago') {
      box.innerHTML = p.tipo === 'conector'
        ? `<div class="status"><h2>Pagamento confirmado!</h2><p>Suas licenças valem até ${br(p.acesso_fim)}. Enviamos o acesso ao portal para o seu e-mail:
            lá você convida cada pessoa da equipe.</p>
           <p style="margin-top:14px"><a href="/login.html"><button type="button">Entrar no portal</button></a></p></div>`
        : `<div class="status"><h2>Pagamento confirmado!</h2><p>O curso <strong>${esc(p.titulo)}</strong> está liberado
        ${p.acesso_fim ? `até ${br(p.acesso_fim)}` : 'sem prazo'}. Enviamos o acesso ao portal para o seu e-mail.</p>
        <p style="margin-top:14px"><a href="/login.html"><button type="button">Entrar no portal</button></a></p></div>`;
    } else if (p.status === 'pendente') {
      box.innerHTML = `<div class="status"><h2>Aguardando o pagamento</h2><p>Assim que o Asaas confirmar, o curso é liberado e você recebe o e-mail.
        PIX e cartão costumam ser na hora; boleto, até 2 dias úteis.</p>
        ${p.link_pagamento ? `<p style="margin-top:14px"><a href="${esc(p.link_pagamento)}"><button type="button">Abrir a página de pagamento</button></a></p>` : ''}</div>`;
      if (tentativa < 20) setTimeout(() => mostrarPedido(tentativa + 1), 6000);
    } else {
      box.innerHTML = `<div class="status"><h2>Pedido ${esc(p.status)}</h2><p>Se precisar, faça um novo pedido ou fale com a Marsh.</p></div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await carregar();
    if (!oferta) return;
    if (tokenPedido) return mostrarPedido();
    $('form-pedido').addEventListener('submit', comprar);
    $('btn-cupom').addEventListener('click', aplicarCupom);
  });
})();
