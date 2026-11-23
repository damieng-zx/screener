import type { BrightMode } from './palette';

export type ConvertMethod = 'smart' | 'exhaustive' | 'frequency' | 'average';

export type DitherName =
  | 'none'
  | 'floyd'
  | 'atkinson'
  | 'jarvis'
  | 'sierra'
  | 'stucki'
  | 'bayer8'
  | 'bayer4'
  | 'bayer2'
  | 'noise';

export type FitMode = 'fit' | 'fill' | 'stretch';

export type FlashMode = 'off' | 'checker' | 'random';

export interface ConvertOptions {
  /** Tone mapping, all optional, defaults are neutral. */
  exposure: number;
  brightness: number;
  contrast: number;
  gamma: number;
  blackPoint: number;
  whitePoint: number;

  /** Chroma. */
  saturation: number;
  vibrance: number;
  hue: number;
  temperature: number;
  tint: number;

  /** Detail. */
  blur: number;
  sharpen: number;
  posterize: number;
  binarize: boolean;
  threshold: number;
  /** Horizontal white/black fade, -1..1, zero (centre) = no effect. */
  vignette: number;
  /** How far the vignette reaches in from the edge, 0..1. */
  vignetteSize: number;

  /** Spectrum constraints. */
  brightMode: BrightMode;
  /** 15-bit mask of allowed palette indices (bit i = PALETTE[i]). */
  paletteMask: number;
  allowSingleColour: boolean;
  singleBias: number;
  method: ConvertMethod;
  dither: DitherName;
  ditherStrength: number;
  preQuantize: boolean;
  preDither: DitherName;
  cohesion: number;
  flashMode: FlashMode;
}

export interface ConvertStats {
  /** Mean OKLab distance x100 from the adjusted source to the result. */
  meanError: number;
  /** Worst single-pixel OKLab distance x100. */
  maxError: number;
  cells: number;
  singleColourCells: number;
  brightCells: number;
  normalCells: number;
  distinctAttributes: number;
  /** Fraction of set pixels in the bitmap (ink usage). */
  inkCoverage: number;
  /** Pixel count per palette index. */
  paletteUse: number[];
  ms: number;
  /** Pixels owned by each participating layer, in list order. */
  layers: { id: string; name: string; pixels: number }[];
}

export interface ConversionResult {
  width: number;
  height: number;
  /** Final image as sRGB bytes, RGBA, ready for ImageData. */
  screen: Uint8ClampedArray<ArrayBuffer>;
  /** 768 attribute bytes, linear order. */
  attr: Uint8Array<ArrayBuffer>;
  /** Per-pixel palette index 0..14 (linear order). */
  pixelIdx: Uint8Array<ArrayBuffer>;
  /** Per-cell palette indices of the two colours (or the same twice). */
  cellA: Uint8Array<ArrayBuffer>;
  cellB: Uint8Array<ArrayBuffer>;
  stats: ConvertStats;
}

export interface WorkerRequest {
  seq: number;
  /** sRGB bytes of the fitted source image, RGB triples at 256x192. */
  source: Uint8Array;
  options: ConvertOptions | import('./layers').Layer[];
}
export interface WorkerResponse {
  seq: number;
  ok: boolean;
  error?: string;
  result?: ConversionResult;
}
