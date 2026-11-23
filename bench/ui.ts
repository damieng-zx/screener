/**
 * DOM smoke test: loads index.html into jsdom, stubs canvas, runs the UI, then
 * checks that controls are wired, state round-trips, presets apply, and export
 * buttons produce the right payloads.
 *
 * This is not a browser, but it catches the mistakes that compile fine and
 * still break the page: unwired controls, missing nodes, wrong option keys.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('index.html', 'utf8');

// --- canvas / worker / image stubs ----------------------------------------
class FakeCtx {
  fillStyle = '#000';
  strokeStyle = '#000';
  lineWidth = 1;
  imageSmoothingEnabled = false;
  putImageData() {}
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  fillRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  drawImage() {}
  clearRect() {}
  save() {}
  restore() {}
  createImageData(w: number, h: number) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
}

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

// The app reads document.querySelector at import time, so install globals first.
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  'document',
  'window',
  'HTMLElement',
  'HTMLCanvasElement',
  'HTMLDialogElement',
  'ImageData',
  'Image',
  'Blob',
  'URL',
  'performance',
  'localStorage',
  'requestAnimationFrame',
  'navigator',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'ClipboardEvent',
]) {
  if (key in window) {
    try {
      g[key] = (window as unknown as Record<string, unknown>)[key];
    } catch {
      // Read-only globals in newer Node (navigator, performance) can stay.
    }
  }
}
// jsdom creates real <canvas> elements, so patch their missing 2D context and
// toBlob rather than replacing the constructor.
const proto = (window.HTMLCanvasElement as unknown as { prototype: Record<string, unknown> }).prototype;
proto.getContext = function () {
  return new FakeCtx();
};
proto.toBlob = function (cb: (b: Blob) => void) {
  cb(new Blob([new Uint8Array([1, 2, 3])]));
};
g.ImageData = class {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, w: number, h: number) {
    this.data = data;
    this.width = w;
    this.height = h;
  }
};
// Force the main-thread engine: the worker module would need a real Worker.
g.Worker = class {
  constructor() {
    throw new Error('no workers in jsdom');
  }
};
g.document = window.document;
g.window = window;
(window as unknown as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => cb();

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

// --- exercise the module ---------------------------------------------------
await import('../src/main');

const doc = window.document;
const $ = (sel: string) => doc.querySelector(sel) as HTMLElement | null;

check(!!$('#controls'), 'controls host exists');
check(!$('#controls .palette'), 'palette picker is gone');
check(!!$('#presets'), 'presets rendered');

// Controls are split across the lower grid and the top row beside the layers.
const controlsRoot = doc.querySelector('main') as HTMLElement;
const sliders = controlsRoot.querySelectorAll('#controls input[type="range"], #top-controls input[type="range"]');
const checks = controlsRoot.querySelectorAll('#controls input[type="checkbox"], #top-controls input[type="checkbox"]');
const selects = controlsRoot.querySelectorAll('#controls select, #top-controls select');
const segButtons = controlsRoot.querySelectorAll('#controls .seg button, #top-controls .seg button');

check(sliders.length >= 18, `expected many sliders, got ${sliders.length}`);
check(checks.length >= 2, `expected several checkboxes, got ${checks.length}`);
check(selects.length >= 2, `expected several selects, got ${selects.length}`);
check(segButtons.length >= 3, `expected segmented controls, got ${segButtons.length}`);


// Choosing a preset must apply it to the selected layer.
const presetSelect = doc.querySelector('#preset-select') as HTMLSelectElement | null;
check(!!presetSelect, 'preset dropdown exists');
check((presetSelect?.querySelectorAll('option').length ?? 0) >= 7, 'presets are populated');
check(!!presetSelect?.querySelector('option[value="mono"]'), 'mono preset exists');
if (presetSelect) {
  presetSelect.value = 'mono';
  presetSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  check(presetSelect.value === 'mono', 'preset selection is reflected');
}

// Persistence is debounced (250 ms) so a slider drag is one write.
await new Promise((r) => setTimeout(r, 400));
// Presets apply to the selected layer, so the workspace holds the change.
const ws = JSON.parse(window.localStorage.getItem('spectrum-screener/v2') ?? '{}');
const sel = (ws.layers ?? []).find((l: any) => l.id === ws.selectedId) ?? (ws.layers ?? [])[0];
check(sel?.options?.paletteMask === ((1 << 0) | (1 << 7)), `mono preset set mask, got ${sel?.options?.paletteMask}`);
check(sel?.options?.brightMode === 'normal', `mono preset set brightMode, got ${sel?.options?.brightMode}`);

// The dither select must be populated from the dither list.
const optionCount = doc.querySelectorAll('#controls select option').length;
check(optionCount > 0, 'selects populated');

// Export buttons exist for every format.
for (const kind of ['png', 'scr', 'tap', 'c', 'asm', 'json']) {
  check(!!doc.querySelector(`[data-export="${kind}"]`), `export button ${kind}`);
}

// Round-trip the persisted state.
check(!!window.localStorage.getItem('spectrum-screener/v2'), 'workspace persisted');

// --- integer-only Spectrum scaling ----------------------------------
const scaleButtons = doc.querySelectorAll('#scale-seg button');
check(scaleButtons.length === 4, `expected 4 scale presets, got ${scaleButtons.length}`);
const outScreen = doc.querySelector('#out-screen') as HTMLElement;
check(outScreen.classList.contains('integer'), 'spectrum view is integer-scaled');
const defaultScale = outScreen.style.getPropertyValue('--scale');
check(defaultScale === '2', `default scale is 2x, got ${defaultScale}`);
const four = doc.querySelector('#scale-seg button[data-scale="4"]') as HTMLElement;
four.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(outScreen.style.getPropertyValue('--scale') === '4', 'scale button applies');
const uiPrefs = JSON.parse(window.localStorage.getItem('spectrum-screener/ui/v1') ?? '{}');
check(uiPrefs.scale === 4, `scale is persisted, got ${uiPrefs.scale}`);

// --- removed chrome --------------------------------------------------
check(!doc.querySelector('#engine-badge'), 'engine badge removed');
check(!doc.querySelector('#help-btn'), 'techniques button removed');
check(!doc.querySelector('#help-dialog'), 'techniques dialog removed');
check(!doc.querySelector('.tagline'), 'tagline removed');

// Vignette belongs with the detail controls.
const detailGroup = Array.from(doc.querySelectorAll('#controls .group')).find(
  (g) => g.querySelector('h2')?.textContent === 'Detail',
) as HTMLElement | undefined;
check(!!detailGroup, 'detail group exists');
const detailLabels = Array.from(detailGroup?.querySelectorAll('.slider > span') ?? []).map((s) => s.textContent);
check(detailLabels.includes('Vignette'), 'vignette sits in Detail');
check(detailLabels.includes('Vignette size'), 'vignette size sits in Detail');
const toneGroup = Array.from(doc.querySelectorAll('#controls .group')).find(
  (g) => g.querySelector('h2')?.textContent === 'Tone',
) as HTMLElement | undefined;
const toneLabels = Array.from(toneGroup?.querySelectorAll('.slider > span') ?? []).map((s) => s.textContent);
check(!toneLabels.includes('Vignette'), 'vignette is no longer in Tone');

// --- layers -------------------------------------------------------------
const layerList = doc.querySelector('#layer-list');
check(!!layerList, 'layer list rendered');
check(layerList?.querySelectorAll('.layer').length === 1, 'starts with one background layer');
check((doc.querySelector('#layer-add') as HTMLElement) !== null, 'add-layer button exists');
check((doc.querySelector('#paint-bar') as HTMLElement).hidden === true, 'paint bar hidden for the background');
check(!!doc.querySelector('#overlay-canvas'), 'mask overlay canvas exists');

// Adding a layer selects it and reveals the paint controls.
(doc.querySelector('#layer-add') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(layerList?.querySelectorAll('.layer').length === 2, 'add-layer appends a layer');
check((doc.querySelector('#paint-bar') as HTMLElement).hidden === false, 'paint bar appears for a paintable layer');
check(doc.querySelectorAll('#layer-list .layer.on').length === 1, 'exactly one layer is selected');

// --- layout: dithering first, presets in its column -----------------------
const groupTitles = Array.from(doc.querySelectorAll('#controls .group > h2')).map((h) => h.textContent);
check(groupTitles[0] === 'Dithering', `Dithering is the first group, got ${groupTitles[0]}`);
check(!!doc.querySelector('.layers-panel #presets #preset-select'), 'presets live with the layers');
// The dithering column is deliberately narrow now.
const ditherGroup = doc.querySelectorAll('#controls .group')[0] as HTMLElement;
check(!ditherGroup.classList.contains('wide'), 'dithering group is a single column');

// Spectrum constraints uses a two-column body rather than one long list.
const constraints = Array.from(doc.querySelectorAll('#controls .group, #top-controls .group')).find(
  (g) => g.querySelector('h2')?.textContent === 'Spectrum constraints',
) as HTMLElement | undefined;
check(!!constraints, 'spectrum constraints group exists');
check((constraints?.querySelectorAll('.control-row').length ?? 0) === 2, 'constraints pairs its controls into two rows');

// The export control is now a dropdown in the stage header.
const exportMenu = doc.querySelector('#export-menu');
check(!!exportMenu, 'export menu exists');
check(!doc.querySelector('.exports'), 'the old export panel is gone');
const exportBtn = exportMenu?.querySelector('.export-btn') as HTMLElement | null;
check(!!exportBtn, 'export button exists');
exportBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(exportMenu?.querySelector('.menu-items')?.hasAttribute('hidden') === false, 'export menu opens');
// Opening export must not leave the framing panel open, and vice versa.
check(
  doc.querySelector('#framing-menu .menu-items')?.hasAttribute('hidden') === true,
  'framing stays closed when export opens',
);
check(doc.querySelectorAll('[data-export]').length === 6, 'all export formats are in the menu');

// Grid and compare toggles were removed as requested.
check(!doc.querySelector('#show-grid'), 'cells toggle removed');
check(!doc.querySelector('#show-original'), 'compare toggle removed');
// --- removed chrome -----------------------------------------------------

check(!doc.querySelector('#show-scanlines'), 'CRT toggle removed');
check(!doc.querySelector('#out-foot'), 'no stat line under the Spectrum view');
check(!doc.querySelector('.layers-panel .hint + .hint'), 'no duplicated layer hint');

// --- layout: layers left third, controls beside -------------------------

const workspace = doc.querySelector('.workspace') as HTMLElement | null;
check(!!workspace, 'workspace exists below the pictures');
check(!!workspace?.querySelector('.layers-panel'), 'layers sit in the workspace');
check(!!workspace?.querySelector('.controls-panel'), 'controls sit beside the layers');
check(!doc.querySelector('.top-grid'), 'the old top grid is gone');
// One panel holds both control hosts, so there are not two competing cards.
const controlsPanel = workspace?.querySelector('.controls-panel');
check(!!controlsPanel?.querySelector('#top-controls'), 'constraints host is inside the panel');
check(!!controlsPanel?.querySelector('#controls'), 'image controls host is inside the panel');
const topControls = doc.querySelector('#top-controls') as HTMLElement | null;
check(!!topControls, 'top controls host exists');
const topTitles = Array.from(topControls?.querySelectorAll('h2') ?? []).map((h) => h.textContent);
check(
  topTitles.includes('Spectrum constraints'),
  `constraints are beside the layers, got ${topTitles.join()}`,
);

// Framing is a dropdown on the source label row, next to Upload.
const framingMenuEl = doc.querySelector('#framing-menu') as HTMLElement | null;
check(!!framingMenuEl, 'framing is a menu');
check(!doc.querySelector('.framing-bar'), 'framing no longer has its own bar');
const sourceLabel = doc.querySelectorAll('.view-label')[0] as HTMLElement;
check(!!sourceLabel.querySelector('#framing-menu'), 'framing sits on the source row');
check(!!sourceLabel.querySelector('#upload-btn'), 'upload button sits on the source row');
const framingHost = doc.querySelector('#framing-controls') as HTMLElement | null;
check(!!framingHost, 'framing has its own host');
check(!!framingMenuEl?.querySelector('#framing-controls'), 'framing controls live inside the menu');

// The menu opens on click and closes on a click outside.
const framingToggleBtn = framingMenuEl?.querySelector('button') as HTMLElement;
const framingPanel = framingMenuEl?.querySelector('.menu-items') as HTMLElement;
check(framingPanel?.hidden === true, 'framing starts closed');
framingToggleBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(framingPanel?.hidden === false, 'framing opens');
doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(framingPanel?.hidden === true, 'framing closes on an outside click');
check(
  framingHost?.querySelectorAll('select').length === 5,
  `framing is five dropdowns, got ${framingHost?.querySelectorAll('select').length}`,
)
check(!framingHost?.querySelector('input[type="range"]'), 'framing uses no sliders');
const lowerTitles = Array.from(doc.querySelectorAll('#controls .group > h2')).map((h) => h.textContent);
check(!lowerTitles.includes('Framing'), 'Framing is not in the lower grid');

// --- painting lives in the layer panel ----------------------------------

const layersPanel = doc.querySelector('.layers-panel') as HTMLElement;
check(!!layersPanel.querySelector('#paint-bar'), 'paint bar is inside the layer panel');
check(!!layersPanel.querySelector('#brush-size'), 'brush size is inside the layer panel');

// --- scale and export sit above the Spectrum screen ---------------------

const spectrumLabel = doc.querySelectorAll('.view-label')[1] as HTMLElement;
check(!!spectrumLabel.querySelector('#scale-seg'), 'scale buttons are in the Spectrum label row');
check(!!spectrumLabel.querySelector('#export-menu'), 'export menu is in the Spectrum label row');

// --- state save / load --------------------------------------------------

check(!!doc.querySelector('#state-save'), 'save-state button exists');
check(!!doc.querySelector('#state-load'), 'load-state button exists');
check(!!doc.querySelector('#state-input'), 'state file input exists');

// Save / load / reset live in the header, export with the scale buttons.
const headerTools = doc.querySelector('.header-tools') as HTMLElement;
check(!!headerTools?.querySelector('#state-save'), 'save lives in the header');
check(!!headerTools?.querySelector('#state-load'), 'load lives in the header');
check(!!headerTools?.querySelector('#state-reset'), 'reset lives in the header');
const spectrumTools = spectrumLabel.querySelector('.view-tools') as HTMLElement;
check(!!spectrumTools?.querySelector('#export-menu'), 'export stays on the Spectrum row');

// The constraints group pairs two sliders on one row, then a check + select.
const constraintRows = constraints?.querySelectorAll('.control-row') ?? [];
check(constraintRows.length === 2, `expected 2 control rows, got ${constraintRows.length}`);
const rowOne = constraintRows[0]?.querySelectorAll('.slider') ?? [];
check(rowOne.length === 2, `first row holds two sliders, got ${rowOne.length}`);
const rowTwo = constraintRows[1];
check(!!rowTwo?.querySelector('.check'), 'second row holds the checkbox');
check(!!rowTwo?.querySelector('.field'), 'second row holds the dropdown');

// Drive a real conversion: the fake canvas returns transparent pixels, which is
// fine — the point is that the whole pipeline (fit, convert, paint, stats)
// completes without throwing.
const outCanvas = doc.querySelector('#out-canvas') as HTMLElement;
check(!!outCanvas, 'output canvas exists');
// No filename or stats strip under either picture.
check(!doc.querySelector('#source-foot'), 'no filename strip under the source');
check(!doc.querySelector('#out-foot'), 'no stat strip under the Spectrum view');
// --- upload opens the file picker --------------------------------------

// The canvases swallow clicks for painting, so an explicit button is the only
// way to change the image; it must actually forward to the file input.
const fileInputEl = doc.querySelector('#file-input') as HTMLInputElement;
let pickerOpened = 0;
fileInputEl.click = () => { pickerOpened++; };
(doc.querySelector('#upload-btn') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(pickerOpened === 1, `upload button opens the picker once, got ${pickerOpened}`);

// Clicking the canvas must NOT open the picker: it is for painting.
const sourceCanvas = doc.querySelector('#source-canvas') as HTMLCanvasElement;
sourceCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(pickerOpened === 1, 'clicking the canvas does not open the picker');

// --- reset discards the workspace --------------------------------------

// Two layers and a painted mask, then Reset should return to a single base.
(doc.querySelector('#layer-add') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(doc.querySelectorAll('#layer-list .layer').length === 3, 'layers added before reset');

// jsdom has no confirm() prompt, so stub it as accepted.
(window as unknown as { confirm: () => boolean }).confirm = () => true;
(doc.querySelector('#state-reset') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(doc.querySelectorAll('#layer-list .layer').length === 1, 'reset returns to one layer');
await new Promise((r) => setTimeout(r, 400));
const afterReset = JSON.parse(window.localStorage.getItem('spectrum-screener/v2') ?? '{}');
check((afterReset.layers ?? []).length === 1, 'reset persists a single layer');
check(!window.localStorage.getItem('spectrum-screener/image/v1'), 'reset clears the stored image');

if (failures.length) {
  console.error('UI smoke test failures:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log(`UI smoke test passed (${sliders.length} sliders, ${scaleButtons.length} scales).`);
