/**
 * Layer tests: ownership, per-layer treatment, masks, serialisation, and the
 * invariants that still have to hold when several layers share one screen.
 */
import { convert } from '../src/core/convert';
import { DEFAULT_OPTIONS } from '../src/core/defaults';
import {
  NPX,
  createBaseLayer,
  createLayer,
  deserialiseLayers,
  fillMask,
  invertMask,
  packMask,
  serialiseLayers,
  stamp,
  stroke,
  unpackMask,
} from '../src/core/layers';
import { PALETTE, SCREEN_H, SCREEN_W, attributeFromByte } from '../src/core/palette';
import { toScr } from '../src/core/export';
import { exportState, importState } from '../src/ui/state';

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

function gradient(): Uint8Array {
  const out = new Uint8Array(NPX * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const i = (y * SCREEN_W + x) * 3;
      out[i] = (x / SCREEN_W) * 255;
      out[i + 1] = (y / SCREEN_H) * 255;
      out[i + 2] = 128;
    }
  }
  return out;
}

const src = gradient();

/** Every cell must only use its attribute's two colours, in one palette half. */
function attributeProblems(result: ReturnType<typeof convert>): string[] {
  const problems: string[] = [];
  for (let cy = 0; cy < 24; cy++) {
    for (let cx = 0; cx < 32; cx++) {
      const ci = cy * 32 + cx;
      const a = attributeFromByte(result.attr[ci]);
      const codeOf = (code: number, bright: boolean) =>
        PALETTE.findIndex((p) => p.code === code && (code === 0 ? !p.bright : p.bright === bright));
      const ink = PALETTE[codeOf(a.ink, a.bright)];
      const paper = PALETTE[codeOf(a.paper, a.bright)];
      if (!ink || !paper) {
        problems.push(`cell ${cx},${cy}: colour missing`);
        continue;
      }
      if (ink.bright !== paper.bright && ink.code !== 0 && paper.code !== 0) {
        problems.push(`cell ${cx},${cy}: mixed palette halves`);
      }
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const p = PALETTE[result.pixelIdx[(cy * 8 + py) * SCREEN_W + cx * 8 + px]];
          const ok = (p.code === a.ink || p.code === a.paper) && (p.code === 0 || p.bright === a.bright);
          if (!ok) problems.push(`cell ${cx},${cy}: pixel not in attribute`);
        }
      }
    }
  }
  return problems;
}

// --- masks ---------------------------------------------------------------
{
  const mask = fillMask(1);
  check(mask.length === NPX, 'mask has one byte per pixel');
  check(mask.every((v) => v === 1), 'fillMask fills');
  invertMask(mask);
  check(mask.every((v) => v === 0), 'invertMask clears');

  const packed = packMask(fillMask(1));
  const back = unpackMask(packed);
  check(back !== null && back.every((v) => v === 1), 'mask packs and unpacks losslessly');

  // A stroke must actually mark pixels around its path.
  const painted = new Uint8Array(NPX);
  stroke(painted, 40, 40, 120, 90, { radius: 6, value: 1, hardness: 1 });
  check(painted.some((v) => v === 1), 'stroke paints');
  const at = (x: number, y: number) => painted[y * SCREEN_W + x];
  check(at(40, 40) === 1 && at(80, 65) === 1, 'stroke covers its endpoints and middle');
  check(at(200, 150) === 0, 'stroke leaves the rest alone');

  // Erasing with the same brush undoes it.
  stroke(painted, 40, 40, 120, 90, { radius: 8, value: 0, hardness: 1 });
  check(at(80, 65) === 0, 'erasing clears painted pixels');
}

// --- ownership -----------------------------------------------------------
{
  const base = createBaseLayer();
  const top = createLayer('Top', { contrast: 0.3 }, new Uint8Array(NPX));
  stamp(top.mask!, 64, 48, { radius: 20, value: 1, hardness: 1 });

  const result = convert(src, [base, top], 1);
  const topPixels = result.stats.layers.find((l) => l.name === 'Top')!.pixels;
  check(topPixels > 0, 'top layer owns pixels');
  check(result.stats.layers[0].pixels + topPixels === NPX, 'layers partition the screen');

  // A painted region must come out differently from the same region without it.
  const flatOnly = convert(src, [base, createLayer('Empty')], 1);
  let diff = 0;
  for (let i = 0; i < NPX; i++) if (result.pixelIdx[i] !== flatOnly.pixelIdx[i]) diff++;
  check(diff > 0, 'the masked layer actually changed the result');
}

// --- invisible layers are ignored ---------------------------------------
{
  const base = createBaseLayer();
  const hidden = createLayer('Hidden', { contrast: 0.5 }, fillMask(1));
  hidden.visible = false;
  const withHidden = convert(src, [base, hidden], 1);
  const without = convert(src, [base], 1);
  check(
    withHidden.stats.meanError === without.stats.meanError,
    'an invisible layer must not affect the result',
  );
}

// --- a full-screen layer on top wins completely --------------------------
{
  const base = createBaseLayer();
  const top = createLayer('Over', { saturation: 0, method: 'exhaustive', dither: 'none' }, fillMask(1));
  const result = convert(src, [base, top], 1);
  const over = result.stats.layers.find((l) => l.name === 'Over')!;
  check(over.pixels === NPX, `top layer should own everything, got ${over.pixels}`);

  // Grey-only pipeline: no saturated colours should survive.
  const problems = attributeProblems(result);
  for (const p of problems.slice(0, 2)) check(false, p);
}

// --- invariants still hold with several layers ---------------------------
{
  const base = createBaseLayer({ dither: 'bayer8' });
  const a = createLayer('A', { dither: 'floyd', contrast: 0.4 }, new Uint8Array(NPX));
  const b = createLayer('B', { dither: 'atkinson', brightMode: 'bright' }, new Uint8Array(NPX));
  stamp(a.mask!, 60, 60, { radius: 30, value: 1, hardness: 1 });
  stamp(b.mask!, 190, 130, { radius: 35, value: 1, hardness: 1 });

  const result = convert(src, [base, a, b], 1);
  const problems = attributeProblems(result);
  for (const p of problems.slice(0, 3)) check(false, p);
  check(problems.length === 0, `layered result broke attribute rules (${problems.length} cells)`);

  const scr = toScr(result);
  check(scr.length === 6912, '.scr is still 6912 bytes with layers');
}

// --- serialisation round-trip -------------------------------------------
{
  const layers = [createBaseLayer(), createLayer('Painted', { gamma: 1.4 }, new Uint8Array(NPX))];
  stroke(layers[1].mask!, 10, 10, 200, 20, { radius: 5, value: 1, hardness: 1 });

  const stored = serialiseLayers(layers);
  const back = deserialiseLayers(stored);
  check(back.length === 2, 'both layers survive a round trip');
  check(back[1].mask !== null && back[1].mask.every((v, i) => v === layers[1].mask![i]), 'mask survives');
  check(back[1].options.gamma === 1.4, 'options survive');
  check(back[0].mask === null, 'the background layer stays maskless');
}

// --- messy ownership: nothing may be left unrendered ---------------------
{
  // Every layer has a sparse mask; the gaps have to fall through to the base.
  const base = createBaseLayer();
  const a = createLayer('A', { contrast: 0.5 }, new Uint8Array(NPX));
  stamp(a.mask!, 100, 100, { radius: 12, value: 1, hardness: 0.5 });
  const result = convert(src, [base, a], 1);
  const owned = result.stats.layers.reduce((n, l) => n + l.pixels, 0);
  check(owned === NPX, `every pixel must have an owner, got ${owned}/${NPX}`);
  check(result.pixelIdx.some((v) => v !== result.pixelIdx[0]), 'gaps are rendered, not left at 0');
}

// --- disallowing single-colour cells must not invent pixels -------------
{
  // A colour that sits exactly on a palette entry collapses every cell onto
  // one colour. Turning the option off must give a real two-colour attribute
  // without scattering stray pixels to force a pattern.
  const flatSrc = new Uint8Array(NPX * 3);
  for (let i = 0; i < NPX; i++) {
    flatSrc[i * 3] = 0;
    flatSrc[i * 3 + 1] = 215;
    flatSrc[i * 3 + 2] = 0;
  }

  const allowed = convert(flatSrc, { ...DEFAULT_OPTIONS, dither: 'none', preQuantize: false, allowSingleColour: true }, 1);
  const forced = convert(flatSrc, { ...DEFAULT_OPTIONS, dither: 'none', preQuantize: false, allowSingleColour: false }, 1);

  check(allowed.stats.singleColourCells === 768, 'a flat on-palette colour collapses when allowed');
  check(forced.stats.singleColourCells === 0, 'no cell collapses when single-colour cells are disallowed');
  check(forced.cellA[0] !== forced.cellB[0], 'the forced pair is genuinely two colours');

  // The rendered pixels must stay uniform: no lonely dots anywhere.
  const lonely = (r: ReturnType<typeof convert>) => {
    let n = 0;
    for (let y = 1; y < SCREEN_H - 1; y++) {
      for (let x = 1; x < SCREEN_W - 1; x++) {
        const p = r.pixelIdx[y * SCREEN_W + x];
        const same = (dx: number, dy: number) => r.pixelIdx[(y + dy) * SCREEN_W + x + dx] === p;
        if (!same(-1, 0) && !same(1, 0) && !same(0, -1) && !same(0, 1)) n++;
      }
    }
    return n;
  };
  check(lonely(forced) === 0, `forcing two colours must not scatter stray pixels, got ${lonely(forced)}`);

  // And the attribute rules still hold.
  for (const prob of attributeProblems(forced).slice(0, 2)) check(false, prob);
}

// --- attribute / bitmap compositing -------------------------------------
{
  // Two full-screen layers: one high-contrast greyscale, one colourful with
  // a different dither. Borrowing attributes must change the colours used
  // while leaving the dither pattern alone, and vice versa.
  const base = createLayer('Base', { dither: 'none', method: 'exhaustive', saturation: 0, contrast: 0.4 }, fillMask(1));
  const top = createLayer('Top', { dither: 'bayer8', saturation: 1.6, temperature: 0.4 }, fillMask(1));

  const own = convert(src, [base, top], 1);

  // Attributes from the base (greyscale pair), pixels from the top layer.
  const borrowAttrs = { ...top, blend: 'attributes' as const, blendWith: base.id };
  const attrsResult = convert(src, [base, borrowAttrs], 1);
  check(
    attrsResult.pixelIdx.some((v, i) => v !== own.pixelIdx[i]),
    'borrowing attributes changes the result',
  );

  // The pixel *pattern* should follow the donor's approach: with a greyscale
  // donor and a colourful layer, the colours must desaturate.
  const colourCount = (r: ReturnType<typeof convert>) => {
    const s = new Set<number>();
    for (const v of r.pixelIdx) s.add(v);
    return s.size;
  };
  check(
    colourCount(attrsResult) <= colourCount(own),
    `borrowed attributes should not add colours (own ${colourCount(own)}, borrowed ${colourCount(attrsResult)})`,
  );

  // Bitmap borrowing the other way must also differ, and still be valid.
  const borrowBitmap = { ...top, blend: 'bitmap' as const, blendWith: base.id };
  const bitmapResult = convert(src, [base, borrowBitmap], 1);
  check(
    bitmapResult.pixelIdx.some((v, i) => v !== own.pixelIdx[i]),
    'borrowing the bitmap changes the result',
  );
  for (const p of attributeProblems(bitmapResult).slice(0, 2)) check(false, p);
  for (const p of attributeProblems(attrsResult).slice(0, 2)) check(false, p);

  // A dangling reference must fall back to normal behaviour, not throw.
  const dangling = { ...top, blend: 'attributes' as const, blendWith: 'does-not-exist' };
  const fallback = convert(src, [base, dangling], 1);
  check(fallback.pixelIdx.length === NPX, 'a missing donor falls back safely');

  // And the blend survives a save/load round trip.
  const stored = serialiseLayers([base, borrowAttrs]);
  const reloaded = deserialiseLayers(stored);
  check(reloaded[1].blend === 'attributes', 'blend mode survives serialisation');
  check(reloaded[1].blendWith === base.id, 'blend donor survives serialisation');
}

// --- portable state files -----------------------------------------------
{
  const wsLayers = [createBaseLayer(), createLayer('Painted', { gamma: 1.4 }, new Uint8Array(NPX))];
  stroke(wsLayers[1].mask!, 10, 10, 200, 20, { radius: 5, value: 1, hardness: 1 });
  const ws = {
    layers: wsLayers,
    source: { fit: 'fill' as const, zoom: 1.75, offsetX: 0.2, offsetY: -0.1, background: [0, 0, 0] as [number, number, number], smooth: 2 },
    selectedId: wsLayers[1].id,
  };
  const file = exportState(ws, { name: 'pic.png', dataUrl: 'data:image/png;base64,AAAA' });
  const text = JSON.stringify(file);
  const back = importState(text);

  check(back.workspace.layers.length === 2, 'state file keeps every layer');
  check(back.workspace.selectedId === wsLayers[1].id, 'state file keeps the selection');
  check(back.workspace.source.zoom === 1.75, 'state file keeps framing');
  check(
    back.workspace.layers[1].mask !== null &&
      back.workspace.layers[1].mask!.every((v, i) => v === wsLayers[1].mask![i]),
    'state file keeps painted masks',
  );
  check(back.workspace.layers[1].options.gamma === 1.4, 'state file keeps per-layer options');
  check(back.image?.name === 'pic.png', 'state file carries the source image');

  // and it must actually convert
  const result = convert(src, back.workspace.layers, 1);
  check(toScr(result).length === 6912, 'a loaded state converts');

  // a file from somewhere else is rejected with a clear message
  let rejected = false;
  try {
    importState('{"format":"something-else"}');
  } catch {
    rejected = true;
  }
  check(rejected, 'foreign JSON is rejected');
  let rejectedGarbage = false;
  try {
    importState('not json at all');
  } catch {
    rejectedGarbage = true;
  }
  check(rejectedGarbage, 'garbage is rejected');
}

console.log(failures.length ? '' : 'Layer checks passed.');
if (failures.length) {
  console.error('Layer checks failed:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
void DEFAULT_OPTIONS;
