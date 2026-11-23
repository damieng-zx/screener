/**
 * Headless checks for the conversion pipeline: no DOM involved, so this runs
 * in node via `npm run bench`.
 *
 * It builds a few synthetic sources, converts them with several option sets,
 * and verifies the invariants the ZX Spectrum hardware enforces:
 *   - .scr is exactly 6912 bytes
 *   - every attribute's ink/paper belong to the same palette half
 *   - each cell only uses its two attribute colours
 *   - toScr -> fromScr round-trips
 */
import { convert } from '../src/core/convert';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import { fromScr, toScr, toTap } from '../src/core/export';
import { PALETTE, SCREEN_H, SCREEN_W, attributeFromByte } from '../src/core/palette';
import type { ConvertOptions } from '../src/core/types';

const NPX = SCREEN_W * SCREEN_H;

function gradient(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      out[i] = (x / SCREEN_W) * 255;
      out[i + 1] = (y / SCREEN_H) * 255;
      out[i + 2] = (((x >> 3) + (y >> 3)) % 2) * 255;
    }
  }
  return out;
}

function checker(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      const on = ((x >> 4) + (y >> 4)) % 2 === 0;
      out[i] = on ? 240 : 10;
      out[i + 1] = on ? 200 : 20;
      out[i + 2] = on ? 60 : 30;
    }
  }
  return out;
}

function noise(seed: number): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function onlyTwoColours(result: ReturnType<typeof convert>): string[] {
  const problems: string[] = [];
  for (let cy = 0; cy < 24; cy++) {
    for (let cx = 0; cx < 32; cx++) {
      const ci = cy * 32 + cx;
      const attr = attributeFromByte(result.attr[ci]);
      const ink = PALETTE[findIndex(attr.ink, attr.bright)];
      const paper = PALETTE[findIndex(attr.paper, attr.bright)];
      if (!ink || !paper) {
        problems.push(`cell ${cx},${cy}: attribute colour missing from palette`);
        continue;
      }
      if (ink.bright !== paper.bright && ink.code !== 0 && paper.code !== 0) {
        problems.push(`cell ${cx},${cy}: mixed palette halves ${ink.hex}/${paper.hex}`);
      }
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const p = PALETTE[result.pixelIdx[(cy * 8 + py) * SCREEN_W + cx * 8 + px]];
          const ok =
            (p.code === attr.ink || p.code === attr.paper) && (p.code === 0 || p.bright === attr.bright);
          if (!ok) problems.push(`cell ${cx},${cy}: pixel ${p.hex} not in attribute`);
        }
      }
    }
  }
  return problems;
}

function findIndex(code: number, bright: boolean): number {
  const i = PALETTE.findIndex((p) => p.code === code && (p.code === 0 ? !p.bright : p.bright === bright));
  return i;
}

const sources: [string, Uint8Array][] = [
  ['gradient', gradient()],
  ['checker', checker()],
  ['noise', noise(7)],
];

const optionSets: [string, Partial<ConvertOptions>][] = [
  ['default', {}],
  ['smart/atkinson', { dither: 'atkinson' }],
  ['frequency/bayer8', { method: 'frequency', dither: 'bayer8' }],
  ['exhaustive/none', { method: 'exhaustive', dither: 'none' }],
  ['average/jarvis', { method: 'average', dither: 'jarvis' }],
  ['bright only', { brightMode: 'bright' }],
  ['normal only', { brightMode: 'normal' }],
  ['no single cells', { allowSingleColour: false }],
  ['two colours', { paletteMask: (1 << 1) | (1 << 6), saturation: 0 }],
  ['no pre-quantise', { preQuantize: false }],
];

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  FAIL ${msg}`);
};

for (const [sname, source] of sources) {
  for (const [oname, patch] of optionSets) {
    const opts = { ...DEFAULT_OPTIONS, ...patch };
    const label = `${sname} + ${oname}`;
    const t0 = performance.now();
    const result = convert(source, opts, 3);
    const ms = performance.now() - t0;

    const scr = toScr(result);
    if (scr.length !== 6912) fail(`${label}: .scr is ${scr.length} bytes`);

    const problems = onlyTwoColours(result);
    if (problems.length) {
      for (const p of problems.slice(0, 3)) fail(`${label}: ${p}`);
    }

    const back = fromScr(scr);
    let mismatch = 0;
    for (let i = 0; i < NPX; i++) if (back.pixelIdx[i] !== result.pixelIdx[i]) mismatch++;
    if (mismatch > 0) fail(`${label}: .scr round-trip lost ${mismatch} pixels`);

    const tap = toTap(result, 'test');
    // header block: 2 len + 1 flag + 17 payload + 1 checksum = 21
    // data block:   2 len + 1 flag + 6912 payload + 1 checksum = 6916
    if (tap.length !== 21 + 6916) fail(`${label}: .tap is ${tap.length} bytes, expected ${21 + 6916}`);

    console.log(
      `ok  ${label.padEnd(34)} ${ms.toFixed(1).padStart(6)} ms  ΔE ${result.stats.meanError
        .toFixed(1)
        .padStart(5)}  cells single ${String(result.stats.singleColourCells).padStart(3)}  attrs ${
        result.stats.distinctAttributes
      }`,
    );
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll pipeline checks passed.');
