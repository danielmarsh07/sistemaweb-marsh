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
  const ivyWrap = document.getElementById('assistente-ivy');
  const ivyPalco = document.getElementById('ivy-palco');
  const canvasIvy = document.getElementById('assistente-ivy-canvas');
  const btnVozRobotica = document.getElementById('btn-voz-robotica');
  const statusEl = document.getElementById('assistente-status');
  const transcriptEl = document.getElementById('assistente-transcript');
  const respostaEl = document.getElementById('assistente-resposta');
  const btnFalar = document.getElementById('btn-falar-assistente');
  const btnFalarTexto = document.getElementById('btn-falar-texto');
  const btnFechar = document.getElementById('btn-fechar-assistente');
  const btnReset = document.getElementById('btn-reset-assistente');
  const modeButtons = modal.querySelectorAll('.mode-btn');

  // v2: quem já tinha um modo salvo passa a abrir na Ivy uma vez
  const MODO_KEY = 'assistente_modo_visual_v2';
  const MODOS_VALIDOS = ['ivy', 'holograma', 'texto', 'nebulosa', 'jarvis'];
  let modoSalvo = localStorage.getItem(MODO_KEY);
  let modoAtual = MODOS_VALIDOS.includes(modoSalvo) ? modoSalvo : 'ivy';

  // Efeito de voz robótica (aplicado no áudio da OpenAI): liga/desliga no botão do cabeçalho
  const VOZ_KEY = 'assistente_voz_robotica';
  let vozRobotica = localStorage.getItem(VOZ_KEY) !== 'off';
  const EFEITO_ROBO = { ringHz: 48, ring: 0.4, seco: 0.75, metal: 0.28, metalAtraso: 0.006, metalRetorno: 0.35 };
  let nosEfeito = [];

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
    modal.classList.toggle('modo-ivy-on', modo === 'ivy');
    modeButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.modo === modo));
    localStorage.setItem(MODO_KEY, modo);
    pararVisualizer();
    if (modo === 'ivy') {
      ajustarCanvasIvy();
      iniciarLoopIvy();
    } else {
      pararLoopIvy();
    }
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
    if (ivyWrap) ivyWrap.dataset.estado = novo;
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
    pararLoopIvy();
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

  // Recarrega a tela aberta quando o assistente gravou algo nela.
  // currentPage é um `let` global do script.js (não fica em window), por isso o typeof.
  const RECARREGAR = {
    clientes: 'loadClientes',
    fornecedores: 'loadFornecedores',
    chamados: 'loadChamados',
    'contas-pagar': 'loadContasPagar',
    'fluxo-caixa': 'loadFluxoCaixa',
    faturamento: 'loadFaturamento',
    'categorias-despesa': 'loadPaginaCategoriasDespesa'
  };

  function refreshPage(page) {
    try {
      const paginaAtual = typeof currentPage !== 'undefined' ? currentPage : null;
      // Dashboard (admin)
      if (page === 'dashboard' && paginaAtual === 'dashboard' && typeof window.loadDashboard === 'function') window.loadDashboard();
      const fn = RECARREGAR[page];
      if (fn && paginaAtual === page && typeof window[fn] === 'function') window[fn]();
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
        if (vozRobotica) ligarEfeitoRobo(audioSourceNode, analyser);
        else audioSourceNode.connect(analyser);
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

  // Voz "meio robótica": parte do sinal passa por um modulador em anel (timbre metálico)
  // e por um atraso curto com retorno (ressonância de lata); o resto segue limpo para manter a clareza.
  function ligarEfeitoRobo(origem, destino) {
    const seco = audioCtx.createGain();
    seco.gain.value = EFEITO_ROBO.seco;
    origem.connect(seco).connect(destino);

    const anel = audioCtx.createGain();
    anel.gain.value = 0;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = EFEITO_ROBO.ringHz;
    osc.connect(anel.gain);
    osc.start();
    const anelSaida = audioCtx.createGain();
    anelSaida.gain.value = EFEITO_ROBO.ring;
    origem.connect(anel).connect(anelSaida).connect(destino);

    const atraso = audioCtx.createDelay(0.05);
    atraso.delayTime.value = EFEITO_ROBO.metalAtraso;
    const retorno = audioCtx.createGain();
    retorno.gain.value = EFEITO_ROBO.metalRetorno;
    atraso.connect(retorno).connect(atraso);
    const metal = audioCtx.createGain();
    metal.gain.value = EFEITO_ROBO.metal;
    origem.connect(atraso).connect(metal).connect(destino);

    nosEfeito = [seco, anel, osc, anelSaida, atraso, retorno, metal];
  }

  function desligarEfeitoRobo() {
    nosEfeito.forEach(n => {
      try { if (n.stop) n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    });
    nosEfeito = [];
  }

  function aplicarVozRobotica() {
    if (!btnVozRobotica) return;
    btnVozRobotica.classList.toggle('is-active', vozRobotica);
    btnVozRobotica.setAttribute('aria-pressed', String(vozRobotica));
    btnVozRobotica.title = vozRobotica ? 'Voz robótica: ligada' : 'Voz robótica: desligada';
  }

  function iniciarVisualizerPorModo() {
    if (modoAtual === 'ivy') return; // o loop da Ivy lê o analyser sozinho
    if (modoAtual === 'nebulosa') iniciarVisualizerNebulosa();
    else if (modoAtual === 'jarvis') iniciarVisualizerJarvis();
    else iniciarVisualizer();
  }

  function pararAudio() {
    if (audioEl) { try { audioEl.pause(); } catch {} audioEl = null; }
    if (audioSourceNode) { try { audioSourceNode.disconnect(); } catch {} audioSourceNode = null; }
    desligarEfeitoRobo();
    analyser = null;
  }

  function falarComWebSpeech(texto) {
    if (!hasWebTTS) { setEstado('idle'); return; }
    speechSynth.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'pt-BR';
    u.rate = 1.0;
    u.pitch = 1.1;
    // Ivy é feminina: prefere uma voz feminina pt-BR do navegador (a "Google português do Brasil" é feminina)
    const vozes = speechSynth.getVoices().filter(v => v.lang && v.lang.replace('_', '-').startsWith('pt'));
    const feminina = /francisca|maria|luciana|thalita|vit[oó]ria|let[ií]cia|camila|helo[ií]sa|google portugu[eê]s do brasil|female|feminina/i;
    const vozPt = vozes.find(v => v.lang.replace('_', '-') === 'pt-BR' && feminina.test(v.name))
      || vozes.find(v => feminina.test(v.name))
      || vozes.find(v => v.lang.replace('_', '-') === 'pt-BR')
      || vozes[0];
    if (vozPt) u.voice = vozPt;
    u.onend = () => { pararVisualizer(); setEstado('idle'); };
    u.onerror = () => { pararVisualizer(); setEstado('idle'); };
    // Na Ivy o próprio loop simula a boca enquanto o estado é "speaking"
    if (modoAtual === 'nebulosa') iniciarVisualizerNebulosaFake();
    else if (modoAtual === 'jarvis') iniciarVisualizerJarvisFake();
    else if (modoAtual !== 'ivy') iniciarVisualizerFake();
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

  // ---------- IVY (robô da marca que se mexe e fala) ----------
  // Um loop só, enquanto o modo está aberto: cabeça flutuando, olhar seguindo o mouse,
  // piscadas, boca/olhos/orelha pelo volume da fala e um anel de onda em volta.

  const semMovimento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let rafIvy = null;
  const ivy = { amp: 0, dx: 0, dy: 0, rz: 0, mx: 0, my: 0, proxPiscada: 0, piscadaIni: 0 };
  let dadosIvy = new Uint8Array(128);

  function ajustarCanvasIvy() {
    if (!canvasIvy) return;
    const rect = canvasIvy.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasIvy.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvasIvy.height = Math.max(1, Math.floor(rect.height * dpr));
    canvasIvy.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Volume da fala 0..1: do analyser (áudio da OpenAI) ou simulado em sílabas (voz do navegador)
  function volumeIvy(t) {
    if (estado !== 'speaking') return 0;
    if (analyser) {
      if (dadosIvy.length !== analyser.frequencyBinCount) dadosIvy = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(dadosIvy);
      // faixa da voz (≈ 170 Hz a 3,5 kHz com fftSize 256)
      let s = 0; const ini = 1, fim = Math.min(20, dadosIvy.length);
      for (let i = ini; i < fim; i++) s += dadosIvy[i];
      return Math.min(1, Math.pow((s / (fim - ini)) / 255, 0.8) * 1.5);
    }
    const silaba = Math.max(0, Math.sin(t * 13.5)) * (0.55 + 0.45 * Math.sin(t * 2.7 + 1));
    return Math.min(1, silaba * 0.9 + Math.random() * 0.1);
  }

  function frameIvy() {
    rafIvy = requestAnimationFrame(frameIvy);
    if (modoAtual !== 'ivy' || !ivyWrap) return;
    const agora = performance.now();
    const t = agora / 1000;

    // Boca abre rápido e fecha um pouco mais devagar
    const alvo = volumeIvy(t);
    ivy.amp += (alvo - ivy.amp) * (alvo > ivy.amp ? 0.55 : 0.22);

    // Cabeça: flutua, segue o mouse e acena um pouco quando fala; ouvindo, se inclina para o usuário
    const ouvindo = estado === 'listening';
    const mov = semMovimento ? 0 : 1;
    const alvoDx = (ivy.mx * 1.6 + (ouvindo ? 0.8 : 0)) * mov;
    const alvoDy = (Math.sin(t * 0.9) * 1.1 + ivy.my * 1.0 + ivy.amp * 0.5) * mov;
    const alvoRz = (Math.sin(t * 0.6) * 1.1 + ivy.mx * 1.2 + Math.sin(t * 7) * ivy.amp * 1.4 + (ouvindo ? -1.5 : 0)) * mov;
    ivy.dx += (alvoDx - ivy.dx) * 0.06;
    ivy.dy += (alvoDy - ivy.dy) * 0.06;
    ivy.rz += (alvoRz - ivy.rz) * 0.08;

    // Piscadas a cada 2,5–6 s (180 ms)
    if (!ivy.proxPiscada) ivy.proxPiscada = agora + 1500;
    if (agora >= ivy.proxPiscada) { ivy.piscadaIni = agora; ivy.proxPiscada = agora + 2500 + Math.random() * 3500; }
    const p = (agora - ivy.piscadaIni) / 180;
    const piscar = (p >= 0 && p <= 1) ? 1 - Math.abs(p * 2 - 1) : 0;

    const tam = ivyPalco ? ivyPalco.clientWidth : 300;
    const st = ivyWrap.style;
    st.setProperty('--ivy-amp', ivy.amp.toFixed(3));
    st.setProperty('--ivy-dx', ivy.dx.toFixed(2) + '%');
    st.setProperty('--ivy-dy', ivy.dy.toFixed(2) + '%');
    st.setProperty('--ivy-rz', ivy.rz.toFixed(2) + 'deg');
    st.setProperty('--ivy-ox', (ivy.mx * tam * 0.005 * mov).toFixed(2) + 'px');
    st.setProperty('--ivy-oy', (ivy.my * tam * 0.004 * mov).toFixed(2) + 'px');
    st.setProperty('--ivy-piscar', piscar.toFixed(3));

    desenharOndaIvy(t);
  }

  // Anel de onda em volta da moldura: calmo parado, vivo quando ela fala ou ouve
  function desenharOndaIvy(t) {
    if (!canvasIvy) return;
    const ctx = canvasIvy.getContext('2d');
    const w = canvasIvy.clientWidth, h = canvasIvy.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const { cor1, cor2 } = corJarvis();
    const [r1, g1, b1] = hexToRgb(cor1);
    const [r2, g2, b2] = hexToRgb(cor2);
    const cx = w / 2, cy = h / 2;
    const raio = (Math.min(w, h) / 1.32) / 2 + 8; // canvas é 132% da moldura
    const barras = 120;
    const maxLen = Math.min(w, h) * 0.075;
    const ouvindo = estado === 'listening';
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < barras; i++) {
      const ang = (i / barras) * Math.PI * 2 - Math.PI / 2 + t * 0.06;
      let v;
      if (estado === 'speaking' && analyser) {
        const k = 1 + Math.floor(Math.abs(Math.sin(i * 0.9)) * 30);
        v = (dadosIvy[k] || 0) / 255 * 0.8 + ivy.amp * 0.3;
      } else {
        const base = ouvindo ? 0.32 : 0.12;
        v = base * (0.5 + 0.5 * Math.sin(i * 0.45 + t * (ouvindo ? 4 : 1.4))) + ivy.amp * 0.6 * Math.abs(Math.sin(i * 1.7 + t * 9));
      }
      const len = 2 + v * maxLen;
      const x1 = cx + Math.cos(ang) * raio, y1 = cy + Math.sin(ang) * raio;
      const x2 = cx + Math.cos(ang) * (raio + len), y2 = cy + Math.sin(ang) * (raio + len);
      const mix = (Math.sin(ang * 2 + t) + 1) / 2;
      ctx.strokeStyle = `rgba(${Math.round(r1 * mix + r2 * (1 - mix))}, ${Math.round(g1 * mix + g2 * (1 - mix))}, ${Math.round(b1 * mix + b2 * (1 - mix))}, ${0.35 + v * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function iniciarLoopIvy() {
    if (rafIvy || !ivyWrap) return;
    ivyWrap.dataset.estado = estado;
    frameIvy();
  }

  function pararLoopIvy() {
    if (rafIvy) cancelAnimationFrame(rafIvy);
    rafIvy = null;
  }

  // Olhar e cabeça seguem o ponteiro (normalizado -1..1 em relação ao centro do robô)
  modal.addEventListener('pointermove', (e) => {
    if (modoAtual !== 'ivy' || !ivyPalco) return;
    const r = ivyPalco.getBoundingClientRect();
    const nx = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
    const ny = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
    ivy.mx = Math.max(-1, Math.min(1, nx));
    ivy.my = Math.max(-1, Math.min(1, ny));
  });

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
  if (ivyPalco) {
    ivyPalco.addEventListener('click', (e) => {
      if (modoAtual !== 'ivy') return;
      e.stopPropagation();
      toggleFalar();
    });
  }
  if (btnVozRobotica) {
    aplicarVozRobotica();
    btnVozRobotica.addEventListener('click', (e) => {
      e.stopPropagation();
      vozRobotica = !vozRobotica;
      localStorage.setItem(VOZ_KEY, vozRobotica ? 'on' : 'off');
      aplicarVozRobotica();
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
    if (modoAtual === 'ivy') {
      ajustarCanvasIvy();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('show')) fecharModal();
  });
  modal.addEventListener('click', (e) => {
    if (modoAtual === 'nebulosa' || modoAtual === 'jarvis' || modoAtual === 'ivy') return;
    if (e.target === modal) fecharModal();
  });
  if (hasWebTTS) speechSynth.onvoiceschanged = () => {};
})();
