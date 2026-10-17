// Página dos Conectores — menu, cabeçalho e revelar ao rolar (mesmo comportamento da landing)

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

document.getElementById('ano').textContent = new Date().getFullYear();
