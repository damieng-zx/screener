/**
 * Writes a few test images (PNG, JPEG-ish via canvas is not available here, so
 * PNG only) into bench/samples for manual testing in the browser.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const W = 512;
const H = 384;

function photo(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  let s = 99;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const u = x / W;
      const v = y / H;
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
        const dx = (u - cxs) * (W / H);
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
      const grain = ((s >>> 24) / 255 - 0.5) * 0.1;
      out[i] = Math.max(0, Math.min(255, (r + grain) * 255));
      out[i + 1] = Math.max(0, Math.min(255, (g + grain) * 255));
      out[i + 2] = Math.max(0, Math.min(255, (b + grain) * 255));
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Flat colour blocks plus text-like stripes: the hard case for attribute clash. */
function blocks(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  const cols = ['#d70000', '#00d700', '#0000d7', '#d7d700', '#ffffff', '#d700d7', '#00d7d7'];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const band = Math.floor((x / W) * cols.length);
      const hex = cols[Math.min(cols.length - 1, band)];
      let r = parseInt(hex.slice(1, 3), 16);
      let g = parseInt(hex.slice(3, 5), 16);
      let b = parseInt(hex.slice(5, 7), 16);
      // A black grid, so every cell contains a third colour on purpose.
      if (x % 64 < 3 || y % 64 < 3) {
        r = g = b = 0;
      }
      if (y > H * 0.6 && (x % 12 < 6)) {
        r = g = b = 255;
      }
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

function encode(pixels: Uint8ClampedArray, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = pixels[y * w * 4 + x];
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync('bench/samples', { recursive: true });
mkdirSync('public/samples', { recursive: true });
for (const [name, pixels] of [
  ['photo', photo()],
  ['blocks', blocks()],
] as [string, Uint8ClampedArray][]) {
  const png = encode(pixels, W, H);
  writeFileSync(`bench/samples/${name}.png`, png);
  writeFileSync(`public/samples/${name}.png`, png);
}
console.log('wrote bench/samples and public/samples: photo.png, blocks.png');
