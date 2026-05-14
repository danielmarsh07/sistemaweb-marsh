/**
 * theme.js — gerencia o tema (dark/light) com persistência em localStorage.
 *
 * Deve ser carregado no <head>, ANTES do CSS principal, para evitar
 * "flash of unstyled content" (FOUC) ao trocar de tema.
 *
 * API:
 *   getTheme()          → 'dark' | 'light'
 *   setTheme(t)         → grava em localStorage + aplica
 *   toggleTheme()       → alterna entre dark e light
 *   bindThemeToggle()   → liga listener no botão #theme-toggle
 */
(function () {
  'use strict';

  const KEY = 'marsh.theme';

  function preferenciaInicial() {
    try {
      const salvo = localStorage.getItem(KEY);
      if (salvo === 'light' || salvo === 'dark') return salvo;
    } catch (e) { /* localStorage indisponível */ }
    // Default: dark (visual da identidade) — só usa OS preference se for explicitamente light
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  function aplicar(t) {
    if (t === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  // Aplica imediatamente para evitar FOUC
  const inicial = preferenciaInicial();
  aplicar(inicial);

  window.getTheme = function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  };

  window.setTheme = function setTheme(t) {
    const valor = t === 'light' ? 'light' : 'dark';
    aplicar(valor);
    try { localStorage.setItem(KEY, valor); } catch (e) { /* ignora */ }
  };

  window.toggleTheme = function toggleTheme() {
    window.setTheme(window.getTheme() === 'dark' ? 'light' : 'dark');
  };

  window.bindThemeToggle = function bindThemeToggle() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', window.toggleTheme);
  };

  // Auto-bind quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.bindThemeToggle);
  } else {
    window.bindThemeToggle();
  }
})();
