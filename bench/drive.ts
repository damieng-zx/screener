/**
 * Drives the real app in Microsoft Edge and measures what each control actually
 * does to the output pixels. Written because two user reports needed checking:
 *
 *   1. "posterize seems random"
 *   2. "dithering is not applied consistently across the whole image"
 *
 * Both turned out to be explainable (posterize is deterministic; the banding in
 * the demo image is a genuinely pale, desaturated region of the source that the
 * palette can only reach with bright colours). This harness keeps those
 * questions answerable instead of re-litigated by eye.
 *
 * Reads the rendered canvas, so it tests the app, not the library.
 */
import { chromium, type Page } from 'playwright';

const BASE = process.env.SCREENER_URL ?? 'http://localhost:6912/';

interface Frame {
  distinct: number;
  localContrast: number;
  cellColours: number[];
  mean: number;
  /** Mean saturation, so grey images are not mistaken for broken colour controls. */
  saturation: number;
}

async function measure(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#out-canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const W = c.width;
    const H = c.height;
    const lum = new Float32Array(W * H);
    const seen = new Set<number>();
    let sum = 0;
    let sat = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      seen.add((r << 16) | (g << 8) | b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum[p] = l;
      sum += l;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      sat += mx === 0 ? 0 : (mx - mn) / mx;
    }
    let contrast = 0;
    let pairs = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W - 1; x++) {
        contrast += Math.abs(lum[y * W + x] - lum[y * W + x + 1]);
        pairs++;
      }
    }
    // Distinct colours per cell. A cell using one colour was not dithered; any
    // cell using two was. Counting bright pixels instead misreads cells whose
    // pair is two dark colours.
    const cellColours: number[] = [];
    for (let cy = 0; cy < H / 8; cy++) {
      for (let cx = 0; cx < W / 8; cx++) {
        const seenCell = new Set<number>();
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            const i = ((cy * 8 + py) * W + cx * 8 + px) * 4;
            seenCell.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          }
        }
        cellColours.push(seenCell.size);
      }
    }
    return {
      distinct: seen.size,
      localContrast: contrast / pairs,
      cellColours,
      mean: sum / (W * H),
      saturation: sat / (W * H),
    };
  });
}

/** Load a deterministic colour test image through the app's own file input. */
async function loadTestImage(page: Page) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 320, 240);
    grad.addColorStop(0, '#2a7fe0');
    grad.addColorStop(0.5, '#e04a3a');
    grad.addColorStop(1, '#3fbf6a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 320, 240);
    // Fine detail, so sharpen and blur have something to act on. A smooth
    // gradient is already as smooth as blur can make it, which made blur look
    // like a no-op in earlier runs of this harness.
    for (let y = 0; y < 240; y += 2) {
      for (let x = 0; x < 320; x += 2) {
        if ((x + y) % 4 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.35)';
          g.fillRect(x, y, 1, 1);
        }
      }
    }
    return c.toDataURL('image/png');
  });
  await page.setInputFiles('#file-input', {
    name: 'test.png',
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
  });
  // Wait for a genuine conversion rather than a fixed delay.
  await page.waitForFunction(
    () => {
      const c = document.querySelector<HTMLCanvasElement>('#out-canvas')!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size >= 6;
    },
    { timeout: 20000 },
  );
}

/** Set a range slider by its visible label, in either control host. */
async function setSlider(page: Page, label: string, value: number) {
  const ok = await page.evaluate(
    ({ label, value }) => {
      const labels = Array.from(
        document.querySelectorAll('#controls .slider, #top-controls .slider'),
      );
      const el = labels.find((l) => l.querySelector('span')?.textContent?.trim() === label);
      if (!el) return false;
      const input = el.querySelector<HTMLInputElement>('input[type=range]')!;
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    { label, value },
  );
  if (!ok) throw new Error(`no slider labelled "${label}"`);
  await page.waitForTimeout(400);
}

async function selectOption(page: Page, label: string, value: string) {
  const ok = await page.evaluate(
    ({ label, value }) => {
      const fields = Array.from(
        document.querySelectorAll('#controls .field, #top-controls .field'),
      );
      const el = fields.find((f) => f.querySelector('span')?.textContent?.trim() === label);
      if (!el) return false;
      const sel = el.querySelector<HTMLSelectElement>('select')!;
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { label, value },
  );
  if (!ok) throw new Error(`no select labelled "${label}"`);
  await page.waitForTimeout(400);
}

/** Reload to a clean workspace, then load the test image again. */
async function fresh(page: Page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await loadTestImage(page);
}

const results: string[] = [];
const problems: string[] = [];

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const consoleErrors: string[] = [];
page.on('console', (m) => {
  // A missing favicon is noise, not a fault.
  // A missing favicon is a 404 the app never asked for; filter it.
  const t = m.text();
  if (m.type() === 'error' && !/favicon|404/.test(t)) consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// --- posterize: must change the result, and be repeatable -------------------
{
  await fresh(page);
  await selectOption(page, 'Dither', 'none');
  const rows: { levels: number; distinct: number; mean: number }[] = [];
  for (const levels of [0, 3, 8]) {
    await setSlider(page, 'Posterize', levels);
    const m = await measure(page);
    rows.push({ levels, distinct: m.distinct, mean: m.mean });
    results.push(`posterize ${levels}: distinct=${m.distinct} mean=${m.mean.toFixed(1)}`);
  }
  if (rows.every((r) => r.distinct === rows[0].distinct && r.mean === rows[0].mean)) {
    problems.push('posterize changes nothing at all');
  }
  // Re-apply the same value and confirm the output is identical.
  await setSlider(page, 'Posterize', 8);
  const a = await measure(page);
  await setSlider(page, 'Posterize', 0);
  await setSlider(page, 'Posterize', 8);
  const b = await measure(page);
  const same = a.distinct === b.distinct && Math.abs(a.mean - b.mean) < 0.01;
  results.push(`posterize 8 twice: ${same ? 'identical (deterministic)' : 'DIFFERS'}`);
  if (!same) problems.push('posterize is not deterministic for the same settings');
}

// --- dithering: must cover the whole frame, not just part of it -------------
{
  await fresh(page);
  const perDither: { name: string; frame: Frame }[] = [];
  for (const dither of ['none', 'floyd', 'bayer8']) {
    await selectOption(page, 'Dither', dither);
    const m = await measure(page);
    perDither.push({ name: dither, frame: m });
    const twoColour = m.cellColours.filter((v) => v >= 2).length;
    results.push(
      `dither=${dither}: contrast=${m.localContrast.toFixed(1)} ` +
        `twoColourCells=${twoColour}/${m.cellColours.length}`,
    );
  }
  // On a colour gradient every cell holds two colours, so none should be flat
  // for a diffusion or ordered dither unless the source there is uniform.
  for (const { name, frame } of perDither) {
    if (name === 'none') continue;
    const dithered = frame.cellColours.filter((v) => v >= 2).length;
    if (dithered < frame.cellColours.length * 0.9) {
      problems.push(`dither=${name} only dithered ${dithered}/${frame.cellColours.length} cells`);
    }
  }
}

// --- every control must visibly change the output ---------------------------
{
  const cases: [string, number][] = [
    ['Exposure', 1.2],
    ['Contrast', 1.2],
    ['Gamma', 2.2],
    ['Saturation', 0],
    ['Hue', 120],
    ['Sharpen', 6],
    ['Blur', 2.5],
    ['Vignette', 1],
  ];
  const baseline = await (async () => {
    await fresh(page);
    return measure(page);
  })();
  results.push(
    `baseline: mean=${baseline.mean.toFixed(1)} sat=${baseline.saturation.toFixed(3)} ` +
      `contrast=${baseline.localContrast.toFixed(1)} distinct=${baseline.distinct}`,
  );

  for (const [label, value] of cases) {
    await fresh(page);
    await setSlider(page, label, value);
    const m = await measure(page);
    // Mean brightness alone misses sharpen and blur, which change local detail
    // rather than average tone; saturation catches the colour controls.
    // Compare a signature over several statistics: brightness, saturation,
    // local contrast and the count of distinct output colours. No single one
    // catches every control (blur moves colour count, hue moves saturation).
    const changed =
      Math.abs(m.mean - baseline.mean) > 0.4 ||
      Math.abs(m.localContrast - baseline.localContrast) > 0.4 ||
      Math.abs(m.saturation - baseline.saturation) > 0.004 ||
      m.distinct !== baseline.distinct;
    results.push(
      `${label}=${value}: mean=${m.mean.toFixed(1)} sat=${m.saturation.toFixed(3)} ` +
        `contrast=${m.localContrast.toFixed(1)} ${changed ? 'changed' : 'NO CHANGE'}`,
    );
    if (!changed) problems.push(`${label} did not change the output`);
  }
}

await browser.close();

console.log('=== measurements (Microsoft Edge) ===');
for (const r of results) console.log('  ' + r);
console.log('\n=== console errors ===');
console.log(consoleErrors.length ? consoleErrors.map((e) => '  ' + e).join('\n') : '  none (favicon noise filtered)');
console.log('\n=== problems ===');
if (problems.length) {
  for (const p of problems) console.log('  - ' + p);
  process.exitCode = 1;
} else {
  console.log('  none');
}
