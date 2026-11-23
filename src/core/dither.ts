import type { DitherName } from './types';

/** Error diffusion kernels, weights not normalised (callers may scale). */
const KERNELS: Record<string, number[][]> = {
  // [dx, dy, weight]
  floyd: [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16],
  ],
  atkinson: [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ],
  jarvis: [
    [1, 0, 7 / 48],
    [2, 0, 5 / 48],
    [-2, 1, 3 / 48],
    [-1, 1, 5 / 48],
    [0, 1, 7 / 48],
    [1, 1, 5 / 48],
    [2, 1, 3 / 48],
    [-2, 2, 1 / 48],
    [-1, 2, 3 / 48],
    [0, 2, 5 / 48],
    [1, 2, 3 / 48],
    [2, 2, 1 / 48],
  ],
  sierra: [
    [1, 0, 5 / 32],
    [2, 0, 3 / 32],
    [-2, 1, 2 / 32],
    [-1, 1, 4 / 32],
    [0, 1, 5 / 32],
    [1, 1, 4 / 32],
    [2, 1, 2 / 32],
    [-1, 2, 2 / 32],
    [0, 2, 3 / 32],
    [1, 2, 2 / 32],
  ],
  stucki: [
    [1, 0, 8 / 42],
    [2, 0, 4 / 42],
    [-2, 1, 2 / 42],
    [-1, 1, 4 / 42],
    [0, 1, 8 / 42],
    [1, 1, 4 / 42],
    [2, 1, 2 / 42],
    [-2, 2, 1 / 42],
    [-1, 2, 2 / 42],
    [0, 2, 4 / 42],
    [1, 2, 2 / 42],
    [2, 2, 1 / 42],
  ],
};

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

export const DITHER_OPTIONS: { id: DitherName; name: string; hint: string }[] = [
  { id: 'floyd', name: 'Floyd–Steinberg', hint: 'classic organic diffusion' },
  { id: 'atkinson', name: 'Atkinson', hint: 'airy, keeps highlights' },
  { id: 'jarvis', name: 'Jarvis–Judice–Ninke', hint: 'wide and soft' },
  { id: 'sierra', name: 'Sierra', hint: 'softer than Floyd' },
  { id: 'stucki', name: 'Stucki', hint: 'clean, fast converging' },
  { id: 'bayer8', name: 'Bayer 8×8', hint: 'ordered, aligns with cells' },
  { id: 'bayer4', name: 'Bayer 4×4', hint: 'coarser ordered' },
  { id: 'bayer2', name: 'Bayer 2×2', hint: 'coarsest, very games-y' },
  { id: 'noise', name: 'Noise', hint: 'unstructured, grainy' },
  { id: 'none', name: 'None', hint: 'hard threshold at mid-grey' },
];

export function isOrdered(name: DitherName): boolean {
  return name === 'bayer8' || name === 'bayer4' || name === 'bayer2' || name === 'noise';
}

export function kernelFor(name: DitherName): number[][] | null {
  return KERNELS[name] ?? null;
}

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER_2 = [0, 2, 3, 1];

/** Threshold in 0..1 for a pixel position, honouring the matrix size. */
export function thresholdAt(name: DitherName, x: number, y: number): number {
  switch (name) {
    case 'bayer8':
      return (BAYER_8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
    case 'bayer4':
      return (BAYER_4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
    case 'bayer2':
      return (BAYER_2[(y & 1) * 2 + (x & 1)] + 0.5) / 4;
    case 'noise':
      // Hash based white noise; a proper void-and-cluster map would be
      // better but the lattice makes little difference at 8x8 cells.
      return hash2(x, y);
    default:
      return 0.5;
  }
}

function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
