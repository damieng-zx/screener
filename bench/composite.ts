/**
 * Visual check for attribute/bitmap compositing: shows that borrowing the
 * attribute really does recolour one layer's dither pattern with another
 * layer's palette.
 */
import { encodePng } from './png';
import { writeFileSync } from 'node:fs';
import { convert } from '../src/core/convert';
import { createLayer, fillMask, type Layer } from '../src/core/layers';
import { PALETTE, SCREEN_H, SCREEN_W } from '../src/core/palette';

const NPX = SCREEN_W * SCREEN_H;

/** Big smooth blocks, so the pair choice is obvious per region. */
function source(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      const ramp = x / SCREEN_W;
      const band = Math.floor(y / 32) % 3;
      // Three colour families with a left-to-right ramp.
      out[i] = band === 0 ? 40 + ramp * 200 : band === 1 ? 200 - ramp * 150 : 60 + ramp * 80;
      out[i + 1] = band === 0 ? 60 + ramp * 60 : band === 1 ? 180 : 90 + ramp * 140;
      out[i + 2] = band === 0 ? 180 : band === 1 ? 40 : 200 - ramp * 120;
    }
  }
  return out;
}

const src = source();

const grey = createLayer(
  'Grey',
  { dither: 'none', method: 'exhaustive', saturation: 0, contrast: 0.35, cohesion: 0 },
  fillMask(1),
);
const vivid = createLayer(
  'Vivid',
  { dither: 'floyd', saturation: 1.7, temperature: 0.3, cohesion: 0 },
  fillMask(1),
);

const own = convert(src, [grey, vivid], 3);

const borrowAttrs: Layer = { ...vivid, blend: 'attributes', blendWith: grey.id };
const attrs = convert(src, [grey, borrowAttrs], 3);

const borrowBitmap: Layer = { ...vivid, blend: 'bitmap', blendWith: grey.id };
const bitmap = convert(src, [grey, borrowBitmap], 3);

const colours = (r: ReturnType<typeof convert>) => {
  const s = new Set<number>();
  for (const v of r.pixelIdx) s.add(v);
  return [...s].map((i) => PALETTE[i].hex).join(' ');
};

console.log('own pixels      :', colours(own));
console.log('attrs from Grey :', colours(attrs));
console.log('pixels from Grey:', colours(bitmap));
console.log(
  'mean area brightness  own',
  Math.round(areaMean(own)),
  '| borrowed attrs',
  Math.round(areaMean(attrs)),
);

/** Coverage of each colour, to compare the dither pattern between runs. */
function areaMean(r: ReturnType<typeof convert>): number {
  let sum = 0;
  for (let i = 0; i < NPX; i++) {
    const p = PALETTE[r.pixelIdx[i]];
    sum += 0.2126 * p.rgb[0] + 0.7152 * p.rgb[1] + 0.0722 * p.rgb[2];
  }
  return sum / NPX;
}

const tiles = [own.screen, attrs.screen, bitmap.screen];
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
writeFileSync('bench/composite.png', encodePng(sheet, W, H));
console.log('wrote bench/composite.png (own, attrs from Grey, pixels from Grey)');

