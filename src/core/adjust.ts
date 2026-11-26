import { clamp, clamp01, linearToSrgb, srgbToLinear } from './color';
import type { ConvertOptions } from './types';

/**
 * The tone / colour adjustment pipeline.
 *
 * Everything is done on a Float32Array of gamma-encoded sRGB values in 0..1,
 * 3 floats per pixel, 256*192 pixels. Order matters: exposure and black/white
 * point are linear-light operations, contrast and gamma are gamma-space
 * (that's what "looks right" in every photo editor), and chroma comes last so
 * the tone curve does not fight with saturation.
 */
export function adjustPixels(rgb: Float32Array, opts: ConvertOptions): void {
  toneCurve(rgb, opts);
  chroma(rgb, opts);
  // The vignette is a lighting gradient, so it goes on after the tonal work but
  // before the detail pass, where it shapes the range that posterise/binarise
  // then quantise.
  if (opts.vignette !== 0) vignette(rgb, opts.vignette, opts.vignetteSize);
  // Denoise before sharpening, or the two fight each other: blurring after an
  // unsharp mask just puts the halos back.
  if (opts.blur > 0) gaussianBlur(rgb, opts.blur);
  if (opts.sharpen > 0) sharpen(rgb, opts.sharpen);
  if (opts.posterize > 1) posterize(rgb, opts.posterize);
  if (opts.binarize) binarise(rgb, opts.threshold);
}

const LUT_SIZE = 1024;

function toneCurve(rgb: Float32Array, o: ConvertOptions): void {
  const gain = Math.pow(2, o.exposure);
  const lo = o.blackPoint;
  const hi = Math.max(o.blackPoint + 1e-4, o.whitePoint);
  const pivot = 0.5;
  const contrast = 1 + o.contrast;
  const invGamma = 1 / Math.max(0.05, o.gamma);

  const lut = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = i / (LUT_SIZE - 1);
    // Exposure in linear light.
    let lin = srgbToLinear(v) * gain;
    lin = clamp01(lin);
    lin = (lin - srgbToLinear(lo)) / (srgbToLinear(hi) - srgbToLinear(lo));
    let s = linearToSrgb(clamp01(lin));
    // Brightness is a gentle gamma-space offset.
    s = clamp01(s + o.brightness);
    // Contrast around a mid-grey pivot.
    s = clamp01((s - pivot) * contrast + pivot);
    // Gamma / midtone.
    s = Math.pow(clamp01(s), invGamma);

    lut[i] = s;
  }

  const scale = LUT_SIZE - 1;
  for (let i = 0; i < rgb.length; i++) {
    const v = clamp01(rgb[i]);
    rgb[i] = lut[Math.round(v * scale)];
  }
}

function chroma(rgb: Float32Array, o: ConvertOptions): void {
  const sat = o.saturation;
  const vib = o.vibrance;
  const hue = (o.hue * Math.PI) / 180;
  const temp = o.temperature;
  const tint = o.tint;

  const cosH = Math.cos(hue);
  const sinH = Math.sin(hue);

  for (let i = 0; i < rgb.length; i += 3) {
    let r = rgb[i];
    let g = rgb[i + 1];
    let b = rgb[i + 2];

    // White balance: scale the channels, red vs blue for temperature,
    // green vs magenta for tint.
    if (temp !== 0 || tint !== 0) {
      r *= 1 + temp * 0.35;
      b *= 1 - temp * 0.35;
      g *= 1 + tint * 0.25;
      r *= 1 - tint * 0.05;
      b *= 1 - tint * 0.05;
      r = clamp01(r);
      g = clamp01(g);
      b = clamp01(b);
    }

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Vibrance: saturate muted pixels more than already-vivid ones.
    if (vib !== 0) {
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const curSat = mx <= 0 ? 0 : (mx - mn) / mx;
      const amount = vib * (1 - curSat);
      r = luma + (r - luma) * (1 + amount);
      g = luma + (g - luma) * (1 + amount);
      b = luma + (b - luma) * (1 + amount);
    }

    if (sat !== 1) {
      r = luma + (r - luma) * sat;
      g = luma + (g - luma) * sat;
      b = luma + (b - luma) * sat;
    }

    if (hue !== 0) {
      // YIQ-ish hue rotation, cheap and good enough for chunky palettes.
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const iq = yiq(r, g, b);
      const ii = iq[0] * cosH - iq[1] * sinH;
      const qq = iq[0] * sinH + iq[1] * cosH;
      r = y + 0.956 * ii + 0.621 * qq;
      g = y - 0.272 * ii - 0.647 * qq;
      b = y - 1.106 * ii + 1.703 * qq;
    }

    rgb[i] = clamp01(r);
    rgb[i + 1] = clamp01(g);
    rgb[i + 2] = clamp01(b);
  }
}

function yiq(r: number, g: number, b: number): [number, number] {
  return [0.596 * r - 0.274 * g - 0.322 * b, 0.211 * r - 0.523 * g + 0.312 * b];
}

/**
 * Radial white/black vignette, split into two independent controls:
 *
 * - `amount` is the density/direction: 0 is no effect, negative darkens the
 *   ring towards black and positive brightens it towards white. Magnitude is
 *   how opaque the tint becomes at the edge.
 * - `size` is how far the effect reaches in from the frame edge, 0..1. 0 is a
 *   thin border at the corners, 1 fades right from the centre.
 *
 * Splitting them is deliberate: one slider cannot express "a big soft darken"
 * and "a thin hard border" at once, and tying fade width to density makes
 * small densities collapse into a hard-edged ring.
 */
function vignette(rgb: Float32Array, amount: number, size: number): void {
  const w = 256;
  const h = 192;
  const a = clamp(amount, -1, 1);
  const strength = Math.abs(a);
  if (strength < 1e-4) return;

  const s = clamp(size, 0, 1);
  const cx = w / 2;
  const cy = h / 2;
  // One radius for both axes: the frame is 4:3 with square pixels, so a single
  // pixel-space distance keeps the contour a circle on screen rather than an
  // ellipse. Normalised so the corner is 1.
  const halfDiag = Math.hypot(cx, cy);
  // At size 1 the fade starts at the centre; at 0 it is only the outer sliver.
  const inner = (1 - s) * 0.98;
  const span = Math.max(1e-3, 1 - inner);
  const toWhite = a > 0;

  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const r = Math.sqrt(dx * dx + dy2) / halfDiag;
      if (r <= inner) continue;
      const u = Math.min(1, (r - inner) / span);
      // Smoothstep keeps the ring free of a visible seam at its inner edge,
      // and keeps the centre pixel exactly untouched at u = 0.
      const t = u * u * (3 - 2 * u) * strength;
      const i = (y * w + x) * 3;
      if (toWhite) {
        rgb[i] += (1 - rgb[i]) * t;
        rgb[i + 1] += (1 - rgb[i + 1]) * t;
        rgb[i + 2] += (1 - rgb[i + 2]) * t;
      } else {
        const k = 1 - t;
        rgb[i] *= k;
        rgb[i + 1] *= k;
        rgb[i + 2] *= k;
      }
    }
  }
}

/**
 * Unsharp mask.
 *
 * `amount` is 0..8 on the slider. The multiplier is calibrated so that the
 * default (0.4) is a subtle edge lift and the top of the range is emphatic,
 * rather than the near-no-op a flat x1.6 scale gave (at 0.4 it changed the edge
 * gradient by 10%, which read as "sharpen does nothing").
 *
 * The radius grows slightly with amount too: a stronger sharpen needs a wider
 * mask or it only ever produces thin halos.
 */
function sharpen(rgb: Float32Array, amount: number): void {
  const a = Math.max(0, amount);
  if (a < 0.01) return;
  const radius = 1.1 + Math.min(2.4, a * 0.35);
  const gain = 0.9 + a * 1.9;

  const blurred = new Float32Array(rgb.length);
  blurred.set(rgb);
  gaussianBlur(blurred, radius);

  for (let i = 0; i < rgb.length; i++) {
    rgb[i] = clamp01(rgb[i] + (rgb[i] - blurred[i]) * gain);
  }
}

/** Separable gaussian blur, sigma in pixels. */
export function gaussianBlur(rgb: Float32Array, sigma: number): void {
  if (sigma <= 0.01) return;
  const w = 256;
  const h = 192;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(rgb.length);
  // horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const i = (y * w + xx) * 3;
        const kv = kernel[k + radius];
        r += rgb[i] * kv;
        g += rgb[i + 1] * kv;
        b += rgb[i + 2] * kv;
      }
      const o = (y * w + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const i = (yy * w + x) * 3;
        const kv = kernel[k + radius];
        r += tmp[i] * kv;
        g += tmp[i + 1] * kv;
        b += tmp[i + 2] * kv;
      }
      const o = (y * w + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
}

function posterize(rgb: Float32Array, levels: number): void {
  const n = Math.max(2, Math.round(levels)) - 1;
  for (let i = 0; i < rgb.length; i++) {
    rgb[i] = Math.round(rgb[i] * n) / n;
  }
}

function binarise(rgb: Float32Array, threshold: number): void {
  const t = clamp(threshold, 0, 1);
  for (let i = 0; i < rgb.length; i += 3) {
    const l = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
    const v = l >= t ? 1 : 0;
    rgb[i] = v;
    rgb[i + 1] = v;
    rgb[i + 2] = v;
  }
}
