import { DEFAULT_OPTIONS } from './defaults';
import { SCREEN_H, SCREEN_W } from './palette';
import type { ConvertOptions } from './types';

export const NPX = SCREEN_W * SCREEN_H;

/**
 * A layer owns a set of pixels and its own tone / colour / detail / dithering.
 *
 * The point is to apply different treatments to different regions of one
 * picture: dither a sky with Bayer, a face with Floyd-Steinberg, keep a logo
 * crisp with `none`, and drive each region's contrast separately.
 *
 * Ownership is topmost-wins: on a pixel painted by two layers, the one later in
 * the list is used. The bottom layer is normally unpainted, i.e. `mask === null`,
 * so it acts as the background everywhere the others do not reach.
 */
/**
 * Where a layer's *attribute* (its two-colour pair) comes from.
 *
 * Normally a layer produces both the attribute and the bitmap. On the Spectrum
 * those are separate memory regions, though, so an attribute can be borrowed:
 * - `own`       the layer fits its own pair (the normal case)
 * - `attributes` take the pair from another layer, but keep this layer's own
 *                dither pattern. This is the "colour it like that, dither it
 *                like this" composite.
 * - `bitmap`     keep this layer's pair but take another layer's bit pattern.
 */
export type LayerBlend = 'own' | 'attributes' | 'bitmap';

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  options: ConvertOptions;
  /** Per-pixel ownership: 0 or 1 per pixel, or null for "the whole screen". */
  mask: Uint8Array | null;
  /** How this layer's attributes and bitmap are composed. */
  blend?: LayerBlend;
  /** The layer to borrow from, for `attributes` and `bitmap`. */
  blendWith?: string | null;
}

let counter = 0;

export function newLayerId(): string {
  counter += 1;
  return `l${Date.now().toString(36)}${counter.toString(36)}`;
}

export function createLayer(name: string, options: Partial<ConvertOptions> = {}, mask: Uint8Array | null = null): Layer {
  return {
    id: newLayerId(),
    name,
    visible: true,
    options: { ...DEFAULT_OPTIONS, ...options },
    mask,
    blend: 'own',
    blendWith: null,
  };
}

export function createBaseLayer(options: Partial<ConvertOptions> = {}): Layer {
  return createLayer('Base', options, null);
}

/** A queryable mask: null means every pixel. */
export function owns(layer: Layer, index: number): boolean {
  return layer.visible && (layer.mask === null || layer.mask[index] !== 0);
}

export function countOwned(layer: Layer): number {
  if (layer.mask === null) return NPX;
  let n = 0;
  for (let i = 0; i < NPX; i++) if (layer.mask[i]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Painting

export interface StampOptions {
  /** Brush radius in screen pixels. */
  radius: number;
  /** Value written: 1 paints, 0 erases. */
  value: 0 | 1;
  /** Hardness 0..1: 1 is a hard disc, 0 a soft falloff. */
  hardness: number;
}

/** Paint a soft round brush at (cx, cy) into a mask. */
export function stamp(mask: Uint8Array, cx: number, cy: number, opt: StampOptions): void {
  const r = Math.max(0.5, opt.radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(SCREEN_W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(SCREEN_H - 1, Math.ceil(cy + r));
  const hard = Math.min(1, Math.max(0, opt.hardness));
  const inner = r * hard;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      if (d <= inner) {
        mask[y * SCREEN_W + x] = opt.value;
        continue;
      }
      // Soft edge: only paint where the falloff clears the existing value, so
      // dragging the brush does not erode a hard edge into a ragged one.
      const t = 1 - (d - inner) / Math.max(1e-3, r - inner);
      const w = hard + (1 - hard) * t;
      if (opt.value === 1 ? w > 0.5 : w > 0.5) mask[y * SCREEN_W + x] = opt.value;
    }
  }
}

/**
 * Stamp along a segment, spaced by a fraction of the radius so a fast drag
 * leaves a continuous stroke instead of a dotted line.
 */
export function stroke(
  mask: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opt: StampOptions,
): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(0.5, opt.radius * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    stamp(mask, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, opt);
  }
}

export function fillMask(value: 0 | 1): Uint8Array {
  const mask = new Uint8Array(NPX);
  if (value) mask.fill(1);
  return mask;
}

export function invertMask(mask: Uint8Array): void {
  for (let i = 0; i < NPX; i++) mask[i] = mask[i] ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Serialisation: masks are a bitmask + base64 so a few layers fit in storage.

export function packMask(mask: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(NPX / 8));
  for (let i = 0; i < NPX; i++) {
    if (mask[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function unpackMask(data: string): Uint8Array | null {
  try {
    const bin = atob(data);
    if (bin.length * 8 < NPX) return null;
    const mask = new Uint8Array(NPX);
    for (let i = 0; i < NPX; i++) {
      mask[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
    }
    return mask;
  } catch {
    return null;
  }
}

export interface StoredLayer {
  id: string;
  name: string;
  visible: boolean;
  options: ConvertOptions;
  /** Packed mask, absent for the background layer. */
  mask?: string;
  blend?: LayerBlend;
  blendWith?: string | null;
}

export function serialiseLayers(layers: Layer[]): StoredLayer[] {
  return layers.map((l) => ({
    id: l.id,
    name: l.name,
    visible: l.visible,
    options: l.options,
    ...(l.mask ? { mask: packMask(l.mask) } : {}),
    ...(l.blend && l.blend !== 'own' ? { blend: l.blend, blendWith: l.blendWith ?? null } : {}),
  }));
}

export function deserialiseLayers(stored: StoredLayer[]): Layer[] {
  const out: Layer[] = [];
  for (const s of stored) {
    const mask = s.mask ? unpackMask(s.mask) : null;
    out.push({
      id: s.id || newLayerId(),
      name: s.name || 'Layer',
      visible: s.visible !== false,
      options: { ...DEFAULT_OPTIONS, ...s.options },
      mask,
      blend: s.blend === 'attributes' || s.blend === 'bitmap' ? s.blend : 'own',
      blendWith: s.blendWith ?? null,
    });
  }
  return out.length ? out : [createBaseLayer()];
}
