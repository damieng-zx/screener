/**
 * End-to-end check on a real image file: decode PNG, run the same code path as
 * the browser (fit -> convert -> .scr), then report and optionally write a
 * result PNG. Uses bench/samples images, so it needs `npm run samples` first.
 */
import { encodePng } from './png';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { convert } from '../src/core/convert';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import { fitToScreen } from '../src/core/image';
import { SCREEN_H, SCREEN_W } from '../src/core/palette';
import { toScr } from '../src/core/export';

function decodePng(buf: Buffer): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const chunks: { type: string; data: Buffer }[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colourType = ihdr[9];
  if (depth !== 8 || colourType !== 6) throw new Error('only 8-bit RGBA PNG is supported by this harness');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  const stride = width * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      const v = line[x];
      switch (filter) {
        case 0:
          cur[x] = v;
          break;
        case 1:
          cur[x] = (v + a) & 0xff;
          break;
        case 2:
          cur[x] = (v + b) & 0xff;
          break;
        case 3:
          cur[x] = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (v + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown filter ${filter}`);
      }
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { width, height, data: out };
}

const name = process.argv[2] ?? 'photo';
const path = `bench/samples/${name}.png`;
const img = decodePng(readFileSync(path));

const rgba = fitToScreen(img, { fit: 'fit', zoom: 1, offsetX: 0, offsetY: 0, background: [0, 0, 0], smooth: 1 });
const rgb = new Uint8Array(SCREEN_W * SCREEN_H * 3);
for (let i = 0, j = 0; i < SCREEN_W * SCREEN_H; i++, j += 4) {
  rgb[i * 3] = rgba[j];
  rgb[i * 3 + 1] = rgba[j + 1];
  rgb[i * 3 + 2] = rgba[j + 2];
}

const variants: [string, Partial<typeof DEFAULT_OPTIONS>][] = [
  ['floyd', {}],
  ['atkinson', { dither: 'atkinson' }],
  ['bayer8', { dither: 'bayer8' }],
  ['exhaustive', { method: 'exhaustive' }],
];
const tiles: Uint8ClampedArray[] = [];
for (const [label, patch] of variants) {
  const t0 = performance.now();
  const res = convert(rgb, { ...DEFAULT_OPTIONS, ...patch }, 3);
  const ms = performance.now() - t0;
  const scr = toScr(res);
  tiles.push(res.screen);
  console.log(
    `${label.padEnd(12)} ${ms.toFixed(1).padStart(6)} ms  ΔE ${res.stats.meanError
      .toFixed(1)
      .padStart(5)}  attrs ${String(res.stats.distinctAttributes).padStart(3)}  single ${String(
      res.stats.singleColourCells,
    ).padStart(3)}  scr ${scr.length} B`,
  );
}

// 2x sheet, 6px gutter, source first.
const scale = 2;
const gap = 6;
const cols = 3;
const all = [srcTile(img), ...tiles];
const rows = Math.ceil(all.length / cols);
const W = cols * (SCREEN_W * scale + gap) + gap;
const H = rows * (SCREEN_H * scale + gap) + gap;
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 22;
  sheet[i + 1] = 22;
  sheet[i + 2] = 30;
  sheet[i + 3] = 255;
}
all.forEach((tile, idx) => {
  const cx = idx % cols;
  const cy = (idx / cols) | 0;
  const ox = gap + cx * (SCREEN_W * scale + gap);
  const oy = gap + cy * (SCREEN_H * scale + gap);
  for (let y = 0; y < SCREEN_H * scale; y++) {
    for (let x = 0; x < SCREEN_W * scale; x++) {
      const si = (((y / scale) | 0) * SCREEN_W + ((x / scale) | 0)) * 4;
      const di = ((oy + y) * W + ox + x) * 4;
      sheet[di] = tile[si];
      sheet[di + 1] = tile[si + 1];
      sheet[di + 2] = tile[si + 2];
      sheet[di + 3] = 255;
    }
  }
});
writeFileSync(`bench/${name}-out.png`, encodePng(sheet, W, H));
console.log(`wrote bench/${name}-out.png`);

function srcTile(img: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }): Uint8ClampedArray<ArrayBuffer> {
  const rgba = fitToScreen(img, { fit: 'fit', zoom: 1, offsetX: 0, offsetY: 0, background: [0, 0, 0], smooth: 1 });
  const out = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
  out.set(rgba);
  return out;
}

