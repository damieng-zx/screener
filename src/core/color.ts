/**
 * Small numeric helpers and sRGB / linear / OKLab colour conversions.
 *
 * The ZX Spectrum's 15 colours are extremely far apart, so almost any
 * perceptual metric works, but OKLab gives noticeably better cell pair
 * selection than plain RGB distance (fewer muddy browns).
 */

export type RGB = [number, number, number];

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Rec. 709 relative luminance from gamma-encoded sRGB floats. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

const cbrt = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1 / 3);

/** sRGB (0..1) -> OKLab. Writes into out[o..o+2]. */
export function rgbToOklab(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = cbrt(l);
  const m_ = cbrt(m);
  const s_ = cbrt(s);
  out[o] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  out[o + 1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  out[o + 2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
}

/** Cheap deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
