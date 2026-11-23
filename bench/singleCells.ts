/**
 * Before/after for the "single-colour cells off" repair. A flat source makes the
 * artefact obvious: one lonely pixel per cell instead of a dither patch.
 */
import { encodePng } from './png';
import { writeFileSync } from 'node:fs';
import { convert } from '../src/core/convert';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import { SCREEN_H, SCREEN_W } from '../src/core/palette';

const NPX = SCREEN_W * SCREEN_H;

/** Flat mid-tone, the case that produces single-colour cells everywhere. */
function flat(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  for (let i = 0; i < NPX; i++) {
    out[i * 3] = 96;
    out[i * 3 + 1] = 148;
    out[i * 3 + 2] = 110;
  }
  return out;
}

const src = flat();

// Dithering that converges to a solid colour, then the two-colour repair.
const solid = convert(src, { ...DEFAULT_OPTIONS, dither: 'floyd', preQuantize: false, allowSingleColour: true }, 1);
const repaired = convert(src, { ...DEFAULT_OPTIONS, dither: 'floyd', preQuantize: false, allowSingleColour: false }, 1);

console.log(`single cells: on=${solid.stats.singleColourCells} off=${repaired.stats.singleColourCells}`);
console.log(`distinct attrs: on=${solid.stats.distinctAttributes} off=${repaired.stats.distinctAttributes}`);

// Count how many cells hold an isolated pixel: a pixel whose four neighbours are
// all the other colour. That is exactly the artefact.
function lonelyPixels(r: ReturnType<typeof convert>): number {
  let lonely = 0;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const p = r.pixelIdx[y * SCREEN_W + x];
      const same = (dx: number, dy: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= SCREEN_W || ny >= SCREEN_H) return false;
        return r.pixelIdx[ny * SCREEN_W + nx] === p;
      };
      if (!same(-1, 0) && !same(1, 0) && !same(0, -1) && !same(0, 1)) lonely++;
    }
  }
  return lonely;
}

console.log(`isolated pixels: solid=${lonelyPixels(solid)} repaired=${lonelyPixels(repaired)}`);

// Zoomed crop of one cell, for eyeballing.
const tiles = [crop(solid), crop(repaired)];
const cell = 32;
const scale = 8;
const gap = 8;
const W = tiles.length * (cell * scale) + (tiles.length + 1) * gap;
const H = cell * scale + gap * 2;
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 22;
  sheet[i + 1] = 22;
  sheet[i + 2] = 30;
  sheet[i + 3] = 255;
}
tiles.forEach((tile, idx) => {
  const ox = gap + idx * (cell * scale + gap);
  for (let y = 0; y < cell * scale; y++) {
    for (let x = 0; x < cell * scale; x++) {
      const si = (((y / scale) | 0) * cell + ((x / scale) | 0)) * 4;
      const di = ((gap + y) * W + ox + x) * 4;
      sheet[di] = tile[si];
      sheet[di + 1] = tile[si + 1];
      sheet[di + 2] = tile[si + 2];
      sheet[di + 3] = 255;
    }
  }
});
writeFileSync('bench/single-cells.png', encodePng(sheet, W, H));
console.log('wrote bench/single-cells.png (single-colour cells allowed, then disallowed)');

function crop(r: ReturnType<typeof convert>): Uint8ClampedArray {
  const cell = 32;
  const out = new Uint8ClampedArray(cell * cell * 4);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const si = (y * SCREEN_W + x) * 4;
      const di = (y * cell + x) * 4;
      out[di] = r.screen[si];
      out[di + 1] = r.screen[si + 1];
      out[di + 2] = r.screen[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

