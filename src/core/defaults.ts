import type { ConvertOptions } from './types';

export const DEFAULT_OPTIONS: ConvertOptions = {
  exposure: 0,
  brightness: 0,
  contrast: 0.08,
  gamma: 1,
  blackPoint: 0,
  whitePoint: 1,

  saturation: 1.1,
  vibrance: 0.15,
  hue: 0,
  temperature: 0,
  tint: 0,

  blur: 0,
  sharpen: 0.4,
  posterize: 0,
  binarize: false,
  threshold: 0.5,
  vignette: 0,
  vignetteSize: 0.5,

  brightMode: 'auto',
  paletteMask: 0x7fff,
  allowSingleColour: true,
  singleBias: 0,
  method: 'smart',
  dither: 'floyd',
  ditherStrength: 1,
  chromaWeight: 1,
  preQuantize: false,
  preDither: 'floyd',
  cohesion: 0.35,
  flashMode: 'off',
};

export interface Preset {
  id: string;
  name: string;
  hint: string;
  patch: Partial<ConvertOptions>;
}

export const PRESETS: Preset[] = [
  {
    id: 'photo',
    name: 'Photo',
    hint: 'Dither-heavy, full palette',
    patch: {
      exposure: 0.05,
      contrast: 0.1,
      saturation: 1.15,
      vibrance: 0.2,
      sharpen: 0.5,
      dither: 'floyd',
      ditherStrength: 1,
      method: 'smart',
      brightMode: 'auto',
      paletteMask: 0x7fff,
      cohesion: 0.35,
      preQuantize: false,
      singleBias: 0,
    },
  },
  {
    id: 'graphic',
    name: 'Graphic',
    hint: 'Flat areas, ordered dither',
    patch: {
      contrast: 0.25,
      saturation: 1.35,
      vibrance: 0.1,
      sharpen: 0.9,
      dither: 'bayer8',
      ditherStrength: 1,
      method: 'exhaustive',
      cohesion: 0.6,
      singleBias: 0.35,
      posterize: 0,
    },
  },
  {
    id: 'mono',
    name: 'Mono',
    hint: 'Black, white and nothing else',
    patch: {
      brightMode: 'normal',
      paletteMask: (1 << 0) | (1 << 7),
      contrast: 0.2,
      saturation: 0,
      dither: 'bayer8',
      method: 'smart',
      allowSingleColour: true,
      singleBias: 0.5,
      cohesion: 0.5,
    },
  },
  {
    id: 'bright',
    name: 'Bright',
    hint: 'C64-ish vivid palette',
    patch: {
      brightMode: 'bright',
      paletteMask: 0x7f80,
      contrast: 0.15,
      saturation: 1.25,
      vibrance: 0.25,
      cohesion: 0.2,
      dither: 'atkinson',
    },
  },
  {
    id: 'duotone',
    name: 'Duotone',
    hint: 'Two colours only, ink on paper',
    patch: {
      brightMode: 'normal',
      paletteMask: (1 << 1) | (1 << 6), // blue + yellow
      contrast: 0.3,
      saturation: 0,
      dither: 'floyd',
      cohesion: 0.4,
      singleBias: 0.2,
    },
  },
  {
    id: 'lineart',
    name: 'Line art',
    hint: 'Posterised, hard edges',
    patch: {
      contrast: 0.45,
      saturation: 0.6,
      sharpen: 1.2,
      posterize: 6,
      dither: 'none',
      cohesion: 0.7,
      singleBias: 0.45,
      method: 'exhaustive',
    },
  },
];
