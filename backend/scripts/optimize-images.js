#!/usr/bin/env node
/**
 * Otimiza imagens em frontend/sistema/ gerando .webp + .png redimensionado.
 * Uso:   npm run optimize:images -- "nome original.png" [...]
 *        (o arquivo de entrada fica em frontend/sistema/; os originais antigos
 *         "background 1.png"/"background 2.png" saíram do projeto e estão no histórico do git)
 *
 * Saída, para "background 1.png":
 *   - background-1.webp (qualidade 78)
 *   - background-1.png  (PNG re-comprimido, fallback)
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const PUB = path.join(__dirname, '..', '..', 'frontend', 'sistema');

const INPUTS = process.argv.slice(2);
if (INPUTS.length === 0) {
  console.log('Informe o(s) arquivo(s) de entrada em frontend/sistema/. Ex.: npm run optimize:images -- "fundo novo.png"');
  process.exit(0);
}

const MAX_W = 2000;
const WEBP_Q = 78;

async function processar(nomeRel) {
  const entrada = path.join(PUB, nomeRel);
  if (!fs.existsSync(entrada)) {
    console.log(`  ⚠ skip (não existe): ${nomeRel}`);
    return;
  }

  const base = nomeRel
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, '-')
    .toLowerCase();

  const saidaWebp = path.join(PUB, `${base}.webp`);
  const saidaPng  = path.join(PUB, `${base}.png`);

  const meta = await sharp(entrada).metadata();
  const origKB = (fs.statSync(entrada).size / 1024).toFixed(0);

  // Pipeline base: redimensiona se for muito grande
  const base$ = sharp(entrada).resize({
    width: Math.min(meta.width, MAX_W),
    withoutEnlargement: true
  });

  await base$.clone().webp({ quality: WEBP_Q, effort: 6 }).toFile(saidaWebp);
  await base$.clone().png({ quality: 80, compressionLevel: 9, palette: true }).toFile(saidaPng);

  const webpKB = (fs.statSync(saidaWebp).size / 1024).toFixed(0);
  const pngKB  = (fs.statSync(saidaPng).size / 1024).toFixed(0);

  console.log(`  ✔ ${nomeRel}  (${origKB} KB)`);
  console.log(`     → ${path.basename(saidaWebp)}  ${webpKB} KB`);
  console.log(`     → ${path.basename(saidaPng)}   ${pngKB} KB`);
}

(async () => {
  console.log(`Otimizando ${INPUTS.length} imagem(ns)…\n`);
  for (const nome of INPUTS) {
    try {
      await processar(nome);
    } catch (err) {
      console.error(`  ✗ ${nome}: ${err.message}`);
    }
  }
  console.log('\nPronto.');
})();
