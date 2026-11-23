/**
 * Measures the real rendered page, because "too much scrolling" is a layout
 * fact and not something to reason about from CSS. Also captures a screenshot
 * so the result can be looked at.
 */
import { chromium } from 'playwright';

const BASE = process.env.SCREENER_URL ?? 'http://localhost:6912/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE, { waitUntil: 'networkidle' });

// Start clean, then load a real picture so the layout is measured in its
// populated state rather than with empty canvases.
await page.evaluate(() => window.localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
const sample = await page.request.get(new globalThis.URL('samples/photo.png', BASE).href);
await page.setInputFiles('#file-input', {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: await sample.body(),
});
// Wait for a conversion to finish rather than guessing a delay.
// The canvas starts as an empty grid overlay, so wait for actual colour rather
// than mere non-black pixels, and give the worker time to finish.
await page.waitForFunction(
  () => {
    const c = document.querySelector<HTMLCanvasElement>('#out-canvas');
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24) return true;
    }
    return false;
  },
  { timeout: 20000 },
);
await page.waitForTimeout(600);

const metrics = await page.evaluate(() => {
  const doc = document.documentElement;
  const stage = document.querySelector('.stage') as HTMLElement | null;
  const workspace = document.querySelector('.workspace') as HTMLElement | null;
  const controls = document.querySelector('.controls-panel') as HTMLElement | null;
  const layers = document.querySelector('.layers-panel') as HTMLElement | null;
  const groups = Array.from(document.querySelectorAll('.group')).map((g) => {
    const r = g.getBoundingClientRect();
    return {
      title: g.querySelector('h2')?.textContent ?? '?',
      top: Math.round(r.top),
      height: Math.round(r.height),
      width: Math.round(r.width),
    };
  });
  return {
    pageHeight: doc.scrollHeight,
    viewportHeight: window.innerHeight,
    stageHeight: stage ? Math.round(stage.getBoundingClientRect().height) : 0,
    workspaceTop: workspace ? Math.round(workspace.getBoundingClientRect().top) : 0,
    workspaceHeight: workspace ? Math.round(workspace.getBoundingClientRect().height) : 0,
    controlsHeight: controls ? Math.round(controls.getBoundingClientRect().height) : 0,
    layersHeight: layers ? Math.round(layers.getBoundingClientRect().height) : 0,
    groups,
  };
});

if (errors.length) console.log('CONSOLE ERRORS:\n  ' + errors.join('\n  '));
console.log(`viewport ${metrics.viewportHeight}px, page ${metrics.pageHeight}px`);
console.log(`stage ${metrics.stageHeight}px, workspace starts at ${metrics.workspaceTop}px`);
console.log(`workspace ${metrics.workspaceHeight}px (layers ${metrics.layersHeight}, controls ${metrics.controlsHeight})`);
console.log('groups:');
// Group by row so the column layout is visible.
const rows = new Map<number, { title: string; width: number }[]>();
for (const g of metrics.groups) {
  const list = rows.get(g.top) ?? [];
  list.push({ title: g.title, width: g.width });
  rows.set(g.top, list);
}
for (const [top, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  y=${top}  ${list.map((g) => `${g.title}(${g.width})`).join(' | ')}`);
}
const overflow = metrics.pageHeight - metrics.viewportHeight;
console.log(overflow > 0 ? `\nNEEDS ${overflow}px OF SCROLL at 1440x900` : '\nfits without scrolling at 1440x900');

await page.screenshot({ path: 'bench/layout-1440.png', fullPage: true });

// A narrower window, which is where scrolling hurts most.
await page.setViewportSize({ width: 1280, height: 800 });
const narrow = await page.evaluate(() => ({
  page: document.documentElement.scrollHeight,
  viewport: window.innerHeight,
}));
console.log(
  narrow.page > narrow.viewport
    ? `at 1280x800: needs ${narrow.page - narrow.viewport}px of scroll`
    : 'at 1280x800: fits',
);
await page.screenshot({ path: 'bench/layout-1280.png', fullPage: true });

await browser.close();
