import { adjustPixels } from './adjust';
import { clamp, clamp01, mulberry32, rgbToOklab } from './color';
import {
  CELL_H,
  CELL_W,
  COLS,
  PALETTE,
  PALETTE_F,
  PALETTE_LAB,
  ROWS,
  SCREEN_H,
  SCREEN_W,
  attributeByte,
  candidatePairs,
} from './palette';
import { isOrdered, kernelFor, thresholdAt } from './dither';
import { createBaseLayer, owns, type Layer } from './layers';
import type { ConversionResult, ConvertOptions, ConvertStats } from './types';

const NPX = SCREEN_W * SCREEN_H;
const NCEL = COLS * ROWS;
const CELL_PX = CELL_W * CELL_H;

interface Candidate {
  a: number;
  b: number;
  single: boolean;
  labA: [number, number, number];
  labB: [number, number, number];
  /** b - a in OKLab, precomputed for segment projection. */
  ab: [number, number, number];
  len2: number;
}

/** Everything computed for one layer, so the passes below stay readable. */
interface Prepared {
  layer: Layer;
  /** Adjusted, gamma-encoded sRGB, 0..1. */
  rgb: Float32Array;
  /** The same image in OKLab. */
  lab: Float32Array;
  /** The adjusted image before any pre-quantise, used for error stats. */
  targetLab: Float32Array;
  candidates: Candidate[];
  histColours: number[];
}

/**
 * Convert an sRGB RGB byte array (256*192*3) into a ZX Spectrum screen.
 *
 * The hard constraint: the screen is split into 8x8 cells and each cell may
 * show exactly two colours, both from the same half of the palette (normal or
 * bright). Black is in both halves. Everything else is a trade-off, so
 * per-cell pair selection is pluggable and dithering decides which of the two
 * colours each pixel gets.
 *
 * Layers let different regions of one picture be treated differently. An
 * attribute covers a whole 8x8 cell, so a cell is governed by the layer that
 * owns the most pixels in it: that layer's palette constraints, cell fitting
 * and dithering method apply to the cell. Each pixel's own colour pipeline
 * (tone, colour, detail) still comes from the layer that owns that pixel, which
 * is what makes a crisp logo sit next to a dithered photo.
 */
export function convert(
  source: Uint8Array,
  optsOrLayers: ConvertOptions | Layer[],
  seed = 1,
): ConversionResult {
  const t0 = now();

  // A bare options object is the single-layer case, so every existing caller
  // and test keeps working unchanged.
  const layers: Layer[] = Array.isArray(optsOrLayers)
    ? optsOrLayers.filter((l) => l.visible)
    : [{ ...createBaseLayer(), options: optsOrLayers }];
  if (layers.length === 0) throw new Error('No visible layers.');

  const prepared = layers.map((layer) => prepareLayer(layer, source));

  // Ownership: topmost wins, so walk the list backwards.
  const owner = new Int16Array(NPX).fill(-1);
  for (let li = layers.length - 1; li >= 0; li--) {
    const l = layers[li];
    for (let i = 0; i < NPX; i++) if (owner[i] < 0 && owns(l, i)) owner[i] = li;
  }
  // Anything no layer claims falls through to the topmost visible layer, so a
  // stray unpainted gap can never produce an unrendered pixel.
  const fallback = layers.length - 1;
  for (let i = 0; i < NPX; i++) if (owner[i] < 0) owner[i] = fallback;

  // Which layer governs each attribute cell: the one with the most pixels.
  const cellOwner = new Int16Array(NCEL);
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const counts = new Int32Array(layers.length);
      let best = 0;
      let bestN = -1;
      for (let py = 0; py < CELL_H; py++) {
        const row = (cy * CELL_H + py) * SCREEN_W + cx * CELL_W;
        for (let px = 0; px < CELL_W; px++) {
          const li = owner[row + px];
          const n = ++counts[li];
          if (n > bestN) {
            bestN = n;
            best = li;
          }
        }
      }
      cellOwner[cy * COLS + cx] = best;
    }
  }

  // ---- Which layer supplies each cell's attributes, and each pixel's bitmap --
  //
  // Usually one layer does both. When a layer is set to borrow attributes, its
  // cells' colour pairs are fitted by another layer's pipeline while the pixels
  // inside those cells are still dithered by this layer, so the *pattern* and
  // the *colour* can be chosen independently. That is only meaningful because
  // the Spectrum stores them in separate memory regions.
  const pairSource = new Int16Array(NCEL);
  const ditherSource = new Int16Array(NPX);
  for (let ci = 0; ci < NCEL; ci++) pairSource[ci] = cellOwner[ci];
  for (let i = 0; i < NPX; i++) ditherSource[i] = owner[i];

  const indexOfId = new Map<string, number>();
  layers.forEach((l, i) => indexOfId.set(l.id, i));

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    if (!layer.blend || layer.blend === 'own' || !layer.blendWith) continue;
    const donor = indexOfId.get(layer.blendWith);
    if (donor === undefined || donor === li) continue;

    if (layer.blend === 'attributes') {
      // Take the pair from the donor over this layer's cells; keep dithering.
      for (let ci = 0; ci < NCEL; ci++) if (cellOwner[ci] === li) pairSource[ci] = donor;
    } else {
      // Keep this layer's pair, take the donor's bit pattern.
      const region = pixelRegion(owner, li);
      for (const pi of region) ditherSource[pi] = donor;
    }
  }

  // ---- Per-cell pair fitting -------------------------------------------------
  const cellA = new Uint8Array(NCEL);
  const cellB = new Uint8Array(NCEL);
  const cellScore = new Float32Array(NCEL);
  const cellPixels = new Float32Array(CELL_PX * 3);

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const ci = cy * COLS + cx;
      const li = pairSource[ci];
      const { lab, candidates, histColours } = prepared[li];
      const opts = layers[li].options;

      // When a layer borrows its attributes, the donor must look at the pixels
      // it is colouring, not only the ones it owns, or it would fit a pair for
      // an image that is not the one being drawn.
      const borrows = layers[cellOwner[ci]].blend === 'attributes';
      const ownerForFit = borrows ? cellOwner[ci] : li;

      const hist = new Int32Array(PALETTE.length);
      let ml = 0;
      let ma = 0;
      let mb = 0;
      let used = 0;
      for (let py = 0; py < CELL_H; py++) {
        const row = (cy * CELL_H + py) * SCREEN_W;
        for (let px = 0; px < CELL_W; px++) {
          const pi = row + cx * CELL_W + px;
          if (!borrows && owner[pi] !== ownerForFit) continue;
          const i = pi * 3;
          const p = py * CELL_W + px;
          cellPixels[p * 3] = lab[i];
          cellPixels[p * 3 + 1] = lab[i + 1];
          cellPixels[p * 3 + 2] = lab[i + 2];
          ml += lab[i];
          ma += lab[i + 1];
          mb += lab[i + 2];
          hist[nearestOf(histColours, lab[i], lab[i + 1], lab[i + 2])]++;
          used++;
        }
      }
      const n = Math.max(1, used);
      const scored = scoreCell(candidates, cellPixels, hist, ml / n, ma / n, mb / n, opts);
      cellA[ci] = scored.a;
      cellB[ci] = scored.b;
      cellScore[ci] = scored.score;
    }
  }

  // Cohesion is a per-layer refinement; run it with each layer's own tolerance
  // over the cells that layer supplies pairs for.
  for (let li = 0; li < layers.length; li++) {
    if (layers[li].options.cohesion <= 0) continue;
    const cells: number[] = [];
    for (let ci = 0; ci < NCEL; ci++) if (pairSource[ci] === li) cells.push(ci);
    if (cells.length) applyCohesion(cellA, cellB, cellScore, prepared[li], cells);
  }

  // ---- Dither: every pixel becomes one of its cell's two colours -------------
  const pixelIdx = new Uint8Array(NPX);
  for (let li = 0; li < layers.length; li++) {
    const region = pixelRegion(ditherSource, li);
    if (region.length === 0) continue;
    ditherPixels(prepared[li], cellA, cellB, cellOwner, region, pixelIdx);
  }

  // ---- Output ---------------------------------------------------------------
  const screen = new Uint8ClampedArray(NPX * 4);
  const attr = new Uint8Array(NCEL);
  const paletteUse = new Array<number>(PALETTE.length).fill(0);
  const rnd = mulberry32(seed * 2654435761);
  let singleCells = 0;
  let brightCells = 0;
  let normalCells = 0;
  let setBits = 0;

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const ci = cy * COLS + cx;
      const pa = cellA[ci];
      const pb = cellB[ci];

      let countPa = 0;
      for (let py = 0; py < CELL_H; py++) {
        const row = (cy * CELL_H + py) * SCREEN_W + cx * CELL_W;
        for (let px = 0; px < CELL_W; px++) {
          if (pixelIdx[row + px] === pa) countPa++;
        }
      }

      if (PALETTE[pa].bright || PALETTE[pb].bright) brightCells++;
      else normalCells++;

      // Ink ends up as the 1 bits, so make it the minority colour: fewer set
      // bits in the bitmap, which is what every ZX screen compressor wants.
      // A cell that dithering filled with one colour collapses to one colour,
      // unless the layer insists on two: then the pair is kept and the bitmap
      // is simply all-ink or all-paper, which is still a legal attribute.
      const wantsTwo = !layers[cellOwner[ci]].options.allowSingleColour && pa !== pb;
      let ink = pa;
      let paper = pb;
      if (countPa === 0) {
        ink = wantsTwo ? pa : pb;
        paper = pb;
      } else if (countPa === CELL_PX) {
        ink = pa;
        paper = wantsTwo ? pb : pa;
      } else if (countPa > CELL_PX - countPa) {
        ink = pb;
        paper = pa;
      }
      if (ink === paper) singleCells++;
      setBits += ink === paper ? 0 : Math.min(countPa, CELL_PX - countPa);

      const opts = layers[cellOwner[ci]].options;
      let flash = false;
      if (opts.flashMode === 'checker') flash = ((cx + cy) & 1) === 0;
      else if (opts.flashMode === 'random') flash = rnd() < 0.5;

      // Black belongs to both halves, so BRIGHT comes from whichever colour of
      // the pair actually has a bright variant.
      const bright = PALETTE[ink].bright || PALETTE[paper].bright;
      attr[ci] = attributeByte({
        ink: PALETTE[ink].code,
        paper: PALETTE[paper].code,
        bright,
        flash,
      });
    }
  }

  // ---- Stats ----------------------------------------------------------------
  // Error is measured per pixel against the layer that owns it, so a layer that
  // was tuned to look right does not get penalised for another layer's choices.
  let sumErr = 0;
  let maxErr = 0;
  for (let i = 0; i < NPX; i++) {
    const p = pixelIdx[i];
    paletteUse[p]++;
    const po = i * 3;
    const so = i * 4;
    const pr = PALETTE_F[p * 3];
    const pg = PALETTE_F[p * 3 + 1];
    const pb = PALETTE_F[p * 3 + 2];
    const target = prepared[owner[i]].targetLab;
    const dl = target[po] - PALETTE_LAB[p * 3];
    const da = target[po + 1] - PALETTE_LAB[p * 3 + 1];
    const db = target[po + 2] - PALETTE_LAB[p * 3 + 2];
    const err = Math.sqrt(dl * dl + da * da + db * db);
    sumErr += err;
    if (err > maxErr) maxErr = err;
    screen[so] = pr * 255;
    screen[so + 1] = pg * 255;
    screen[so + 2] = pb * 255;
    screen[so + 3] = 255;
  }

  // Perceptual error: mean OKLab error of 8x8 block averages.
  //
  // Per-pixel error punishes dithering by design — a dithered pixel is
  // deliberately the "wrong" colour so that its neighbourhood is right. The
  // block mean is what a viewer actually integrates, and it is the number that
  // should be trusted when comparing dither methods. (Measured: smart scores
  // 22.6 per-pixel but 7.5 perceptually, while exhaustive scores 16.7 and 15.4.)
  let blockErr = 0;
  let blockCount = 0;
  {
    const sumR = new Float32Array(NPX);
    const sumG = new Float32Array(NPX);
    const sumB = new Float32Array(NPX);
    const sumL = new Float32Array(NPX);
    const sumA = new Float32Array(NPX);
    const sumB2 = new Float32Array(NPX);
    for (let i = 0; i < NPX; i++) {
      const p = pixelIdx[i];
      sumR[i] = PALETTE_F[p * 3];
      sumG[i] = PALETTE_F[p * 3 + 1];
      sumB[i] = PALETTE_F[p * 3 + 2];
      const target = prepared[owner[i]].targetLab;
      sumL[i] = target[i * 3];
      sumA[i] = target[i * 3 + 1];
      sumB2[i] = target[i * 3 + 2];
    }
    const lab = new Float32Array(3);
    for (let cy = 0; cy < SCREEN_H; cy += CELL_H) {
      for (let cx = 0; cx < SCREEN_W; cx += CELL_W) {
        let r = 0;
        let g = 0;
        let b = 0;
        let tl = 0;
        let ta = 0;
        let tb = 0;
        for (let py = 0; py < CELL_H; py++) {
          for (let px = 0; px < CELL_W; px++) {
            const i = (cy + py) * SCREEN_W + cx + px;
            r += sumR[i];
            g += sumG[i];
            b += sumB[i];
            tl += sumL[i];
            ta += sumA[i];
            tb += sumB2[i];
          }
        }
        rgbToOklab(r / CELL_PX, g / CELL_PX, b / CELL_PX, lab, 0);
        const dl = tl / CELL_PX - lab[0];
        const da = ta / CELL_PX - lab[1];
        const db = tb / CELL_PX - lab[2];
        blockErr += Math.sqrt(dl * dl + da * da + db * db);
        blockCount++;
      }
    }
  }
  const perceptual = (blockErr / Math.max(1, blockCount)) * 100;

  const stats: ConvertStats = {
    meanError: (sumErr / NPX) * 100,
    maxError: maxErr * 100,
    perceptualError: perceptual,
    cells: NCEL,
    singleColourCells: singleCells,
    brightCells,
    normalCells,
    distinctAttributes: new Set(attr).size,
    inkCoverage: setBits / NPX,
    paletteUse,
    ms: now() - t0,
    layers: layers.map((l) => {
      let n = 0;
      for (let i = 0; i < NPX; i++) if (owner[i] === layers.indexOf(l)) n++;
      return { id: l.id, name: l.name, pixels: n };
    }),
  };

  return { width: SCREEN_W, height: SCREEN_H, screen, attr, pixelIdx, cellA, cellB, stats };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Pixels owned by layer `li`, as flat indices. */
function pixelRegion(owner: Int16Array, li: number): Int32Array {
  let n = 0;
  for (let i = 0; i < NPX; i++) if (owner[i] === li) n++;
  const out = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < NPX; i++) if (owner[i] === li) out[k++] = i;
  return out;
}

function prepareLayer(layer: Layer, source: Uint8Array): Prepared {
  const opts = layer.options;
  const rgb = new Float32Array(NPX * 3);
  for (let i = 0, j = 0; i < NPX; i++, j += 3) {
    rgb[i * 3] = source[j] / 255;
    rgb[i * 3 + 1] = source[j + 1] / 255;
    rgb[i * 3 + 2] = source[j + 2] / 255;
  }
  adjustPixels(rgb, opts);

  // The adjusted-but-unquantised image is the ground truth for error stats.
  const targetLab = new Float32Array(NPX * 3);
  for (let i = 0; i < NPX; i++) {
    rgbToOklab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], targetLab, i * 3);
  }

  // Optional pre-pass: flatten the image onto the palette with an ordered
  // dither before cells are fitted. Classic pipeline; tames noisy scans but
  // throws away tone, hence off by default.
  const work = new Float32Array(rgb);
  if (opts.preQuantize) preQuantise(work, opts);

  const lab = new Float32Array(NPX * 3);
  for (let i = 0; i < NPX; i++) {
    rgbToOklab(work[i * 3], work[i * 3 + 1], work[i * 3 + 2], lab, i * 3);
  }

  return {
    layer,
    rgb,
    lab,
    targetLab,
    candidates: buildCandidates(opts),
    histColours: allowedIndices(opts),
  };
}

// ---------------------------------------------------------------------------
// Candidates

function buildCandidates(opts: ConvertOptions): Candidate[] {
  const pairs = candidatePairs(opts.paletteMask & 0x7fff, opts.brightMode);
  const seen = new Set<number>();
  const out: Candidate[] = [];
  for (const { a, b } of pairs) {
    const key = a * 15 + b;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a === b && !opts.allowSingleColour) continue;
    const labA: [number, number, number] = [
      PALETTE_LAB[a * 3],
      PALETTE_LAB[a * 3 + 1],
      PALETTE_LAB[a * 3 + 2],
    ];
    const labB: [number, number, number] = [
      PALETTE_LAB[b * 3],
      PALETTE_LAB[b * 3 + 1],
      PALETTE_LAB[b * 3 + 2],
    ];
    const ab: [number, number, number] = [labB[0] - labA[0], labB[1] - labA[1], labB[2] - labA[2]];
    out.push({
      a,
      b,
      single: a === b,
      labA,
      labB,
      ab,
      len2: ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2],
    });
  }
  return out;
}

/** Allowed palette indices under the brightness constraint and mask. */
function allowedIndices(opts: ConvertOptions): number[] {
  const out: number[] = [];
  for (let i = 0; i < PALETTE.length; i++) {
    if (!(opts.paletteMask & (1 << i))) continue;
    const c = PALETTE[i];
    if (opts.brightMode === 'normal' && c.bright) continue;
    if (opts.brightMode === 'bright' && i !== 0 && !c.bright) continue;
    out.push(i);
  }
  return out.length ? out : [0];
}

/** Nearest allowed palette colour to an OKLab point. */
function nearestOf(colours: number[], L: number, A: number, B: number): number {
  let best = colours[0];
  let bestD = Infinity;
  for (const i of colours) {
    const dl = L - PALETTE_LAB[i * 3];
    const da = A - PALETTE_LAB[i * 3 + 1];
    const db = B - PALETTE_LAB[i * 3 + 2];
    const d = dl * dl + da * da + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Squared distance from a point to the segment a-b, plus the projection t.
 *
 * `w` scales the chroma axes (a,b) relative to lightness. Plain OKLab distance
 * treats a unit of lightness error as equal to a unit of hue error, but a hue
 * shift is much more visible, so a weight above 1 keeps colour honest.
 */
function segDist2(
  L: number,
  A: number,
  B: number,
  cand: Candidate,
  w = 1,
): { d: number; t: number } {
  const al = A * w;
  const bl = B * w;
  if (cand.single || cand.len2 < 1e-12) {
    const dl = L - cand.labA[0];
    const da = al - cand.labA[1] * w;
    const db = bl - cand.labA[2] * w;
    return { d: dl * dl + da * da + db * db, t: 0 };
  }
  const pl = L - cand.labA[0];
  const pa = al - cand.labA[1] * w;
  const pb = bl - cand.labA[2] * w;
  const ax = cand.ab[0];
  const ay = cand.ab[1] * w;
  const az = cand.ab[2] * w;
  const len2 = ax * ax + ay * ay + az * az;
  const t = len2 < 1e-12 ? 0 : clamp01((pl * ax + pa * ay + pb * az) / len2);
  const ql = pl - ax * t;
  const qa = pa - ay * t;
  const qb = pb - az * t;
  return { d: ql * ql + qa * qa + qb * qb, t };
}

/**
 * Score every candidate for one cell.
 *
 * `pixels` holds the cell's source colours in OKLab (3 floats each), and
 * `hist` counts them binned to the nearest palette colour. Always score the
 * actual pixels rather than only the histogram: a flat cell whose colour is not
 * in the palette bins to one entry, and then every pair containing that entry
 * ties at zero, which picks the first candidate (usually black) by accident.
 *
 * - smart      dithering-aware: squared distance to the segment between the two
 *              colours, i.e. assuming any mix ratio is reachable.
 * - exhaustive plain two-colour fit, no mixing: contrasty and crisp.
 * - frequency  the cell's two most common nearest colours (the raytracer
 *              approach): cheap and good on flat art.
 * - average    fit the cell mean exactly: smooth, terrible for text.
 */
function scoreCell(
  candidates: Candidate[],
  pixels: Float32Array,
  hist: Int32Array,
  meanL: number,
  meanA: number,
  meanB: number,
  opts: ConvertOptions,
): { a: number; b: number; score: number } {
  const present: number[] = [];
  for (let i = 0; i < hist.length; i++) if (hist[i] > 0) present.push(i);

  // Chroma weighting: 1 is plain OKLab distance, above 1 favours hue/saturation
  // accuracy over small lightness errors.  Squared, because the score is a sum
  // of squared distances.
  const w = Math.pow(clamp(opts.chromaWeight ?? 1, 1, 4), 2);

  let bestScore = Infinity;
  let bestA = 0;
  let bestB = 0;
  const singleBias = clamp(opts.singleBias, 0, 1);

  for (const c of candidates) {
    let score: number;

    switch (opts.method) {
      case 'average':
        score = segDist2(meanL, meanA, meanB, c, w).d * CELL_PX;
        break;

      case 'exhaustive': {
        score = 0;
        for (let i = 0; i < CELL_PX; i++) {
          const l = pixels[i * 3];
          const a = pixels[i * 3 + 1];
          const b = pixels[i * 3 + 2];
          const da = (l - c.labA[0]) ** 2 + w * ((a - c.labA[1]) ** 2 + (b - c.labA[2]) ** 2);
          const db = (l - c.labB[0]) ** 2 + w * ((a - c.labB[1]) ** 2 + (b - c.labB[2]) ** 2);
          score += Math.min(da, db);
        }
        break;
      }

      case 'frequency': {
        let covered = 0;
        for (const p of present) if (p === c.a || p === c.b) covered += hist[p];
        // Coverage dominates; the dither distance breaks ties so flat cells
        // still prefer the right pair.
        score = (CELL_PX - covered) * 0.05 + segDist2(meanL, meanA, meanB, c, w).d;
        break;
      }

      default: {
        score = 0;
        for (let i = 0; i < CELL_PX; i++) {
          score += segDist2(pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2], c, w).d;
        }
        break;
      }
    }

    score *= c.single ? 1 - singleBias * 0.55 : 1 + singleBias * 0.45;

    // Prefer a solid colour unless the second colour genuinely earns its keep.
    // Without this, a flat cell ties between "blue" and "black + blue" (both
    // reach it exactly) and candidate order decides, which is what turns flat
    // skies into black speckle. A small cost proportional to segment length
    // breaks the tie towards the solid colour, but a real gradient more than
    // repays it.
    if (!c.single) score += c.len2 * CELL_PX * 0.02;

    if (score < bestScore) {
      bestScore = score;
      bestA = c.a;
      bestB = c.b;
    }
  }

  return { a: bestA, b: bestB, score: bestScore };
}

/**
 * Second pass: if a neighbouring cell's pair is nearly as good for this cell,
 * reuse it. Fewer distinct attribute bytes means fewer clashes across cell
 * borders and a calmer image, which is what most good ZX converters do.
 *
 * `cells` restricts the pass to the cells a layer governs.
 */
function applyCohesion(
  pairA: Uint8Array,
  pairB: Uint8Array,
  score: Float32Array,
  prepared: Prepared,
  cells: number[],
): void {
  const { layer, lab, candidates } = prepared;
  const opts = layer.options;
  const byPair = new Map<number, Candidate>();
  for (const c of candidates) byPair.set(c.a * 15 + c.b, c);

  // Mean colour per cell, computed once.
  const means = new Float32Array(NCEL * 3);
  for (const ci of cells) {
    const cy = (ci / COLS) | 0;
    const cx = ci % COLS;
    let ml = 0;
    let ma = 0;
    let mb = 0;
    for (let py = 0; py < CELL_H; py++) {
      const row = (cy * CELL_H + py) * SCREEN_W;
      for (let px = 0; px < CELL_W; px++) {
        const i = (row + cx * CELL_W + px) * 3;
        ml += lab[i];
        ma += lab[i + 1];
        mb += lab[i + 2];
      }
    }
    const o = ci * 3;
    means[o] = ml / CELL_PX;
    means[o + 1] = ma / CELL_PX;
    means[o + 2] = mb / CELL_PX;
  }

  const originalA = new Uint8Array(pairA);
  const originalB = new Uint8Array(pairB);
  const tolerance = 1 + clamp(opts.cohesion, 0, 1) * 0.9;

  for (const ci of cells) {
    const cy = (ci / COLS) | 0;
    const cx = ci % COLS;
    const mo = ci * 3;
    const mL = means[mo];
    const mA = means[mo + 1];
    const mB = means[mo + 2];

    let best = score[ci];
    const limit = best * tolerance;
    let ba = pairA[ci];
    let bb = pairB[ci];

    const neigh: number[] = [];
    if (cx > 0) neigh.push(ci - 1);
    if (cy > 0) neigh.push(ci - COLS);
    if (cx > 0 && cy > 0) neigh.push(ci - COLS - 1);
    if (cx < COLS - 1 && cy > 0) neigh.push(ci - COLS + 1);

    for (const n of neigh) {
      const na = originalA[n];
      const nb = originalB[n];
      if (na === ba && nb === bb) continue;
      const cand = byPair.get(na * 15 + nb);
      if (!cand) continue;
      const s = segDist2(mL, mA, mB, cand, prepared.layer.options.chromaWeight ?? 1).d * CELL_PX;
      if (s <= limit && s < best) {
        best = s;
        ba = cand.a;
        bb = cand.b;
      }
    }

    pairA[ci] = ba;
    pairB[ci] = bb;
    score[ci] = best;
  }
}

// ---------------------------------------------------------------------------
// Dithering

function ditherPixels(
  prepared: Prepared,
  pairA: Uint8Array,
  pairB: Uint8Array,
  cellOwner: Int16Array,
  region: Int32Array,
  out: Uint8Array,
): void {
  const { layer, lab, candidates } = prepared;
  const opts = layer.options;
  const byPair = new Map<number, Candidate>();
  for (const c of candidates) byPair.set(c.a * 15 + c.b, c);

  const ordered = isOrdered(opts.dither);
  const kernel = kernelFor(opts.dither);
  const strength = clamp(opts.ditherStrength, 0, 2);

  // The dither method is a per-cell decision, since a cell has one attribute;
  // the choice comes from whichever layer governs that cell. Pixels are still
  // visited in screen order so ordered matrices stay aligned to the grid.
  if (ordered || !kernel) {
    for (const pi of region) {
      const y = (pi / SCREEN_W) | 0;
      const x = pi - y * SCREEN_W;
      const ci = (y >> 3) * COLS + (x >> 3);
      const cand = byPair.get(pairA[ci] * 15 + pairB[ci]);
      out[pi] = cand ? orderedPick(cand, x, y, opts, lab, strength) : pairA[ci];
    }
    return;
  }

  // Error diffusion, carried along each cell's own colour axis: a cell can only
  // express a mix of its two colours, so diffuse a single scalar per pixel.
  // Error deliberately crosses region borders: that is what stops a dithered
  // region from ending in a hard seam against its neighbour.
  const tbuf = new Float32Array(NPX);
  for (const pi of region) {
    const y = (pi / SCREEN_W) | 0;
    const x = pi - y * SCREEN_W;
    const ci = (y >> 3) * COLS + (x >> 3);
    const cand = byPair.get(pairA[ci] * 15 + pairB[ci]);
    tbuf[pi] = cand ? projection(cand, lab[pi * 3], lab[pi * 3 + 1], lab[pi * 3 + 2]) : 0;
  }
  const inside = new Uint8Array(NPX);
  for (const pi of region) inside[pi] = 1;

  for (let y = 0; y < SCREEN_H; y++) {
    // Serpentine scan: alternating direction breaks up directional worming.
    const dir = (y & 1) === 1 ? -1 : 1;
    const xStart = dir === 1 ? 0 : SCREEN_W - 1;
    const xEnd = dir === 1 ? SCREEN_W : -1;
    for (let x = xStart; x !== xEnd; x += dir) {
      const pi = y * SCREEN_W + x;
      if (!inside[pi]) continue;
      const ci = (y >> 3) * COLS + (x >> 3);
      const cand = byPair.get(pairA[ci] * 15 + pairB[ci]);
      if (!cand) {
        out[pi] = pairA[ci];
        continue;
      }
      if (cand.single) {
        out[pi] = cand.a;
        tbuf[pi] = 0;
        continue;
      }

      const t = tbuf[pi];
      const chooseB = t > 0.5;
      out[pi] = chooseB ? cand.b : cand.a;
      const err = (t - (chooseB ? 1 : 0)) * strength;

      for (const [dx, dy, w] of kernel) {
        const nx = x + dx * dir;
        const ny = y + dy;
        if (nx < 0 || nx >= SCREEN_W || ny >= SCREEN_H) continue;
        tbuf[ny * SCREEN_W + nx] += err * w;
      }
    }
  }
  void cellOwner;
}

/** Position of a colour along a candidate's segment, in 0..1. */
function projection(cand: Candidate, L: number, A: number, B: number): number {
  if (cand.single || cand.len2 < 1e-12) return 0;
  const pl = L - cand.labA[0];
  const pa = A - cand.labA[1];
  const pb = B - cand.labA[2];
  return clamp01((pl * cand.ab[0] + pa * cand.ab[1] + pb * cand.ab[2]) / cand.len2);
}

function orderedPick(
  cand: Candidate,
  x: number,
  y: number,
  opts: ConvertOptions,
  lab: Float32Array,
  strength: number,
): number {
  if (cand.single) return cand.a;
  let t = 0;
  if (cand.len2 >= 1e-12) {
    const i = (y * SCREEN_W + x) * 3;
    const pl = lab[i] - cand.labA[0];
    const pa = lab[i + 1] - cand.labA[1];
    const pb = lab[i + 2] - cand.labA[2];
    t = (pl * cand.ab[0] + pa * cand.ab[1] + pb * cand.ab[2]) / cand.len2;
  }
  t = (t - 0.5) * strength + 0.5;
  return t > thresholdAt(opts.dither, x, y) ? cand.b : cand.a;
}

/**
 * Optional pre-pass: snap the source onto the allowed palette with an ordered
 * dither, before cells are fitted. This mimics the old school pipeline (a
 * quantised source, then cell fitting) and can clean up noisy scans, but it
 * throws away tone, so it is off by default.
 */
function preQuantise(rgb: Float32Array, opts: ConvertOptions): void {
  const allowed = allowedIndices(opts);
  if (allowed.length <= 1) return;
  const strength = clamp(opts.ditherStrength, 0, 2);
  // A one-step jitter is what ordered dithering needs: enough to push a colour
  // over the boundary between two palette entries, not enough to flood it.
  const jitter = (strength * 0.45) / allowed.length;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      const t = (thresholdAt(opts.preDither, x, y) - 0.5) * jitter;
      const r = clamp01(rgb[i] + t);
      const g = clamp01(rgb[i + 1] + t);
      const b = clamp01(rgb[i + 2] + t);
      let best = allowed[0];
      let bestD = Infinity;
      for (const p of allowed) {
        const dr = r - PALETTE_F[p * 3];
        const dg = g - PALETTE_F[p * 3 + 1];
        const db = b - PALETTE_F[p * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      rgb[i] = PALETTE_F[best * 3];
      rgb[i + 1] = PALETTE_F[best * 3 + 1];
      rgb[i + 2] = PALETTE_F[best * 3 + 2];
    }
  }
}
