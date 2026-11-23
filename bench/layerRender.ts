/**
 * Renders a layered conversion so the effect can be judged by eye: a
 * photo-dithered background with a hard-edged logo-style region kept crisp, and
 * a third region with a different palette constraint.
 */
import { encodePng } from './png';
import { writeFileSync } from 'node:fs';
import { convert } from '../src/core/convert';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import { createBaseLayer, createLayer, stamp } from '../src/core/layers';
import { SCREEN_H, SCREEN_W } from '../src/core/palette';

const NPX = SCREEN_W * SCREEN_H;

function photo(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  let s = 12345;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      const u = x / SCREEN_W;
      const v = y / SCREEN_H;
      let r = 0.2 + 0.55 * v;
      let g = 0.35 + 0.5 * v;
      let b = 0.75 + 0.2 * v;
      const ds = Math.hypot(u - 0.78, v - 0.18);
      const sun = Math.max(0, 1 - ds * 5.5) ** 2;
      r += sun * 1.2;
      g += sun * 1.05;
      b += sun * 0.5;
      for (const [cxs, cys, rad, col] of [
        [0.32, 0.62, 0.26, [0.85, 0.3, 0.25]],
        [0.66, 0.74, 0.17, [0.3, 0.75, 0.45]],
      ] as [number, number, number, number[]][]) {
        const dx = (u - cxs) * 1.34;
        const dy = v - cys;
        const d = Math.hypot(dx, dy);
        if (d < rad) {
          const nz = Math.sqrt(Math.max(0, 1 - (d / rad) ** 2));
          const shade = Math.max(0.12, 0.35 + 0.75 * (nz * 0.8 - dx * 2.2 - dy * 1.4));
          r = r * (1 - nz) + col[0] * shade * nz * 2.2;
          g = g * (1 - nz) + col[1] * shade * nz * 2.2;
          b = b * (1 - nz) + col[2] * shade * nz * 2.2;
        }
      }
      s = (s * 1664525 + 1013904223) >>> 0;
      const grain = ((s >>> 24) / 255 - 0.5) * 0.14;
      out[i] = Math.max(0, Math.min(255, (r + grain) * 255));
      out[i + 1] = Math.max(0, Math.min(255, (g + grain) * 255));
      out[i + 2] = Math.max(0, Math.min(255, (b + grain) * 255));
    }
  }
  return out;
}

const src = photo();

// Background: photo-ish dithering.
const base = createBaseLayer({ ...DEFAULT_OPTIONS, dither: 'floyd', contrast: 0.08 });
// A crisp, high-contrast bright region: "the logo".
const logo = createLayer(
  'Logo',
  { ...DEFAULT_OPTIONS, dither: 'none', method: 'exhaustive', brightMode: 'bright', contrast: 0.6, singleBias: 0.4, cohesion: 0 },
  new Uint8Array(NPX),
);
stamp(logo.mask!, 70, 60, { radius: 34, value: 1, hardness: 0.9 });
// A separately tuned region with its own palette bias.
const warm = createLayer(
  'Warm',
  { ...DEFAULT_OPTIONS, dither: 'bayer8', temperature: 0.55, saturation: 1.4, contrast: 0.3 },
  new Uint8Array(NPX),
);
stamp(warm.mask!, 200, 130, { radius: 40, value: 1, hardness: 0.7 });

const flat = convert(src, [base], 5);
const layered = convert(src, [base, logo, warm], 5);

console.log(
  `flat:    ΔE ${flat.stats.meanError.toFixed(1)}  attrs ${flat.stats.distinctAttributes}  cells single ${flat.stats.singleColourCells}`,
);
console.log(
  `layered: ΔE ${layered.stats.meanError.toFixed(1)}  attrs ${layered.stats.distinctAttributes}  cells single ${layered.stats.singleColourCells}`,
);
console.log('ownership:', layered.stats.layers.map((l) => `${l.name}=${l.pixels}`).join(' '));

// Side by side, plus the ownership mask.
const tiles = [flat.screen, layered.screen];
const scale = 2;
const gap = 6;
const W = tiles.length * (SCREEN_W * scale) + (tiles.length + 1) * gap;
const H = SCREEN_H * scale + gap * 2;
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 22;
  sheet[i + 1] = 22;
  sheet[i + 2] = 30;
  sheet[i + 3] = 255;
}
tiles.forEach((tile, idx) => {
  const ox = gap + idx * (SCREEN_W * scale + gap);
  for (let y = 0; y < SCREEN_H * scale; y++) {
    for (let x = 0; x < SCREEN_W * scale; x++) {
      const si = (((y / scale) | 0) * SCREEN_W + ((x / scale) | 0)) * 4;
      const di = ((gap + y) * W + ox + x) * 4;
      sheet[di] = tile[si];
      sheet[di + 1] = tile[si + 1];
      sheet[di + 2] = tile[si + 2];
      sheet[di + 3] = 255;
    }
  }
});
writeFileSync('bench/layers.png', encodePng(sheet, W, H));
console.log('wrote bench/layers.png (single layer, then layered)');

