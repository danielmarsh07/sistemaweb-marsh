// Landing Marsh Consultoria — SAP + IA
// (a versão anterior está em frontend/site-classica)

const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===== MENU (celular) =====
const menu = document.getElementById('menu');
const menuBotao = document.getElementById('menuBotao');
menuBotao.addEventListener('click', () => {
  const aberto = menu.classList.toggle('aberto');
  menuBotao.setAttribute('aria-expanded', String(aberto));
});
menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
  menu.classList.remove('aberto');
  menuBotao.setAttribute('aria-expanded', 'false');
}));

// ===== CABEÇALHO: fundo ao rolar =====
const topo = document.getElementById('topo');
const marcarTopo = () => topo.classList.toggle('rolado', window.scrollY > 30);
window.addEventListener('scroll', marcarTopo, { passive: true });
marcarTopo();

// ===== REVELAR SEÇÕES AO ROLAR =====
const revelar = new IntersectionObserver(entradas => {
  entradas.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('visivel'); revelar.unobserve(e.target); }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
document.querySelectorAll('.revelar').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 80}ms`;
  revelar.observe(el);
});

// ===== ROBÔ: inclina levemente acompanhando o mouse =====
const robo = document.getElementById('robo');
if (robo && !menosMovimento && window.matchMedia('(pointer: fine)').matches) {
  let alvoX = 0, alvoY = 0, atualX = 0, atualY = 0, rodando = false;
  const animar = () => {
    atualX += (alvoX - atualX) * 0.08;
    atualY += (alvoY - atualY) * 0.08;
    // a inclinação fica no contêiner; o quadro mantém a "respiração" do CSS
    robo.style.transform = `rotateY(${atualX * 6}deg) rotateX(${-atualY * 4}deg)`;
    if (Math.abs(alvoX - atualX) > 0.001 || Math.abs(alvoY - atualY) > 0.001) requestAnimationFrame(animar);
    else rodando = false;
  };
  document.getElementById('ia').addEventListener('pointermove', ev => {
    const r = robo.getBoundingClientRect();
    alvoX = Math.max(-1, Math.min(1, (ev.clientX - (r.left + r.width / 2)) / (r.width / 2)));
    alvoY = Math.max(-1, Math.min(1, (ev.clientY - (r.top + r.height / 2)) / (r.height / 2)));
    if (!rodando) { rodando = true; requestAnimationFrame(animar); }
  });
  document.getElementById('ia').addEventListener('pointerleave', () => {
    alvoX = 0; alvoY = 0;
    if (!rodando) { rodando = true; requestAnimationFrame(animar); }
  });
}

// ===== PARTÍCULAS DE DADOS na seção de IA =====
(function particulas() {
  const canvas = document.getElementById('iaParticulas');
  if (!canvas || menosMovimento) return;
  const ctx = canvas.getContext('2d');
  const secao = document.getElementById('ia');
  let largura = 0, altura = 0, pontos = [], visivel = false, quadroId = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function dimensionar() {
    largura = secao.clientWidth; altura = secao.clientHeight;
    canvas.width = largura * dpr; canvas.height = altura * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(90, largura / 16));
    pontos = Array.from({ length: n }, () => novoPonto(true));
  }
  function novoPonto(inicio) {
    // fluxo da direita para a esquerda, como dados saindo dos cabos do robô
    return {
      x: inicio ? Math.random() * largura : largura + Math.random() * 60,
      y: Math.random() * altura,
      v: 0.4 + Math.random() * 1.3,
      r: 0.6 + Math.random() * 1.8,
      a: 0.25 + Math.random() * 0.6,
      rastro: 10 + Math.random() * 40
    };
  }
  function desenhar() {
    ctx.clearRect(0, 0, largura, altura);
    for (const p of pontos) {
      p.x -= p.v;
      if (p.x < -p.rastro) Object.assign(p, novoPonto(false));
      // some ao chegar no lado do texto (esquerda), para não atrapalhar a leitura
      const a = p.a * Math.min(1, Math.max(0, (p.x / largura - 0.3) / 0.35));
      if (a <= 0.01) continue;
      const g = ctx.createLinearGradient(p.x, p.y, p.x + p.rastro, p.y);
      g.addColorStop(0, `rgba(150, 225, 255, ${a})`);
      g.addColorStop(1, 'rgba(19, 168, 224, 0)');
      ctx.strokeStyle = g; ctx.lineWidth = p.r;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.rastro, p.y); ctx.stroke();
      ctx.fillStyle = `rgba(190, 240, 255, ${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    if (visivel) quadroId = requestAnimationFrame(desenhar);
  }
  // Só anima com a seção na tela
  new IntersectionObserver(([e]) => {
    visivel = e.isIntersecting;
    cancelAnimationFrame(quadroId);
    if (visivel) quadroId = requestAnimationFrame(desenhar);
  }).observe(secao);
  window.addEventListener('resize', dimensionar);
  dimensionar();
})();

// ===== BOTÕES QUE ESCOLHEM O ASSUNTO DO FORMULÁRIO =====
document.querySelectorAll('[data-assunto]').forEach(b => b.addEventListener('click', () => {
  const sel = document.getElementById('assunto');
  if (sel) sel.value = b.dataset.assunto;
}));

// ===== FORMULÁRIO: funil do sistema (lead) + Formspree (e-mail) =====
const form = document.getElementById('formContato');
const botao = document.getElementById('botaoEnviar');
const aviso = document.getElementById('formAviso');
document.getElementById('email').addEventListener('input', e => {
  document.getElementById('replyto').value = e.target.value;
});

function mostrarAviso(texto, erro = false) {
  aviso.hidden = false;
  aviso.textContent = texto;
  aviso.classList.toggle('erro', erro);
}

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  botao.disabled = true;
  botao.textContent = 'Enviando...';
  const dados = new FormData(form);
  const empresa = (dados.get('company') || '').trim();
  const mensagem = (empresa ? `Empresa: ${empresa}\n\n` : '') + dados.get('message');
  try {
    // Basta um dos dois dar certo
    const lead = fetch('/api/publico/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: dados.get('name'), email: dados.get('email'), telefone: dados.get('phone'),
        interesse: dados.get('subject'), mensagem, website: dados.get('website')
      })
    }).then(r => r.ok).catch(() => false);
    const formspree = fetch(form.action, { method: 'POST', body: dados, headers: { Accept: 'application/json' } })
      .then(r => r.ok).catch(() => false);
    const [okLead, okFormspree] = await Promise.all([lead, formspree]);
    if (!okLead && !okFormspree) throw new Error('falha');
    form.reset();
    mostrarAviso('Mensagem enviada! Em breve entraremos em contato.');
    botao.textContent = 'Enviado';
  } catch {
    botao.disabled = false;
    botao.textContent = 'Enviar mensagem';
    mostrarAviso('Não foi possível enviar agora. Fale com a gente pelo WhatsApp (21) 96780-6718 ou pelo e-mail.', true);
  }
});

document.getElementById('ano').textContent = new Date().getFullYear();
