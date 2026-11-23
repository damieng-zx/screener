import { rgbToOklab } from './color';

export interface ZxColour {
  /** 0..7 colour code as used in the attribute byte. */
  code: number;
  name: string;
  hex: string;
  rgb: [number, number, number];
  bright: boolean;
  /** Index into PALETTE. */
  index: number;
}

const NORMAL = [
  ['black', '#000000'],
  ['blue', '#0000d7'],
  ['red', '#d70000'],
  ['magenta', '#d700d7'],
  ['green', '#00d700'],
  ['cyan', '#00d7d7'],
  ['yellow', '#d7d700'],
  ['white', '#d7d7d7'],
] as const;

const BRIGHT = [
  ['blue', '#0000ff'],
  ['red', '#ff0000'],
  ['magenta', '#ff00ff'],
  ['green', '#00ff00'],
  ['cyan', '#00ffff'],
  ['yellow', '#ffff00'],
  ['white', '#ffffff'],
] as const;

const parse = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * The 15 distinct colours of a ZX Spectrum attribute. Black has no bright
 * variant, so the bright half starts at blue (index 8).
 */
export const PALETTE: ZxColour[] = [
  ...NORMAL.map(([name, hex], code) => ({
    code,
    name,
    hex,
    rgb: parse(hex),
    bright: false,
    index: code,
  })),
  ...BRIGHT.map(([name, hex], i) => ({
    code: i + 1,
    name,
    hex,
    rgb: parse(hex),
    bright: true,
    index: 8 + i,
  })),
];

/** OKLab of every palette colour, 3 floats each. */
export const PALETTE_LAB = new Float32Array(PALETTE.length * 3);
PALETTE.forEach((c, i) => {
  rgbToOklab(c.rgb[0] / 255, c.rgb[1] / 255, c.rgb[2] / 255, PALETTE_LAB, i * 3);
});

/** sRGB floats of every palette colour, 3 floats each. */
export const PALETTE_F = new Float32Array(PALETTE.length * 3);
PALETTE.forEach((c, i) => {
  PALETTE_F[i * 3] = c.rgb[0] / 255;
  PALETTE_F[i * 3 + 1] = c.rgb[1] / 255;
  PALETTE_F[i * 3 + 2] = c.rgb[2] / 255;
});

export type BrightMode = 'auto' | 'normal' | 'bright';

export interface CellPair {
  a: number;
  b: number;
}

/**
 * All unordered colour pairs a cell may use under a brightness constraint,
 * including single-colour pairs. 8 normal colours -> 36 pairs, 7 bright
 * colours -> 28 pairs, so "auto" starts from 64 candidates.
 */
export function candidatePairs(mask: number, brightMode: BrightMode): CellPair[] {
  const out: CellPair[] = [];
  const add = (list: number[]) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i; j < list.length; j++) out.push({ a: list[i], b: list[j] });
    }
  };
  const normals = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => mask & (1 << i));
  if (brightMode !== 'bright') add(normals);
  if (brightMode !== 'normal') {
    // Bright palette: black plus the seven bright colours that are enabled.
    const brights = [0, 8, 9, 10, 11, 12, 13, 14].filter((i) => mask & (1 << i));
    add(brights);
  }
  return out;
}

export interface Attribute {
  /** Colour code 0..7 as stored in the attribute byte (index - 7 for bright). */
  ink: number;
  paper: number;
  bright: boolean;
  flash: boolean;
}

export function attributeByte(attr: Attribute): number {
  return (attr.flash ? 0x80 : 0) | (attr.bright ? 0x40 : 0) | ((attr.paper & 7) << 3) | (attr.ink & 7);
}

export function attributeFromByte(byte: number): Attribute {
  return {
    ink: byte & 7,
    paper: (byte >> 3) & 7,
    bright: (byte & 0x40) !== 0,
    flash: (byte & 0x80) !== 0,
  };
}

export const SCREEN_W = 256;
export const SCREEN_H = 192;
export const CELL_W = 8;
export const CELL_H = 8;
export const COLS = SCREEN_W / CELL_W; // 32
export const ROWS = SCREEN_H / CELL_H; // 24
export const BITMAP_BYTES = 6144;
export const ATTR_BYTES = 768;
export const SCR_BYTES = BITMAP_BYTES + ATTR_BYTES; // 6912

/**
 * Spectrum bitmap memory layout: the 6144 bitmap bytes are stored in three
 * 64-line "thirds", each interleaved by scanline within an 8x8 character row.
 * See https://breakintoprogram.co.uk/hardware/computers/zx-spectrum/screen-memory-layout
 *
 * Kept next to the constants so there is one definition of the layout; export.ts
 * uses it for the actual packing.
 */
export function bitmapOffset(y: number, byteCol: number): number {
  return (((y >> 6) & 3) << 11) | ((y & 7) << 8) | (((y >> 3) & 7) << 5) | byteCol;
}
