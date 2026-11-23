/**
 * Renders a contact sheet of conversions to bench/out.png so results can be
 * inspected by eye. Run with `npm run render`.
 */
import { encodePng } from './png';
import { writeFileSync } from 'node:fs';
import { convert } from '../src/core/convert';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import { SCREEN_H, SCREEN_W } from '../src/core/palette';
import type { ConvertOptions } from '../src/core/types';

const NPX = SCREEN_W * SCREEN_H;

/** A plausible "photo": shaded spheres, a horizon, fine texture and noise. */
function photoSource(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  let s = 12345;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      const u = x / SCREEN_W;
      const v = y / SCREEN_H;

      // Sky gradient.
      let r = 0.2 + 0.55 * v;
      let g = 0.35 + 0.5 * v;
      let b = 0.75 + 0.2 * v;

      // Sun with a soft halo.
      const dxs = u - 0.78;
      const dys = v - 0.18;
      const ds = Math.sqrt(dxs * dxs + dys * dys);
      const sun = Math.max(0, 1 - ds * 5.5) ** 2;
      r += sun * 1.2;
      g += sun * 1.05;
      b += sun * 0.5;

      // Two spheres shaded with a light from the upper left.
      for (const [cxs, cys, rad, col] of [
        [0.32, 0.62, 0.26, [0.85, 0.3, 0.25]],
        [0.66, 0.74, 0.17, [0.3, 0.75, 0.45]],
      ] as [number, number, number, number[]][]) {
        const dx = (u - cxs) * 1.34;
        const dy = v - cys;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < rad) {
          const nz = Math.sqrt(Math.max(0, 1 - (d / rad) ** 2));
          const shade = Math.max(0.12, 0.35 + 0.75 * (nz * 0.8 - dx * 2.2 - dy * 1.4));
          r = r * (1 - nz) + col[0] * shade * nz * 2.2;
          g = g * (1 - nz) + col[1] * shade * nz * 2.2;
          b = b * (1 - nz) + col[2] * shade * nz * 2.2;
        }
      }

      // Fine high-frequency texture, the thing dithering has to survive.
      s = (s * 1664525 + 1013904223) >>> 0;
      const grain = ((s >>> 24) / 255 - 0.5) * 0.14;
      const stripes = Math.sin(x * 0.9 + y * 0.35) * 0.04;
      r += grain + stripes;
      g += grain + stripes;
      b += grain + stripes;

      out[i] = Math.max(0, Math.min(255, r * 255));
      out[i + 1] = Math.max(0, Math.min(255, g * 255));
      out[i + 2] = Math.max(0, Math.min(255, b * 255));
    }
  }
  return out;
}

interface Variant {
  label: string;
  patch: Partial<ConvertOptions>;
}

const variants: Variant[] = [
  { label: 'default floyd smart', patch: {} },
  { label: 'no prequant', patch: { preQuantize: false } },
  { label: 'atkinson', patch: { preQuantize: false, dither: 'atkinson' } },
  { label: 'bayer8', patch: { preQuantize: false, dither: 'bayer8' } },
  { label: 'none', patch: { preQuantize: false, dither: 'none' } },
  { label: 'exhaustive', patch: { preQuantize: false, method: 'exhaustive' } },
  { label: 'frequency', patch: { preQuantize: false, method: 'frequency' } },
  { label: 'average', patch: { preQuantize: false, method: 'average' } },
  { label: 'cohesion 1', patch: { preQuantize: false, cohesion: 1 } },
  { label: 'bright only', patch: { preQuantize: false, brightMode: 'bright' } },
  { label: 'normal only', patch: { preQuantize: false, brightMode: 'normal' } },
  { label: 'no single cells', patch: { preQuantize: false, allowSingleColour: false } },
  { label: 'jarvis', patch: { preQuantize: false, dither: 'jarvis' } },
  { label: 'stucki', patch: { preQuantize: false, dither: 'stucki' } },
  { label: 'sierra', patch: { preQuantize: false, dither: 'sierra' } },
  { label: 'bw bayer', patch: { preQuantize: false, paletteMask: (1 << 0) | (1 << 7), saturation: 0 } },
];

const source = photoSource();
const tiles: Uint8ClampedArray[] = [];

const fitted = new Uint8ClampedArray(NPX * 4);
for (let i = 0; i < NPX; i++) {
  fitted[i * 4] = source[i * 3];
  fitted[i * 4 + 1] = source[i * 3 + 1];
  fitted[i * 4 + 2] = source[i * 3 + 2];
  fitted[i * 4 + 3] = 255;
}
tiles.push(fitted);

for (const v of variants) {
  const opts = { ...DEFAULT_OPTIONS, ...v.patch };
  const res = convert(source, opts, 7);
  tiles.push(res.screen);
  console.log(
    `${v.label.padEnd(20)} ΔE ${res.stats.meanError.toFixed(1).padStart(5)}  single ${String(
      res.stats.singleColourCells,
    ).padStart(3)}  attrs ${String(res.stats.distinctAttributes).padStart(3)}  ink ${(
      res.stats.inkCoverage * 100
    ).toFixed(0)}%`,
  );
}

// Contact sheet: 4 columns, 2x upscale, 4px gutter.
const cols = 4;
const scale = 1;
const gap = 4;
const rows = Math.ceil(tiles.length / cols);
const sheetW = cols * SCREEN_W + (cols + 1) * gap;
const sheetH = rows * SCREEN_H + (rows + 1) * gap;
const sheet = new Uint8ClampedArray(sheetW * sheetH * 4);
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 24;
  sheet[i + 1] = 24;
  sheet[i + 2] = 34;
  sheet[i + 3] = 255;
}
tiles.forEach((tile, idx) => {
  const cx = idx % cols;
  const cy = (idx / cols) | 0;
  const ox = gap + cx * (SCREEN_W + gap);
  const oy = gap + cy * (SCREEN_H + gap);
  for (let y = 0; y < SCREEN_H * scale; y++) {
    for (let x = 0; x < SCREEN_W * scale; x++) {
      const si = ((y / scale | 0) * SCREEN_W + (x / scale | 0)) * 4;
      const di = ((oy + y) * sheetW + ox + x) * 4;
      sheet[di] = tile[si];
      sheet[di + 1] = tile[si + 1];
      sheet[di + 2] = tile[si + 2];
      sheet[di + 3] = 255;
    }
  }
});

writeFileSync('bench/out.png', encodePng(sheet, sheetW, sheetH));
console.log(`\nwrote bench/out.png (${sheetW}x${sheetH}, order: source then ${variants
  .map((v) => v.label)
  .join(', ')})`);

// ---------------------------------------------------------------- PNG writer

