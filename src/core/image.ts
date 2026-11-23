import { clamp } from './color';
import { SCREEN_H, SCREEN_W } from './palette';

export type FitMode = 'fit' | 'fill' | 'stretch';

export interface SourceOptions {
  fit: FitMode;
  zoom: number;
  /**
   * Pan as a fraction of the zoomed image size, -1..1 from the centre. Using a
   * fraction rather than output pixels means the same value stays meaningful at
   * any zoom level, and the edges are always reachable.
   */
  offsetX: number;
  offsetY: number;
  /** Background for 'fit' letterboxing, as 0..255 RGB. */
  background: [number, number, number];
  /** 1 = nearest neighbour, higher = smoother area average. */
  smooth: number;
}

export const DEFAULT_SOURCE: SourceOptions = {
  fit: 'fit',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  background: [0, 0, 0],
  smooth: 1,
};

/** RGBA source pixels with a known size (as produced by a canvas). */
export interface SourceImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Resample the source into the 256x192 screen, returning RGBA bytes.
 *
 * Downscaling averages source pixels (box filter) with a weight equal to the
 * area each source pixel covers in the destination, which avoids the aliasing
 * and moire that nearest-neighbour produces on detailed photos. Upscaling
 * falls back to bilinear so small images do not turn into blocky noise.
 */
export function fitToScreen(src: SourceImage, opt: SourceOptions): Uint8ClampedArray<ArrayBuffer> {
  const sw = src.width;
  const sh = src.height;
  const out = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
  if (sw === 0 || sh === 0) return out;

  const scaleMode = opt.fit === 'stretch';
  const base = scaleMode
    ? [SCREEN_W / sw, SCREEN_H / sh]
    : opt.fit === 'fit'
      ? [Math.min(SCREEN_W / sw, SCREEN_H / sh), Math.min(SCREEN_W / sw, SCREEN_H / sh)]
      : [Math.max(SCREEN_W / sw, SCREEN_H / sh), Math.max(SCREEN_W / sw, SCREEN_H / sh)];

  const scaleX = base[0] * opt.zoom;
  const scaleY = base[1] * opt.zoom;

  const dw = sw * scaleX;
  const dh = sh * scaleY;

  // Pan is a fraction of the scaled size, so resolve it to output pixels here,
  // and clamp so the image never leaves a gap at the edge it is panned to.
  const panMaxX = Math.max(0, (dw - SCREEN_W) / 2);
  const panMaxY = Math.max(0, (dh - SCREEN_H) / 2);
  const dx = (SCREEN_W - dw) / 2 + clamp(opt.offsetX * dw, -panMaxX, panMaxX);
  const dy = (SCREEN_H - dh) / 2 + clamp(opt.offsetY * dh, -panMaxY, panMaxY);

  const [br, bg, bb] = opt.background;
  const smooth = opt.smooth;
  const sdata = src.data;

  for (let y = 0; y < SCREEN_H; y++) {
    // Source y interval covered by this destination row.
    const sy0 = (y + 0.5 - dy) / scaleY;
    const sy1 = (y + 1.5 - dy) / scaleY;
    for (let x = 0; x < SCREEN_W; x++) {
      const sx0 = (x + 0.5 - dx) / scaleX;
      const sx1 = (x + 1.5 - dx) / scaleX;
      const o = (y * SCREEN_W + x) * 4;

      if (sx1 <= 0 || sy1 <= 0 || sx0 >= sw || sy0 >= sh) {
        out[o] = br;
        out[o + 1] = bg;
        out[o + 2] = bb;
        out[o + 3] = 255;
        continue;
      }

      const x0 = Math.max(0, sx0);
      const x1 = Math.min(sw, sx1);
      const y0 = Math.max(0, sy0);
      const y1 = Math.min(sh, sy1);

      if (scaleX >= 1 && scaleY >= 1) {
        // Bilinear sample at the destination pixel centre.
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5 - dx) / scaleX - 0.5));
        const fy = Math.min(sh - 1, Math.max(0, (y + 0.5 - dy) / scaleY - 0.5));
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const ix1 = Math.min(sw - 1, ix + 1);
        const iy1 = Math.min(sh - 1, iy + 1);
        const a = (iy * sw + ix) * 4;
        const b = (iy * sw + ix1) * 4;
        const c = (iy1 * sw + ix) * 4;
        const d = (iy1 * sw + ix1) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = sdata[a + ch] + (sdata[b + ch] - sdata[a + ch]) * tx;
          const bot = sdata[c + ch] + (sdata[d + ch] - sdata[c + ch]) * tx;
          out[o + ch] = top + (bot - top) * ty;
        }
        out[o + 3] = 255;
        continue;
      }

      // Area average over the covered fraction of each source pixel.
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      const fy0 = Math.floor(y0);
      const fy1 = Math.ceil(y1);
      const fx0 = Math.floor(x0);
      const fx1 = Math.ceil(x1);
      for (let sy = fy0; sy < fy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = fx0; sx < fx1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          r += sdata[i] * w;
          g += sdata[i + 1] * w;
          b += sdata[i + 2] * w;
          wsum += w;
        }
      }
      if (wsum <= 0) {
        out[o] = br;
        out[o + 1] = bg;
        out[o + 2] = bb;
      } else {
        out[o] = r / wsum;
        out[o + 1] = g / wsum;
        out[o + 2] = b / wsum;
      }
      out[o + 3] = 255;
    }
  }

  if (smooth > 1) boxBlurRGBA(out, SCREEN_W, SCREEN_H, smooth - 1);
  return out;
}

function boxBlurRGBA(img: Uint8ClampedArray, w: number, h: number, radius: number): void {
  if (radius < 1) return;
  const tmp = new Float32Array(w * h * 3);
  const src = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < img.length; i += 4, j += 3) {
    src[j] = img[i];
    src[j + 1] = img[i + 1];
    src[j + 2] = img[i + 2];
  }
  const r = Math.round(radius);
  horizontal(src, tmp, w, h, r);
  vertical(tmp, src, w, h, r);
  for (let i = 0, j = 0; i < img.length; i += 4, j += 3) {
    img[i] = src[j];
    img[i + 1] = src[j + 1];
    img[i + 2] = src[j + 2];
  }
}

function horizontal(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[(y * w + Math.min(w - 1, Math.max(0, x))) * 3 + c];
      for (let x = 0; x < w; x++) {
        dst[(y * w + x) * 3 + c] = acc * inv;
        const add = src[(y * w + Math.min(w - 1, x + r + 1)) * 3 + c];
        const sub = src[(y * w + Math.max(0, x - r)) * 3 + c];
        acc += add - sub;
      }
    }
  }
}

function vertical(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (r * 2 + 1);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += src[(Math.min(h - 1, Math.max(0, y)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        dst[(y * w + x) * 3 + c] = acc * inv;
        const add = src[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c];
        const sub = src[(Math.max(0, y - r) * w + x) * 3 + c];
        acc += add - sub;
      }
    }
  }
}
