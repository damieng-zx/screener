/**
 * Renders the white/black vignette across its range so the gradient can be
 * inspected by eye, and asserts the neutral centre is exactly a no-op.
 */
import { encodePng } from './png';
import { writeFileSync } from 'node:fs';
import { adjustPixels } from '../src/core/adjust';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import { SCREEN_H, SCREEN_W } from '../src/core/palette';

const NPX = SCREEN_W * SCREEN_H;

/** Mid-grey plus a few colour patches, so any tint shows up. */
function source(): Float32Array {
  const rgb = new Float32Array(NPX * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      const band = Math.floor(x / 32) % 4;
      const v = 0.45;
      rgb[i] = band === 0 ? v : band === 1 ? 0.85 : band === 2 ? 0.15 : v;
      rgb[i + 1] = band === 0 ? v : band === 1 ? 0.3 : band === 2 ? 0.15 : 0.75;
      rgb[i + 2] = band === 0 ? v : band === 1 ? 0.25 : band === 2 ? 0.15 : 0.2;
    }
  }
  return rgb;
}

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

// The tone curve runs through a 1024-entry LUT, so even a neutral pipeline
// does not return the exact input value. Every assertion therefore compares
// against a baseline render with the vignette switched off.
const baseline = (size: number) => {
  const flat = new Float32Array(NPX * 3);
  flat.fill(0.45);
  adjustPixels(flat, { ...DEFAULT_OPTIONS, sharpen: 0, contrast: 0, saturation: 1, vibrance: 0, vignette: 0, vignetteSize: size });
  return flat;
};

// Neutral centre must be bit-identical to no vignette at all.
{
  const a = source();
  const b = source();
  adjustPixels(a, { ...DEFAULT_OPTIONS });
  adjustPixels(b, { ...DEFAULT_OPTIONS, vignette: 0 });
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  check(diff === 0, `vignette 0 changed ${diff} channels`);
}

// Positive: corners go white, centre untouched.
{
  const rgb = source();
  adjustPixels(rgb, {
    ...DEFAULT_OPTIONS,
    sharpen: 0,
    contrast: 0,
    saturation: 1,
    vibrance: 0,
    vignette: 1,
    vignetteSize: 1,
  });
  const at = (x: number, y: number) => {
    const i = (y * SCREEN_W + x) * 3;
    return [rgb[i], rgb[i + 1], rgb[i + 2]];
  };
  const corner = at(0, 0);
  const mid = at(128, 96);
  check(corner.every((v) => v > 0.99), `corner not white: ${corner.map((v) => v.toFixed(3))}`);
  check(mid.every((v) => v > 0.05 && v < 0.95), `centre was altered: ${mid.map((v) => v.toFixed(3))}`);
}

// Negative darkens the same circle instead of brightening it.
{
  const rgb = source();
  adjustPixels(rgb, {
    ...DEFAULT_OPTIONS,
    sharpen: 0,
    contrast: 0,
    saturation: 1,
    vibrance: 0,
    vignette: -1,
    vignetteSize: 1,
  });
  const at = (x: number, y: number) => {
    const i = (y * SCREEN_W + x) * 3;
    return [rgb[i], rgb[i + 1], rgb[i + 2]];
  };
  check(at(0, 0).every((v) => v < 0.01), 'negative vignette should blacken the corners');
  check(at(SCREEN_W - 1, 0).every((v) => v < 0.01), 'negative vignette should blacken all corners');
  check(at(128, 96).every((v) => v > 0.05 && v < 0.95), 'negative vignette must not touch the centre');
}

// Small densities must stay gentle, not collapse into a hard-edged ring. This
// is the bug that made 0.1 look like a solid border.
{
  const flat = new Float32Array(NPX * 3);
  flat.fill(0.45);
  adjustPixels(flat, { ...DEFAULT_OPTIONS, sharpen: 0, contrast: 0, saturation: 1, vibrance: 0, vignette: -0.1, vignetteSize: 0.5 });
  const lum = (x: number, y: number) => flat[(y * SCREEN_W + x) * 3 + 1];
  const centre = lum(128, 96);
  const corner = lum(0, 0);
  const delta = centre - corner;
  check(delta > 0.002 && delta < 0.08, `weak vignette should be subtle, corner drop was ${delta.toFixed(3)}`);
}

// Size changes the reach: at a fixed density a bigger vignette darkens more of
// the frame, i.e. a point halfway out is affected only for larger sizes.
{
  const render = (size: number) => {
    const flat = new Float32Array(NPX * 3);
    flat.fill(0.45);
    adjustPixels(flat, { ...DEFAULT_OPTIONS, sharpen: 0, contrast: 0, saturation: 1, vibrance: 0, vignette: -1, vignetteSize: size });
    return flat;
  };
  const small = render(0.1);
  const big = render(1);
  // A point about a third of the way out is inside the clean zone at size
  // 0.1 and already tinted at size 1.
  const px = (arr: Float32Array) => arr[(96 * SCREEN_W + (128 - 55)) * 3 + 1];
  const base = px(baseline(0.1));
  check(px(small) > px(big), 'larger vignette size should reach further in');
  check(px(small) === base, 'small vignette should leave the inner frame untouched');
}

// Radial symmetry and monotonic falloff from the centre outwards.
{
  const flat = new Float32Array(NPX * 3);
  flat.fill(0.45);
  adjustPixels(flat, { ...DEFAULT_OPTIONS, sharpen: 0, contrast: 0, saturation: 1, vibrance: 0, vignette: -0.6, vignetteSize: 0.5 });
  const lum = (x: number, y: number) => flat[(y * SCREEN_W + x) * 3 + 1];
  // Equal radius means equal value, in every direction.
  check(
    Math.abs(lum(128 - 40, 96) - lum(128, 96 - 40)) < 1e-5,
    'vignette is not radially symmetric',
  );
  // Darker (for a negative vignette) as radius grows.
  check(lum(0, 96) < lum(40, 96), 'edge should be darker than the mid-radius');
  check(lum(40, 96) < lum(120, 96), 'mid-radius should be darker than near-centre');
  const centreBase = baseline(0.5)[(96 * SCREEN_W + 128) * 3 + 1];
  check(lum(128, 96) === centreBase, 'centre pixel must be untouched');
}

// Constancy across rows: no vertical banding either.
{
  const flat = new Float32Array(NPX * 3);
  flat.fill(0.45);
  adjustPixels(flat, { ...DEFAULT_OPTIONS, sharpen: 0, contrast: 0, saturation: 1, vibrance: 0, vignette: -0.6, vignetteSize: 0.5 });
  // Walk inward from the corner to the centre along one diagonal. A black
  // vignette must brighten monotonically the whole way in.
  const lum = (x: number, y: number) => flat[(y * SCREEN_W + x) * 3 + 1];
  let prev = -1;
  let breaks = 0;
  for (let k = 0; k <= 100; k++) {
    const t = k / 100;
    const v = lum(Math.round(127 * t), Math.round(95 * t));
    if (v < prev - 1e-4) breaks++;
    prev = v;
  }
  check(breaks === 0, `brightness not monotonic toward the centre, ${breaks} reversals`);
}

// Contact sheet across density at full size, then density at the smallest size.
const cases: [number, number][] = [
  [-1, 1],
  [-0.35, 1],
  [0, 1],
  [0.35, 1],
  [1, 1],
  [-1, 0.1],
  [-1, 0.5],
];
const tiles: Uint8ClampedArray[] = cases.map(([vignette, vignetteSize]) => {
  const rgb = source();
  adjustPixels(rgb, { ...DEFAULT_OPTIONS, sharpen: 0, vignette, vignetteSize });
  const out = new Uint8ClampedArray(NPX * 4);
  for (let i = 0; i < NPX; i++) {
    out[i * 4] = Math.round(rgb[i * 3] * 255);
    out[i * 4 + 1] = Math.round(rgb[i * 3 + 1] * 255);
    out[i * 4 + 2] = Math.round(rgb[i * 3 + 2] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
});

const scale = 2;
const gap = 6;
const W = SCREEN_W * scale + gap * 2;
const H = tiles.length * (SCREEN_H * scale + gap) + gap;
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 22;
  sheet[i + 1] = 22;
  sheet[i + 2] = 30;
  sheet[i + 3] = 255;
}
tiles.forEach((tile, idx) => {
  const oy = gap + idx * (SCREEN_H * scale + gap);
  for (let y = 0; y < SCREEN_H * scale; y++) {
    for (let x = 0; x < SCREEN_W * scale; x++) {
      const si = (((y / scale) | 0) * SCREEN_W + ((x / scale) | 0)) * 4;
      const di = ((oy + y) * W + gap + x) * 4;
      sheet[di] = tile[si];
      sheet[di + 1] = tile[si + 1];
      sheet[di + 2] = tile[si + 2];
      sheet[di + 3] = 255;
    }
  }
});
writeFileSync('bench/vignette.png', encodePng(sheet, W, H));
console.log(`wrote bench/vignette.png (density/size: ${cases.map(([a, b]) => `${a}/${b}`).join(', ')})`);

if (failures.length) {
  console.error('Vignette checks failed:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log('Vignette checks passed.');

