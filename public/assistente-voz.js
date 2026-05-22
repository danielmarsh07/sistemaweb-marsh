// ============================================================================
// ASSISTENTE DE VOZ — módulo compartilhado (dashboard admin + portal cliente)
// Auto-contido: implementa próprio apiFetch e detecta refresh de pages disponível.
// ============================================================================
(function initAssistenteVoz() {
  const fab = document.getElementById('btn-assistente-voz');
  const modal = document.getElementById('modal-assistente');
  if (!fab || !modal) return;

  const API_URL = '/api';

  // apiFetch interno — não depende de globals do dashboard/portal
  async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('token');
    if (!token) {
      window.location.href = '/login.html';
      return null;
    }
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('usuario');
      window.location.href = '/login.html';
      return null;
    }
    return res;
  }

  const modalContent = modal.querySelector('.assistente-modal-content');
  const body = modal.querySelector('.assistente-body');
  const orb = document.getElementById('assistente-orb');
  const canvas = document.getElementById('assistente-canvas');
  const canvasNebulosa = document.getElementById('assistente-nebulosa-canvas');
  const nebulosaWrap = document.getElementById('assistente-nebulosa');
  const nebulosaHint = document.getElementById('nebulosa-hint');
  const canvasJarvis = document.getElementById('assistente-jarvis-canvas');
  const jarvisWrap = document.getElementById('assistente-jarvis');
  const jarvisHint = document.getElementById('jarvis-hint');
  const statusEl = document.getElementById('assistente-status');
  const transcriptEl = document.getElementById('assistente-transcript');
  const respostaEl = document.getElementById('assistente-resposta');
  const btnFalar = document.getElementById('btn-falar-assistente');
  const btnFalarTexto = document.getElementById('btn-falar-texto');
  const btnFechar = document.getElementById('btn-fechar-assistente');
  const btnReset = document.getElementById('btn-reset-assistente');
  const modeButtons = modal.querySelectorAll('.mode-btn');

  const MODO_KEY = 'assistente_modo_visual';
  const MODOS_VALIDOS = ['holograma', 'texto', 'nebulosa', 'jarvis'];
  let modoSalvo = localStorage.getItem(MODO_KEY);
  let modoAtual = MODOS_VALIDOS.includes(modoSalvo) ? modoSalvo : 'holograma';

  let particulas = [];

  let historico = [];
  let recognition = null;
  let estado = 'idle';
  let tomAtual = 'normal';

  let audioCtx = null;
  let analyser = null;
  let audioEl = null;
  let audioSourceNode = null;
  let rafId = null;
  let ttsDisponivel = null;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechSynth = window.speechSynthesis;
  const hasSTT = !!SpeechRecognition;
  const hasWebTTS = !!speechSynth;

  // ---------- Modo visual ----------

  function aplicarModo(modo) {
    if (!MODOS_VALIDOS.includes(modo)) modo = 'holograma';
    modoAtual = modo;
    body.setAttribute('data-modo', modo);
    modal.classList.toggle('modo-nebulosa-on', modo === 'nebulosa');
    modal.classList.toggle('modo-jarvis-on', modo === 'jarvis');
    modeButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.modo === modo));
    localStorage.setItem(MODO_KEY, modo);
    pararVisualizer();
    if (modo === 'holograma') desenharHolograma();
    if (modo === 'nebulosa') {
      ajustarCanvasNebulosa();
      inicializarParticulas();
      desenharNebulosa();
    }
    if (modo === 'jarvis') {
      ajustarCanvasJarvis();
      desenharJarvis();
    }
  }

  function setTom(tom) {
    tomAtual = (tom === 'alerta') ? 'alerta' : 'normal';
    modalContent.setAttribute('data-tom', tomAtual);
  }
  setTom('normal');

  function setEstado(novo) {
    estado = novo;
    orb.classList.remove('listening', 'processing', 'speaking');
    if (novo !== 'idle') orb.classList.add(novo);
    const labels = {
      idle:       'Toque no microfone e fale',
      listening:  '🎙️ Ouvindo... fale agora',
      processing: '⚙️ Processando...',
      speaking:   '🔊 Respondendo...'
    };
    statusEl.textContent = labels[novo] || labels.idle;
    btnFalar.disabled = (novo === 'processing');
    btnFalarTexto.textContent = (novo === 'listening') ? 'Parar' : 'Falar';
    if (nebulosaHint) nebulosaHint.classList.toggle('hidden', novo !== 'idle');
    if (jarvisHint)   jarvisHint.classList.toggle('hidden',   novo !== 'idle');
  }

  function mostrarTranscript(texto) {
    if (!texto) { transcriptEl.classList.remove('show'); transcriptEl.textContent = ''; return; }
    transcriptEl.textContent = `"${texto}"`;
    transcriptEl.classList.add('show');
  }

  function mostrarResposta(texto) {
    if (!texto) { respostaEl.classList.remove('show'); respostaEl.textContent = ''; return; }
    respostaEl.textContent = texto;
    respostaEl.classList.add('show');
  }

  function abrirModal() {
    if (!hasSTT) {
      alert('Seu navegador não suporta reconhecimento de voz. Use Chrome ou Edge no celular/desktop.');
      return;
    }
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    aplicarModo(modoAtual);
    setTom('normal');
    setEstado('idle');
    desenharHolograma();
  }

  function fecharModal() {
    pararEscuta();
    pararAudio();
    if (hasWebTTS) speechSynth.cancel();
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    pararVisualizer();
    setEstado('idle');
  }

  function resetar() {
    pararEscuta();
    pararAudio();
    if (hasWebTTS) speechSynth.cancel();
    historico = [];
    mostrarTranscript('');
    mostrarResposta('');
    setTom('normal');
    setEstado('idle');
  }

  function pararEscuta() {
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
  }

  // ---------- STT ----------

  function iniciarEscuta() {
    if (!hasSTT) return;
    pararAudio();
    if (hasWebTTS) speechSynth.cancel();
    mostrarTranscript('');
    mostrarResposta('');
    setTom('normal');

    recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let textoFinal = '';
    recognition.onstart = () => setEstado('listening');
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) textoFinal += t;
        else interim += t;
      }
      mostrarTranscript(textoFinal + interim);
    };
    recognition.onerror = (e) => {
      console.error('[assistente STT]', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        statusEl.textContent = '❌ Permissão de microfone negada.';
      } else if (e.error === 'no-speech') {
        statusEl.textContent = 'Nada escutado. Tente novamente.';
      } else {
        statusEl.textContent = `Erro: ${e.error}`;
      }
      setEstado('idle');
    };
    recognition.onend = () => {
      const texto = textoFinal.trim();
      recognition = null;
      if (!texto) { if (estado === 'listening') setEstado('idle'); return; }
      mostrarTranscript(texto);
      enviarParaAssistente(texto);
    };
    try { recognition.start(); }
    catch (err) { console.error('[assistente STT] start falhou', err); setEstado('idle'); }
  }

  // ---------- Chat ----------

  async function enviarParaAssistente(texto) {
    setEstado('processing');
    try {
      const res = await apiFetch(`${API_URL}/assistente/chat`, {
        method: 'POST',
        body: JSON.stringify({ texto, historico })
      });
      if (!res) return;
      const data = await res.json();
      if (!res.ok) {
        const msg = data.erro || 'Erro ao conversar com o assistente.';
        setTom('alerta');
        mostrarResposta(msg);
        falar(msg);
        return;
      }
      const resposta = data.resposta || 'Pronto.';
      setTom(data.tom);
      mostrarResposta(resposta);
      ttsDisponivel = !!data.tts_disponivel;
      if (Array.isArray(data.mensagens_para_proximo_turno)) {
        historico = [...historico, ...data.mensagens_para_proximo_turno].slice(-6);
      }
      if (Array.isArray(data.ui_refresh)) {
        data.ui_refresh.forEach(refreshPage);
      }
      falar(resposta);
    } catch (err) {
      console.error('[assistente chat]', err);
      const msg = 'Falha ao conversar com o assistente. Verifique sua conexão.';
      setTom('alerta');
      mostrarResposta(msg);
      falar(msg);
    }
  }

  function refreshPage(page) {
    try {
      // Dashboard (admin)
      if (page === 'dashboard'    && typeof window.loadDashboard    === 'function') window.loadDashboard();
      if (page === 'transacoes'   && typeof window.loadTransacoes   === 'function' && window.currentPage === 'transacoes') window.loadTransacoes();
      if (page === 'clientes'     && typeof window.loadClientes     === 'function' && window.currentPage === 'clientes')   window.loadClientes();
      if (page === 'fornecedores' && typeof window.loadFornecedores === 'function' && window.currentPage === 'fornecedores') window.loadFornecedores();
      if (page === 'chamados'     && typeof window.loadChamados     === 'function' && window.currentPage === 'chamados')   window.loadChamados();
      if (page === 'categorias-transacao' && typeof window.loadCategoriasTransacao === 'function' && window.currentPage === 'categorias-transacao') window.loadCategoriasTransacao();
      // Portal (cliente)
      if (page === 'chamados'  && typeof window.carregarPortal === 'function') window.carregarPortal();
      if (page === 'dashboard' && typeof window.carregarPortal === 'function') window.carregarPortal();
    } catch (e) {
      console.warn('[assistente refresh]', page, e);
    }
  }

  // ---------- TTS (OpenAI MP3 com fallback Web Speech) ----------

  async function falar(texto) {
    if (!texto) { setEstado('idle'); return; }
    setEstado('speaking');
    if (ttsDisponivel !== false) {
      try {
        const res = await apiFetch(`${API_URL}/assistente/tts`, {
          method: 'POST',
          body: JSON.stringify({ texto })
        });
        if (res && res.ok) {
          const blob = await res.blob();
          await tocarAudioComVisualizer(blob);
          return;
        }
        if (res && res.status === 503) ttsDisponivel = false;
      } catch (e) {
        console.warn('[assistente TTS falhou, fallback Web Speech]', e);
      }
    }
    falarComWebSpeech(texto);
  }

  function tocarAudioComVisualizer(blob) {
    return new Promise((resolve) => {
      pararAudio();
      try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const url = URL.createObjectURL(blob);
        audioEl = new Audio(url);
        audioEl.crossOrigin = 'anonymous';
        audioEl.playbackRate = 1.1;
        try { audioEl.preservesPitch = true; } catch {}
        try { audioEl.mozPreservesPitch = true; } catch {}
        try { audioEl.webkitPreservesPitch = true; } catch {}

        audioSourceNode = audioCtx.createMediaElementSource(audioEl);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        audioSourceNode.connect(analyser);
        analyser.connect(audioCtx.destination);

        iniciarVisualizerPorModo();
        audioEl.onended = () => { URL.revokeObjectURL(url); pararVisualizer(); pararAudio(); setEstado('idle'); resolve(); };
        audioEl.onerror = () => { URL.revokeObjectURL(url); pararVisualizer(); pararAudio(); setEstado('idle'); resolve(); };
        audioEl.play().catch(err => { console.warn('[assistente TTS play()]', err); setEstado('idle'); resolve(); });
      } catch (e) {
        console.error('[assistente TTS visualizer]', e);
        setEstado('idle');
        resolve();
      }
    });
  }

  function iniciarVisualizerPorModo() {
    if (modoAtual === 'nebulosa') iniciarVisualizerNebulosa();
    else if (modoAtual === 'jarvis') iniciarVisualizerJarvis();
    else iniciarVisualizer();
  }

  function pararAudio() {
    if (audioEl) { try { audioEl.pause(); } catch {} audioEl = null; }
    if (audioSourceNode) { try { audioSourceNode.disconnect(); } catch {} audioSourceNode = null; }
    analyser = null;
  }

  function falarComWebSpeech(texto) {
    if (!hasWebTTS) { setEstado('idle'); return; }
    speechSynth.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'pt-BR';
    u.rate = 0.98;
    u.pitch = 0.92;
    const vozes = speechSynth.getVoices();
    const vozPt = vozes.find(v => v.lang === 'pt-BR') || vozes.find(v => v.lang && v.lang.startsWith('pt'));
    if (vozPt) u.voice = vozPt;
    u.onend = () => { pararVisualizer(); setEstado('idle'); };
    u.onerror = () => { pararVisualizer(); setEstado('idle'); };
    if (modoAtual === 'nebulosa') iniciarVisualizerNebulosaFake();
    else if (modoAtual === 'jarvis') iniciarVisualizerJarvisFake();
    else iniciarVisualizerFake();
    speechSynth.speak(u);
  }

  // ---------- Holograma ----------

  function desenharHolograma() {
    if (!canvas || modoAtual !== 'holograma') return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(modalContent);
    const cor1 = cs.getPropertyValue('--holo-stroke').trim()   || '#22d3ee';
    const cor2 = cs.getPropertyValue('--holo-stroke-2').trim() || '#2563eb';
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, cor2); grad.addColorStop(0.5, cor1); grad.addColorStop(1, cor2);
    ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 6 + Date.now() / 600) * 4;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function iniciarVisualizer() {
    cancelAnimationFrame(rafId);
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 64);
    const desenha = () => {
      rafId = requestAnimationFrame(desenha);
      if (modoAtual !== 'holograma') return;
      if (analyser) analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, w, h);
      const cs = getComputedStyle(modalContent);
      const cor1 = cs.getPropertyValue('--holo-stroke').trim()   || '#22d3ee';
      const cor2 = cs.getPropertyValue('--holo-stroke-2').trim() || '#2563eb';
      const bars = 48;
      const step = data.length / bars;
      const barW = (w - (bars - 1) * 2) / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor(i * step)] / 255;
        const altura = Math.max(2, v * (h * 0.55));
        const x = i * (barW + 2);
        const y = (h - altura) / 2;
        const grad = ctx.createLinearGradient(0, y, 0, y + altura);
        grad.addColorStop(0, cor1); grad.addColorStop(1, cor2);
        ctx.fillStyle = grad; ctx.fillRect(x, y, barW, altura);
        ctx.fillStyle = `${cor1}33`;
        ctx.fillRect(x, y - 2, barW, 2);
        ctx.fillRect(x, y + altura, barW, 2);
      }
      ctx.strokeStyle = `${cor1}40`; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    };
    desenha();
  }

  function iniciarVisualizerFake() {
    cancelAnimationFrame(rafId);
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const bars = 48;
    const data = new Array(bars).fill(0);
    const desenha = () => {
      rafId = requestAnimationFrame(desenha);
      if (modoAtual !== 'holograma') return;
      ctx.clearRect(0, 0, w, h);
      const cs = getComputedStyle(modalContent);
      const cor1 = cs.getPropertyValue('--holo-stroke').trim()   || '#22d3ee';
      const cor2 = cs.getPropertyValue('--holo-stroke-2').trim() || '#2563eb';
      const barW = (w - (bars - 1) * 2) / bars;
      for (let i = 0; i < bars; i++) {
        data[i] = data[i] * 0.7 + Math.random() * 0.3;
        const altura = Math.max(2, data[i] * (h * 0.5));
        const x = i * (barW + 2);
        const y = (h - altura) / 2;
        const grad = ctx.createLinearGradient(0, y, 0, y + altura);
        grad.addColorStop(0, cor1); grad.addColorStop(1, cor2);
        ctx.fillStyle = grad; ctx.fillRect(x, y, barW, altura);
      }
    };
    desenha();
  }

  function pararVisualizer() {
    cancelAnimationFrame(rafId);
    rafId = null;
    if (modoAtual === 'holograma') desenharHolograma();
    if (modoAtual === 'nebulosa')  desenharNebulosa();
    if (modoAtual === 'jarvis')    desenharJarvis();
  }

  // ---------- Nebulosa ----------

  function ajustarCanvasNebulosa() {
    if (!canvasNebulosa) return;
    const rect = nebulosaWrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasNebulosa.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvasNebulosa.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvasNebulosa.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function inicializarParticulas() {
    const rect = nebulosaWrap.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const n = Math.min(50, Math.max(24, Math.floor((w * h) / 18000)));
    particulas = [];
    for (let i = 0; i < n; i++) {
      particulas.push({
        x: Math.random() * w,
        y: Math.random() * h,
        raioBase: 60 + Math.random() * 180,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        fase: Math.random() * Math.PI * 2,
        intensidadeBase: 0.22 + Math.random() * 0.35
      });
    }
  }

  function corNebulosa() {
    const cs = getComputedStyle(modalContent);
    const cor1 = cs.getPropertyValue('--holo-stroke').trim()   || '#22d3ee';
    const cor2 = cs.getPropertyValue('--holo-stroke-2').trim() || '#2563eb';
    return { cor1, cor2 };
  }

  function hexToRgb(hex) {
    hex = (hex || '').replace('#', '').trim();
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) return [34, 211, 238];
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  function desenharNebulosa() {
    if (!canvasNebulosa || modoAtual !== 'nebulosa') return;
    if (!particulas.length) inicializarParticulas();
    const ctx = canvasNebulosa.getContext('2d');
    const rect = nebulosaWrap.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    const { cor1, cor2 } = corNebulosa();
    const [r1, g1, b1] = hexToRgb(cor1);
    const [r2, g2, b2] = hexToRgb(cor2);
    const t = Date.now() / 4000;
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particulas) {
      const r = p.raioBase * (0.9 + Math.sin(t + p.fase) * 0.08) * p.intensidadeBase;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      const mix = (Math.sin(t * 0.7 + p.fase) + 1) / 2;
      const rc = Math.round(r1 * mix + r2 * (1 - mix));
      const gc = Math.round(g1 * mix + g2 * (1 - mix));
      const bc = Math.round(b1 * mix + b2 * (1 - mix));
      grad.addColorStop(0, `rgba(${rc}, ${gc}, ${bc}, ${0.22 * p.intensidadeBase})`);
      grad.addColorStop(1, `rgba(${rc}, ${gc}, ${bc}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function iniciarVisualizerNebulosa() {
    cancelAnimationFrame(rafId);
    if (!particulas.length) inicializarParticulas();
    const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 64);
    const ctx = canvasNebulosa.getContext('2d');
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (modoAtual !== 'nebulosa') return;
      const rect = nebulosaWrap.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);
      let amp = 0;
      if (analyser) {
        analyser.getByteFrequencyData(data);
        let s = 0; for (let i = 0; i < data.length; i++) s += data[i];
        amp = (s / data.length) / 255;
      }
      const ampSmooth = Math.pow(amp, 0.7);
      const { cor1, cor2 } = corNebulosa();
      const [r1, g1, b1] = hexToRgb(cor1);
      const [r2, g2, b2] = hexToRgb(cor2);
      const t = Date.now() / 1600;
      ctx.globalCompositeOperation = 'lighter';
      for (const p of particulas) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -200) p.x = w + 200; if (p.x > w + 200) p.x = -200;
        if (p.y < -200) p.y = h + 200; if (p.y > h + 200) p.y = -200;
        p.fase += 0.005;
        const pulse = 1 + ampSmooth * 1.4;
        const r = p.raioBase * (0.85 + Math.sin(t + p.fase) * 0.1) * p.intensidadeBase * pulse;
        const alpha = (0.18 + ampSmooth * 0.45) * p.intensidadeBase;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        const mix = (Math.sin(t * 0.7 + p.fase) + 1) / 2;
        const rc = Math.round(r1 * mix + r2 * (1 - mix));
        const gc = Math.round(g1 * mix + g2 * (1 - mix));
        const bc = Math.round(b1 * mix + b2 * (1 - mix));
        grad.addColorStop(0, `rgba(${rc}, ${gc}, ${bc}, ${alpha})`);
        grad.addColorStop(0.6, `rgba(${rc}, ${gc}, ${bc}, ${alpha * 0.25})`);
        grad.addColorStop(1, `rgba(${rc}, ${gc}, ${bc}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      const cx = w / 2, cy = h / 2;
      const coreR = 30 + ampSmooth * 90;
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2);
      coreGrad.addColorStop(0,   `rgba(${r1}, ${g1}, ${b1}, ${0.5 + ampSmooth * 0.4})`);
      coreGrad.addColorStop(0.4, `rgba(${r2}, ${g2}, ${b2}, ${0.25 + ampSmooth * 0.2})`);
      coreGrad.addColorStop(1,   `rgba(${r2}, ${g2}, ${b2}, 0)`);
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    };
    tick();
  }

  function iniciarVisualizerNebulosaFake() {
    cancelAnimationFrame(rafId);
    if (!particulas.length) inicializarParticulas();
    let amp = 0;
    const ctx = canvasNebulosa.getContext('2d');
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (modoAtual !== 'nebulosa') return;
      amp = amp * 0.85 + Math.random() * 0.15;
      const rect = nebulosaWrap.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);
      const { cor1, cor2 } = corNebulosa();
      const [r1, g1, b1] = hexToRgb(cor1);
      const [r2, g2, b2] = hexToRgb(cor2);
      const t = Date.now() / 1600;
      ctx.globalCompositeOperation = 'lighter';
      for (const p of particulas) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -200) p.x = w + 200; if (p.x > w + 200) p.x = -200;
        if (p.y < -200) p.y = h + 200; if (p.y > h + 200) p.y = -200;
        p.fase += 0.005;
        const pulse = 1 + amp * 1.2;
        const r = p.raioBase * (0.85 + Math.sin(t + p.fase) * 0.1) * p.intensidadeBase * pulse;
        const alpha = (0.18 + amp * 0.35) * p.intensidadeBase;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        const mix = (Math.sin(t * 0.7 + p.fase) + 1) / 2;
        const rc = Math.round(r1 * mix + r2 * (1 - mix));
        const gc = Math.round(g1 * mix + g2 * (1 - mix));
        const bc = Math.round(b1 * mix + b2 * (1 - mix));
        grad.addColorStop(0, `rgba(${rc}, ${gc}, ${bc}, ${alpha})`);
        grad.addColorStop(1, `rgba(${rc}, ${gc}, ${bc}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    tick();
  }

  // ---------- JARVIS HUD (fullscreen, visualizer polar + esfera + brackets) ----------

  function ajustarCanvasJarvis() {
    if (!canvasJarvis || !jarvisWrap) return;
    const rect = jarvisWrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasJarvis.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvasJarvis.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvasJarvis.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function corJarvis() {
    const cs = getComputedStyle(modalContent);
    const cor1 = cs.getPropertyValue('--holo-stroke').trim()   || '#22d3ee';
    const cor2 = cs.getPropertyValue('--holo-stroke-2').trim() || '#2563eb';
    return { cor1, cor2 };
  }

  // JARVIS idle (sem áudio) — esfera central pulsante + barras radiais sutis
  function desenharJarvis() {
    if (!canvasJarvis || modoAtual !== 'jarvis') return;
    const ctx = canvasJarvis.getContext('2d');
    const rect = jarvisWrap.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const { cor1, cor2 } = corJarvis();
    const [r1, g1, b1] = hexToRgb(cor1);
    const [r2, g2, b2] = hexToRgb(cor2);
    const cx = w / 2, cy = h / 2;
    const t = Date.now() / 1000;

    ctx.globalCompositeOperation = 'lighter';

    // Esfera central com glow pulsante
    const breath = 0.85 + Math.sin(t * 1.6) * 0.15;
    const coreR = 22 * breath;
    const glowR = 90 * breath;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    g.addColorStop(0,    `rgba(${r1}, ${g1}, ${b1}, 0.85)`);
    g.addColorStop(0.25, `rgba(${r1}, ${g1}, ${b1}, 0.35)`);
    g.addColorStop(1,    `rgba(${r2}, ${g2}, ${b2}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Núcleo
    ctx.fillStyle = `rgba(255, 255, 255, 0.92)`;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 0.4, 0, Math.PI * 2);
    ctx.fill();

    // Barras radiais idle (sutis, rotacionando devagar)
    const bars = 64;
    const innerR = 110;
    const outerR = 140;
    for (let i = 0; i < bars; i++) {
      const ang = (i / bars) * Math.PI * 2 + t * 0.05;
      const amp = 0.3 + 0.3 * Math.abs(Math.sin(i * 0.5 + t * 0.7));
      const len = (outerR - innerR) * amp;
      const x1 = cx + Math.cos(ang) * innerR;
      const y1 = cy + Math.sin(ang) * innerR;
      const x2 = cx + Math.cos(ang) * (innerR + len);
      const y2 = cy + Math.sin(ang) * (innerR + len);
      ctx.strokeStyle = `rgba(${r1}, ${g1}, ${b1}, ${0.25 + amp * 0.35})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  function iniciarVisualizerJarvis() {
    cancelAnimationFrame(rafId);
    const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 64);
    const ctx = canvasJarvis.getContext('2d');

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (modoAtual !== 'jarvis') return;
      const rect = jarvisWrap.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      // Amplitude média (0..1)
      let amp = 0;
      if (analyser) {
        analyser.getByteFrequencyData(data);
        let s = 0; for (let i = 0; i < data.length; i++) s += data[i];
        amp = (s / data.length) / 255;
      }
      const ampSmooth = Math.pow(amp, 0.7);

      const { cor1, cor2 } = corJarvis();
      const [r1, g1, b1] = hexToRgb(cor1);
      const [r2, g2, b2] = hexToRgb(cor2);
      const cx = w / 2, cy = h / 2;
      const t = Date.now() / 1000;

      ctx.globalCompositeOperation = 'lighter';

      // Esfera central reagindo à amplitude
      const breath = 1 + ampSmooth * 1.6;
      const glowR = 130 * breath;
      const g1grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      g1grad.addColorStop(0,    `rgba(255, 255, 255, ${0.85 + ampSmooth * 0.15})`);
      g1grad.addColorStop(0.15, `rgba(${r1}, ${g1}, ${b1}, ${0.75 + ampSmooth * 0.25})`);
      g1grad.addColorStop(0.5,  `rgba(${r1}, ${g1}, ${b1}, ${0.25 + ampSmooth * 0.20})`);
      g1grad.addColorStop(1,    `rgba(${r2}, ${g2}, ${b2}, 0)`);
      ctx.fillStyle = g1grad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();

      // Núcleo branco
      ctx.fillStyle = `rgba(255, 255, 255, ${0.95})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 12 + ampSmooth * 12, 0, Math.PI * 2);
      ctx.fill();

      // Visualizer polar (barras radiais reagindo às bandas de frequência)
      const bars = data.length || 64;
      const passo = Math.PI * 2 / bars;
      const innerR = 110;
      const maxLen = Math.min(w, h) * 0.32;

      for (let i = 0; i < bars; i++) {
        const v = analyser ? (data[i] / 255) : (0.3 + Math.random() * 0.2);
        const len = Math.max(2, v * maxLen);
        const ang = i * passo + t * 0.1;
        const x1 = cx + Math.cos(ang) * innerR;
        const y1 = cy + Math.sin(ang) * innerR;
        const x2 = cx + Math.cos(ang) * (innerR + len);
        const y2 = cy + Math.sin(ang) * (innerR + len);

        const grad = ctx.createLinearGradient(x1, y1, x2, y2);
        grad.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, ${0.85})`);
        grad.addColorStop(1, `rgba(${r2}, ${g2}, ${b2}, 0.1)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'source-over';
    };
    tick();
  }

  function iniciarVisualizerJarvisFake() {
    cancelAnimationFrame(rafId);
    let amp = 0;
    const ctx = canvasJarvis.getContext('2d');

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (modoAtual !== 'jarvis') return;
      amp = amp * 0.82 + Math.random() * 0.18;
      const rect = jarvisWrap.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const { cor1, cor2 } = corJarvis();
      const [r1, g1, b1] = hexToRgb(cor1);
      const [r2, g2, b2] = hexToRgb(cor2);
      const cx = w / 2, cy = h / 2;
      const t = Date.now() / 1000;

      ctx.globalCompositeOperation = 'lighter';

      const breath = 1 + amp * 1.2;
      const glowR = 130 * breath;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      grad.addColorStop(0,    `rgba(255, 255, 255, ${0.75 + amp * 0.2})`);
      grad.addColorStop(0.2,  `rgba(${r1}, ${g1}, ${b1}, ${0.6 + amp * 0.2})`);
      grad.addColorStop(1,    `rgba(${r2}, ${g2}, ${b2}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255, 255, 255, 0.85)`;
      ctx.beginPath();
      ctx.arc(cx, cy, 10 + amp * 10, 0, Math.PI * 2);
      ctx.fill();

      const bars = 64;
      const passo = Math.PI * 2 / bars;
      const innerR = 110;
      const maxLen = Math.min(w, h) * 0.28;
      for (let i = 0; i < bars; i++) {
        const v = 0.2 + amp * 0.6 + Math.sin(i * 0.5 + t * 1.5) * 0.15;
        const len = Math.max(2, v * maxLen);
        const ang = i * passo + t * 0.1;
        const x1 = cx + Math.cos(ang) * innerR;
        const y1 = cy + Math.sin(ang) * innerR;
        const x2 = cx + Math.cos(ang) * (innerR + len);
        const y2 = cy + Math.sin(ang) * (innerR + len);
        const lg = ctx.createLinearGradient(x1, y1, x2, y2);
        lg.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, 0.7)`);
        lg.addColorStop(1, `rgba(${r2}, ${g2}, ${b2}, 0.05)`);
        ctx.strokeStyle = lg;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    tick();
  }

  // ---------- Listeners ----------

  function toggleFalar() {
    if (estado === 'listening') { pararEscuta(); setEstado('idle'); }
    else if (estado === 'speaking') { pararAudio(); if (hasWebTTS) speechSynth.cancel(); iniciarEscuta(); }
    else { iniciarEscuta(); }
  }

  fab.addEventListener('click', abrirModal);
  btnFechar.addEventListener('click', fecharModal);
  btnReset.addEventListener('click', resetar);
  modeButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      aplicarModo(btn.dataset.modo);
    });
  });
  btnFalar.addEventListener('click', toggleFalar);
  if (nebulosaWrap) {
    nebulosaWrap.addEventListener('click', (e) => {
      if (modoAtual !== 'nebulosa') return;
      e.stopPropagation();
      toggleFalar();
    });
  }
  if (jarvisWrap) {
    jarvisWrap.addEventListener('click', (e) => {
      if (modoAtual !== 'jarvis') return;
      e.stopPropagation();
      toggleFalar();
    });
  }
  window.addEventListener('resize', () => {
    if (!modal.classList.contains('show')) return;
    if (modoAtual === 'nebulosa') {
      ajustarCanvasNebulosa();
      inicializarParticulas();
    }
    if (modoAtual === 'jarvis') {
      ajustarCanvasJarvis();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('show')) fecharModal();
  });
  modal.addEventListener('click', (e) => {
    if (modoAtual === 'nebulosa' || modoAtual === 'jarvis') return;
    if (e.target === modal) fecharModal();
  });
  if (hasWebTTS) speechSynth.onvoiceschanged = () => {};
})();
