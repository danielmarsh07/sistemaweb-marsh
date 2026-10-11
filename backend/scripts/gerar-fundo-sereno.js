#!/usr/bin/env node
/**
 * Gera os fundos do tema Marsh Sereno (claro e escuro) em SVG:
 * degradê azul-céu + "fitas" de linhas finas torcidas (inspirado no fundo do tema Telemedicina do NewTelemed).
 * Uso: node backend/scripts/gerar-fundo-sereno.js   → frontend/sistema/bg-sereno.svg e bg-sereno-escuro.svg
 */
const fs = require('fs');
const path = require('path');

const W = 1600, H = 1100;
const r1 = n => Math.round(n * 10) / 10;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpP = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];

// Uma fita = N curvas cúbicas interpoladas entre a borda A e a borda B; o "twist" curva o meio
// de cada linha para fora, dando a sensação de superfície 3D torcida.
function fita({ A, B, n, twist, peso }) {
  const linhas = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const e = t * t * (3 - 2 * t); // concentra linhas nas bordas (como a referência)
    const torcao = Math.sin(Math.PI * t) * twist;
    const p = A.map((pa, k) => {
      const [x, y] = lerpP(pa, B[k], e);
      const meio = k === 1 || k === 2 ? torcao : 0;
      return [r1(x + meio * 0.6), r1(y - meio)];
    });
    linhas.push(`M${p[0]} C${p[1]} ${p[2]} ${p[3]}`);
  }
  return `<path d="${linhas.join(' ')}" fill="none" stroke-width="${peso}"/>`;
}

// Leque: todas as linhas nascem perto de um ponto (o "redemoinho" no alto), dão a volta pela
// esquerda e se abrem em arcos largos até a borda direita/inferior.
function leque({ origem, c1, c2, fim, n, peso }) {
  const linhas = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p0 = lerpP(origem[0], origem[1], t);
    const p1 = lerpP(c1[0], c1[1], t);
    const p2 = lerpP(c2[0], c2[1], t);
    // fim com 3 pontos = contorna o canto, para todas as linhas saírem pela borda da tela
    const p3 = fim.length === 3 ? lerpP(lerpP(fim[0], fim[1], t), lerpP(fim[1], fim[2], t), t) : lerpP(fim[0], fim[1], t);
    linhas.push(`M${p0.map(r1)} C${p1.map(r1)} ${p2.map(r1)} ${p3.map(r1)}`);
  }
  return `<path d="${linhas.join(' ')}" fill="none" stroke-width="${peso}"/>`;
}

function svg({ fundo, linha, opacidadeFita, opacidadeFina, brilho }) {
  // Fita principal: do redemoinho no alto, volta pela esquerda e abre em leque até embaixo à direita
  const principal = leque({
    origem: [[700, -40], [790, 0]],
    c1: [[-80, 120], [420, 380]],
    c2: [[60, 820], [1300, 560]],
    fim: [[620, 1240], [1840, 1240], [1760, 60]],
    n: 58, peso: 0.9
  });
  // Segunda camada mais curta e fechada no topo (dá o efeito de dobra/torção)
  const espiral = leque({
    origem: [[700, -40], [740, -20]],
    c1: [[420, 10], [520, 230]],
    c2: [[160, 210], [700, 340]],
    fim: [[-60, 330], [1060, 380]],
    n: 40, peso: 0.7
  });
  // Arcos cruzados na borda direita (o efeito de malha da referência)
  const malha = fita({
    A: [[1060, 1130], [1240, 920], [1480, 640], [1610, 280]],
    B: [[880, 1140], [1140, 990], [1460, 780], [1640, 430]],
    n: 22, twist: 26, peso: 0.7
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      ${fundo.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('\n      ')}
    </linearGradient>
    <radialGradient id="luz" cx="0.32" cy="0.42" r="0.55">
      <stop offset="0" stop-color="${brilho}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${brilho}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="${H}" fill="url(#luz)"/>
  <g stroke="${linha}" stroke-linecap="round">
    <g stroke-opacity="${opacidadeFita}">${principal}</g>
    <g stroke-opacity="${opacidadeFita}">${espiral}</g>
    <g stroke-opacity="${opacidadeFina}">${malha}</g>
  </g>
</svg>
`;
}

const destino = path.join(__dirname, '..', '..', 'frontend', 'sistema');

// Claro: azul-céu (as cores do menu Sereno) indo para um azul mais fechado, linhas no azul da marca
const claro = svg({
  fundo: [[0, '#b9dcf5'], [0.4, '#d6eafa'], [1, '#9fc3ec']],
  linha: '#1d6fd8', opacidadeFita: 0.30, opacidadeFina: 0.24, brilho: '#e8f3fd'
});
// Escuro: marinho do Sereno Escuro com linhas no azul claro, discretas
const escuro = svg({
  fundo: [[0, '#10264a'], [0.45, '#0b1730'], [1, '#0d2244']],
  linha: '#4f9cf0', opacidadeFita: 0.20, opacidadeFina: 0.15, brilho: '#163a6e'
});

fs.writeFileSync(path.join(destino, 'bg-sereno.svg'), claro);
fs.writeFileSync(path.join(destino, 'bg-sereno-escuro.svg'), escuro);
console.log(`ok: bg-sereno.svg (${claro.length} bytes), bg-sereno-escuro.svg (${escuro.length} bytes)`);
