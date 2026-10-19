// ============================================================================
// SIMULADOR DE ACESSO — o administrador entra como um usuário para ver o que ele vê.
// Carregado no sistema (dashboard), no portal e no login. O acesso do administrador fica guardado em
// localStorage 'simulacao_admin' enquanto a simulação dura; "Voltar ao meu acesso" (ou sair) o restaura.
// A simulação é só de visualização: o servidor recusa qualquer alteração feita com o token simulado.
// ============================================================================
(function () {
  const CHAVE = 'simulacao_admin';

  function lerAdmin() {
    try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch (e) { return null; }
  }
  function lerUsuario() {
    try { return JSON.parse(localStorage.getItem('usuario') || 'null'); } catch (e) { return null; }
  }
  const destino = u => (u && u.tipo === 'cliente' ? '/portal.html' : '/dashboard.html');

  // Chamado pela tela de Usuários com o token e o usuário devolvidos por POST /api/usuarios/:id/simular
  function iniciar(token, usuarioSimulado) {
    if (!lerAdmin()) {
      localStorage.setItem(CHAVE, JSON.stringify({ token: localStorage.getItem('token'), usuario: lerUsuario() }));
    }
    localStorage.setItem('token', token);
    localStorage.setItem('usuario', JSON.stringify(usuarioSimulado));
    try { if (usuarioSimulado.tema) localStorage.setItem('marsh.theme', usuarioSimulado.tema); } catch (e) { /* ignora */ }
    window.location.href = destino(usuarioSimulado);
  }

  function sair() {
    const adm = lerAdmin();
    localStorage.removeItem(CHAVE);
    if (adm && adm.token) {
      localStorage.setItem('token', adm.token);
      localStorage.setItem('usuario', JSON.stringify(adm.usuario));
      try { if (adm.usuario && adm.usuario.tema) localStorage.setItem('marsh.theme', adm.usuario.tema); } catch (e) { /* ignora */ }
      window.location.href = destino(adm.usuario);
    } else {
      localStorage.removeItem('token');
      localStorage.removeItem('usuario');
      window.location.href = '/login.html';
    }
  }

  const ativa = () => !!(lerAdmin() && (lerUsuario() || {}).simulado_por);

  window.MarshSimulacao = { iniciar, sair, ativa };

  // Login: a simulação venceu (o 401 apagou o token) → volta direto para o acesso do administrador
  if (/\/login\.html$/.test(location.pathname)) {
    if (lerAdmin() && !localStorage.getItem('token')) sair();
    return;
  }
  if (!ativa()) {
    if (lerAdmin() && !(lerUsuario() || {}).simulado_por) localStorage.removeItem(CHAVE); // sobra de simulação antiga
    return;
  }

  // Durante a simulação, "Sair" do menu volta ao acesso do administrador em vez de deslogar
  window.logout = sair;
  window.sair = sair;

  const perfis = { admin_sistema: 'Admin Sistema', admin_empresa: 'Administrador', tecnico: 'Técnico', cliente: 'Cliente' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function montarFaixa() {
    const u = lerUsuario() || {};
    const css = document.createElement('style');
    css.textContent = `
      html.simulando-acesso body::after { content: ''; position: fixed; inset: 0; border: 3px solid #f59e0b;
        pointer-events: none; z-index: 2147483000; }
      .simulacao-faixa { position: fixed; left: 50%; transform: translateX(-50%);
        bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 2147483001;
        display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px);
        background: #1f2937; color: #fff; border: 1px solid #f59e0b; border-radius: 999px;
        padding: 8px 8px 8px 16px; box-shadow: 0 8px 24px rgba(0,0,0,.25); font-size: .85rem; line-height: 1.3; }
      .simulacao-faixa-texto { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .simulacao-faixa-texto small { color: #fcd34d; margin-left: 6px; }
      .simulacao-faixa button { flex-shrink: 0; border: 0; border-radius: 999px; background: #f59e0b; color: #1f2937;
        font-weight: 700; font-size: .82rem; padding: 0 14px; min-height: 36px; cursor: pointer; }
      .simulacao-faixa button:hover { background: #fbbf24; }
      @media (max-width: 768px) {
        .simulacao-faixa { bottom: calc(80px + env(safe-area-inset-bottom, 0px)); border-radius: 14px; gap: 8px;
          padding: 8px 8px 8px 12px; width: calc(100vw - 32px); }
        .simulacao-faixa-texto small { display: block; margin-left: 0; }
        .simulacao-faixa button { min-height: 44px; }
      }`;
    document.head.appendChild(css);
    document.documentElement.classList.add('simulando-acesso');

    const faixa = document.createElement('div');
    faixa.className = 'simulacao-faixa';
    faixa.setAttribute('role', 'status');
    faixa.innerHTML = `
      <span class="simulacao-faixa-texto" title="Você está vendo o sistema como este usuário. Nada pode ser alterado.">
        👁 Simulando <strong>${esc(u.nome)}</strong> · ${esc(perfis[u.tipo] || u.tipo)}<small>somente visualização</small>
      </span>
      <button type="button">Voltar ao meu acesso</button>`;
    faixa.querySelector('button').addEventListener('click', sair);
    document.body.appendChild(faixa);
  }

  if (document.body) montarFaixa();
  else document.addEventListener('DOMContentLoaded', montarFaixa);
})();
