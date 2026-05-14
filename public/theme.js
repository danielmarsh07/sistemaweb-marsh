/**
 * theme.js — gerencia tema da aplicação (dark / light / enterprise).
 *
 * Carrega no <head> ANTES do CSS para aplicar instantaneamente e
 * evitar "flash of unstyled content" (FOUC).
 *
 * Estratégia de persistência:
 *   1. Pre-FOUC: lê tema do objeto `usuario` em localStorage (vindo do login)
 *      ou da chave `marsh.theme`. Aplica imediato.
 *   2. Depois do login: cliente chama `Theme.syncFromServer()` (opcional)
 *      para garantir consistência caso o usuário tenha trocado em outro
 *      dispositivo. setTheme() envia PUT /api/usuarios/me/tema.
 *
 * API global:
 *   Theme.get()                → string ('dark'|'light'|'enterprise')
 *   Theme.set(t, {persist})    → aplica + grava local + (se logado) salva server
 *   Theme.list()               → metadata dos temas (para UI)
 *   Theme.onChange(cb)         → escuta mudanças
 */
(function () {
  'use strict';

  const KEY = 'marsh.theme';
  const VALID = ['dark', 'light', 'enterprise'];
  const DEFAULT = 'dark';

  const META = {
    dark: {
      id: 'dark',
      nome: 'Marsh Dark',
      descricao: 'Tema padrão. Futurista, com glassmorphism e neon discreto.',
      swatches: ['#020817', '#1e293b', '#2563eb', '#22d3ee']
    },
    light: {
      id: 'light',
      nome: 'Marsh Light',
      descricao: 'Claro e moderno. Inspirado em Vercel e Linear, mantém o glass.',
      swatches: ['#f5f5f7', '#ffffff', '#2563eb', '#0a0a0a']
    },
    enterprise: {
      id: 'enterprise',
      nome: 'Marsh Enterprise',
      descricao: 'Sério e corporativo. Visual SAP Fiori — sem glass, foco em formalidade.',
      swatches: ['#f5f6f7', '#ffffff', '#0070f2', '#1d2d3e']
    }
  };

  function lerUsuarioLS() {
    try { return JSON.parse(localStorage.getItem('usuario') || 'null'); } catch (e) { return null; }
  }

  function preferenciaInicial() {
    try {
      const u = lerUsuarioLS();
      if (u && VALID.includes(u.tema)) return u.tema;
      const salvo = localStorage.getItem(KEY);
      if (VALID.includes(salvo)) return salvo;
    } catch (e) { /* localStorage indisponível */ }
    return DEFAULT;
  }

  function aplicar(t) {
    const valor = VALID.includes(t) ? t : DEFAULT;
    if (valor === DEFAULT) {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', valor);
    }
  }

  // Aplica imediatamente para evitar FOUC
  aplicar(preferenciaInicial());

  const listeners = new Set();

  const Theme = {
    get() {
      return document.documentElement.getAttribute('data-theme') || DEFAULT;
    },

    list() {
      return VALID.map(id => ({ ...META[id] }));
    },

    meta(id) {
      return META[id] ? { ...META[id] } : null;
    },

    async set(t, opts = {}) {
      const valor = VALID.includes(t) ? t : DEFAULT;
      aplicar(valor);
      try { localStorage.setItem(KEY, valor); } catch (e) { /* ignora */ }

      // Atualiza usuario no localStorage (consistência)
      try {
        const u = lerUsuarioLS();
        if (u) { u.tema = valor; localStorage.setItem('usuario', JSON.stringify(u)); }
      } catch (e) { /* ignora */ }

      // Notifica listeners
      listeners.forEach(cb => { try { cb(valor); } catch (e) {} });

      // Persiste no servidor (se houver token e não foi explicitamente desligado)
      if (opts.persist !== false) {
        const token = localStorage.getItem('token');
        if (token) {
          try {
            await fetch('/api/usuarios/me/tema', {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ tema: valor })
            });
          } catch (e) { /* silencioso — funciona local mesmo se offline */ }
        }
      }

      return valor;
    },

    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /** Re-sincroniza com o que está salvo no servidor (após login). */
    async syncFromServer() {
      const token = localStorage.getItem('token');
      if (!token) return null;
      try {
        const r = await fetch('/api/usuarios/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!r.ok) return null;
        const data = await r.json();
        if (VALID.includes(data.tema) && data.tema !== this.get()) {
          this.set(data.tema, { persist: false });
        }
        return data.tema;
      } catch (e) { return null; }
    },

    /** Lookup do tema por email (pre-login, anti-FOUC). */
    async lookupByEmail(email) {
      if (!email) return null;
      try {
        const r = await fetch(`/api/auth/tema?email=${encodeURIComponent(email)}`);
        if (!r.ok) return null;
        const data = await r.json();
        if (VALID.includes(data.tema)) {
          this.set(data.tema, { persist: false });
        }
        return data.tema;
      } catch (e) { return null; }
    }
  };

  window.Theme = Theme;
})();
