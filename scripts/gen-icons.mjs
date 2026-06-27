// Rasterize the Iris icon masters (build/*.svg) into platform assets.
//
//   build/icon.svg  ->  build/icon.png (512)  +  build/icon.ico (16..256)
//   build/mark.svg  ->  build/preview.png (contact sheet, for review only)
//
// Run: node scripts/gen-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(root, 'build');
const r = (p) => resolve(buildDir, p);

/** Render an SVG file to a PNG buffer at a square pixel size. */
function renderPng(svgPath, size) {
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return resvg.render().asPng();
}

// 1) Windows .ico — the sizes Explorer / taskbar / installer actually pick from.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((s) => renderPng(r('icon.svg'), s));
const ico = await pngToIco(icoPngs);
writeFileSync(r('icon.ico'), ico);

// 2) electron-builder's cross-platform fallback / Linux icon.
writeFileSync(r('icon.png'), renderPng(r('icon.svg'), 512));

// 3) Contact sheet for review (not shipped).
const inner = (file, vb) => {
  const s = readFileSync(r(file), 'utf8');
  let body = s.slice(s.indexOf('>', s.indexOf('<svg')) + 1, s.lastIndexOf('</svg>'));
  body = body.replace(/<!--[\s\S]*?-->/g, ''); // resvg forbids '--' in comments
  return { body, vb };
};
const icon = inner('icon.svg', '0 0 1024 1024');
const mark = inner('mark.svg', '0 0 512 512');
const word = inner('wordmark.svg', '0 0 560 200');
const nest = (g, x, y, w, h) =>
  `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${g.vb}">${g.body}</svg>`;

const W = 940;
const sizes = [128, 64, 48, 32, 24, 16];
const rowMarks = (g, y, gap = 24) => {
  let x = 250;
  const out = [];
  for (const s of sizes) {
    out.push(nest(g, x, y + (128 - s) / 2, s, s));
    out.push(`<text x="${x + s / 2}" y="${y + 150}" fill="#908caa" font-size="13" font-family="Segoe UI,sans-serif" text-anchor="middle">${s}px</text>`);
    x += s + gap + 26;
  }
  return out.join('\n');
};

const sheet = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 720" font-family="Segoe UI,sans-serif">
  <rect width="${W}" height="720" fill="#191724"/>
  <text x="40" y="56" fill="#e0def4" font-size="26" font-weight="600">Iris — icon system</text>
  <text x="40" y="82" fill="#6e6a86" font-size="14">aperture-bloom · Rosé Pine palette</text>

  <!-- hero tile on dark -->
  ${nest(icon, 40, 120, 180, 180)}
  <text x="130" y="324" fill="#908caa" font-size="13" text-anchor="middle">app icon</text>

  <!-- mark on dark, descending sizes -->
  <text x="250" y="112" fill="#6e6a86" font-size="13">mark on base #191724</text>
  ${rowMarks(mark, 120)}

  <!-- mark on light -->
  <rect x="40" y="330" width="${W - 80}" height="180" rx="16" fill="#faf4ed"/>
  <text x="250" y="358" fill="#797593" font-size="13">mark on dawn #faf4ed</text>
  ${rowMarks(mark, 360)}
  ${nest(icon, 70, 360, 140, 140)}

  <!-- wordmark lockups -->
  <text x="40" y="560" fill="#6e6a86" font-size="13">wordmark</text>
  ${nest(word, 40, 575, 392, 140)}
  <rect x="470" y="575" width="430" height="120" rx="12" fill="#faf4ed"/>
  ${nest(word, 500, 585, 364, 130)}
</svg>`;

writeFileSync(r('preview.png'), new Resvg(sheet, { fitTo: { mode: 'width', value: W * 2 } }).render().asPng());

console.log('wrote build/icon.ico, build/icon.png, build/preview.png');
