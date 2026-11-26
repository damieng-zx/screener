import { Converter } from './core/converterClient';
import { PRESETS } from './core/defaults';
import { fitToScreen } from './core/image';
import {
  createLayer,
  fillMask,
  invertMask,
  type Layer,
} from './core/layers';
import { SCREEN_H, SCREEN_W } from './core/palette';
import type { ConversionResult, ConvertOptions } from './core/types';
import { Controls } from './ui/controls';
import { download, sanitiseName } from './ui/exportUi';
import { LayerList, nextLayerName } from './ui/layerList';
import {
  dataUrlToImage,
  fileToImage,
  imageFromClipboard,
  renderEmptyOut,
  renderSource,
  type LoadedImage,
} from './ui/loader';
import { Painter } from './ui/painter';
import { loadUi, saveUi, type UiPrefs } from './ui/prefs';
import {
  defaultWorkspace,
  exportState,
  importState,
  loadWorkspace,
  sanitiseOptions,
  sanitiseSource,
  saveWorkspace,
  type LocalState,
  type Workspace,
} from './ui/state';

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;

const NPX = SCREEN_W * SCREEN_H;

const app: {
  ws: Workspace;
  ui: UiPrefs;
  source: LoadedImage | null;
  /** Resampled source, RGB triples, 256x192. */
  fitted: Uint8Array;
  result: ConversionResult | null;
  frameMs: number;
  pending: boolean;
  dirty: boolean;
  /** Set while a preset was just applied, so the button stays lit. */
  presetId: string | null;
} = {
  ws: loadWorkspace(),
  ui: loadUi(),
  source: null,
  fitted: new Uint8Array(NPX * 3),
  result: null,
  frameMs: 0,
  pending: false,
  dirty: false,
  presetId: null,
};

const converter = new Converter();
const sourceCanvas = $<HTMLCanvasElement>('#source-canvas');
const overlayCanvas = $<HTMLCanvasElement>('#overlay-canvas');
const outCanvas = $<HTMLCanvasElement>('#out-canvas');

// ---------------------------------------------------------------- helpers

function selected(): Layer {
  const found = app.ws.layers.find((l) => l.id === app.ws.selectedId);
  return found ?? app.ws.layers[app.ws.layers.length - 1];
}

/** The layer whose options the control panel is editing. */
function editLayer(): Layer {
  return selected();
}

// ---------------------------------------------------------------- controls

const controls = new Controls(document, {
  onChange: (key, value) => {
    // Framing keys are picture-wide; everything else is per layer.
    if (key in FRAMING_KEYS) {
      (app.ws.source as unknown as Record<string, unknown>)[key] = value;
      app.ws.source = sanitiseSource(app.ws.source);
      saveWorkspace(app.ws);
      schedule();
      return;
    }
    const layer = editLayer();
    (layer.options as unknown as Record<string, unknown>)[key] = value;
    layer.options = sanitiseOptions(layer.options);
    app.presetId = null;
    controls.markPreset(null);
    saveWorkspace(app.ws);
    schedule();
  },
  onPreset: (id) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const layer = editLayer();
    layer.options = sanitiseOptions({ ...layer.options, ...preset.patch });
    app.presetId = id;
    controls.sync(uiState());
    controls.markPreset(id);
    saveWorkspace(app.ws, true);
    schedule(true);
  },
  onExport: (kind) => {
    if (!app.result) {
      toast('Nothing to export yet: load an image first.');
      return;
    }
    const name = sanitiseName(app.source?.name ?? 'screen');
    void download(kind, app.result, `${name}_spectrum`, 3);
  },
});

const FRAMING_KEYS = new Set(['fit', 'zoom', 'offsetX', 'offsetY', 'smooth', 'background']);

/** The combined view the control panel renders: layer options plus framing. */
function uiState(): LocalState {
  return { ...editLayer().options, ...app.ws.source };
}

// ---------------------------------------------------------------- layer list

const layers = new LayerList($<HTMLElement>('#layer-list'), {
  onSelect: (id) => {
    app.ws.selectedId = id;
    refreshLayerUi();
    // Painting targets whatever is selected, so this also re-targets the brush.
    painter.target = selected().mask ? selected() : null;
    updatePaintBar();
    saveWorkspace(app.ws, true);
  },
  onToggle: (id, visible) => {
    const l = app.ws.layers.find((x) => x.id === id);
    if (!l) return;
    l.visible = visible;
    refreshLayerUi();
    updatePaintBar();
    saveWorkspace(app.ws);
    schedule();
  },
  onRename: (id, name) => {
    const l = app.ws.layers.find((x) => x.id === id);
    if (!l) return;
    l.name = name;
    refreshLayerUi();
    saveWorkspace(app.ws, true);
  },
  onAdd: () => {
    const layer = createLayer(nextLayerName(app.ws.layers), copyOfSelected(), new Uint8Array(NPX));
    app.ws.layers.push(layer);
    app.ws.selectedId = layer.id;
    painter.target = layer;
    refreshLayerUi();
    updatePaintBar();
    // A fresh layer paints nothing, so make the brush obvious immediately.
    toast(`Added ${layer.name}: paint the source to claim its area.`);
    saveWorkspace(app.ws);
    schedule();
  },
  onDelete: (id) => {
    if (app.ws.layers.length < 2) return;
    const at = app.ws.layers.findIndex((l) => l.id === id);
    if (at < 0) return;
    app.ws.layers.splice(at, 1);
    if (app.ws.selectedId === id) app.ws.selectedId = app.ws.layers[app.ws.layers.length - 1].id;
    painter.target = selected().mask ? selected() : null;
    refreshLayerUi();
    updatePaintBar();
    saveWorkspace(app.ws);
    schedule();
  },
  onReorder: (id, dir) => {
    const at = app.ws.layers.findIndex((l) => l.id === id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= app.ws.layers.length) return;
    const [l] = app.ws.layers.splice(at, 1);
    app.ws.layers.splice(to, 0, l);
    refreshLayerUi();
    saveWorkspace(app.ws);
    schedule();
  },
  onFill: (id, filled) => {
    const l = app.ws.layers.find((x) => x.id === id);
    if (!l) return;
    l.mask = filled ? fillMask(1) : new Uint8Array(NPX);
    refreshLayerUi();
    updatePaintBar();
    saveWorkspace(app.ws);
    schedule();
  },
  onInvert: (id) => {
    const l = app.ws.layers.find((x) => x.id === id);
    if (!l?.mask) return;
    invertMask(l.mask);
    refreshLayerUi();
    saveWorkspace(app.ws);
    schedule();
  },
  onBlend: (id, blend, blendWith) => {
    const l = app.ws.layers.find((x) => x.id === id);
    if (!l) return;
    l.blend = blend;
    l.blendWith = blend === 'own' ? null : blendWith;
    refreshLayerUi();
    saveWorkspace(app.ws);
    schedule();
  },
});

function copyOfSelected(): Partial<ConvertOptions> {
  // A new layer starts as a copy of the current one: that is almost always the
  // intent ("same look, different region").
  return { ...selected().options };
}

// ---------------------------------------------------------------- painting

const painter = new Painter(overlayCanvas, overlayCanvas, {
  onCommit: () => {
    refreshLayerUi();
    saveWorkspace(app.ws);
    schedule();
  },
  onPreview: () => {
    painter.drawOverlay(app.ws.layers, selected());
  },
});

const brushInput = $<HTMLInputElement>('#brush-size');
brushInput.addEventListener('input', () => {
  painter.options.radius = parseFloat(brushInput.value);
});

$('#paint-fill').addEventListener('click', () => {
  const l = selected();
  if (!l.mask) return;
  l.mask = fillMask(1);
  refreshLayerUi();
  saveWorkspace(app.ws);
  schedule();
});
$('#paint-invert').addEventListener('click', () => {
  const l = selected();
  if (!l.mask) return;
  invertMask(l.mask);
  refreshLayerUi();
  saveWorkspace(app.ws);
  schedule();
});
$('#paint-clear').addEventListener('click', () => {
  const l = selected();
  if (!l.mask) return;
  l.mask = new Uint8Array(NPX);
  refreshLayerUi();
  saveWorkspace(app.ws);
  schedule();
});
$('#layer-add').addEventListener('click', () => {
  const layer = createLayer(nextLayerName(app.ws.layers), copyOfSelected(), new Uint8Array(NPX));
  app.ws.layers.push(layer);
  app.ws.selectedId = layer.id;
  painter.target = layer;
  refreshLayerUi();
  updatePaintBar();
  saveWorkspace(app.ws);
  schedule();
});

// ---------------------------------------------------------------- state files

/**
 * Save / load the whole workspace as a JSON file, including every layer's
 * options and painted mask, plus the source image when it fits. localStorage
 * already survives a reload; this is for moving a setup between machines or
 * keeping a few alternatives around.
 */
function wireStateFiles() {
  $('#state-save').addEventListener('click', () => {
    const image = app.source?.dataUrl ? { name: app.source.name, dataUrl: app.source.dataUrl } : null;
    const data = exportState(app.ws, image);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = sanitiseName(app.source?.name ?? 'workspace');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.screener.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Saved state: ${app.ws.layers.length} layer${app.ws.layers.length === 1 ? '' : 's'}.`);
  });

  const input = $<HTMLInputElement>('#state-input');
  $('#state-load').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    void file
      .text()
      .then(importState)
      .then(async (loaded) => {
        app.ws = loaded.workspace;
        app.presetId = null;
        painter.target = selected().mask ? selected() : null;
        refreshLayerUi();
        updatePaintBar();
        saveWorkspace(app.ws, true);
        if (loaded.image) {
          const img = await dataUrlToImage(loaded.image.dataUrl, loaded.image.name);
          await acceptImage(img);
        } else {
          await run();
        }
        toast(`Loaded state: ${app.ws.layers.length} layer${app.ws.layers.length === 1 ? '' : 's'}.`);
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)));
  });

  // Reset throws away the layers, masks, framing and the loaded picture, then
  // starts from a clean workspace so the next export cannot silently describe
  // an image that is no longer there.
  $('#state-reset').addEventListener('click', () => {
    if (!window.confirm('Discard the current image, layers and settings?')) return;
    app.ws = defaultWorkspace();
    app.presetId = null;
    app.source = null;
    app.result = null;
    painter.target = null;
    try {
      localStorage.removeItem(IMAGE_KEY);
    } catch {
      // Storage may be unavailable; the in-memory reset still applies.
    }
    refreshLayerUi();
    updatePaintBar();
    saveWorkspace(app.ws, true);
    renderEmptyOut(outCanvas);
    void run();
    toast('Reset.');
  });
}

function updatePaintBar() {
  const bar = $<HTMLElement>('#paint-bar');
  const layer = selected();
  // The background layer spans the screen, so there is nothing to paint.
  bar.hidden = !layer.mask || !layer.visible;
  painter.target = layer.mask && layer.visible ? layer : null;
  overlayCanvas.classList.toggle('paintable', painter.target !== null);
}

function refreshLayerUi() {
  layers.render(app.ws.layers, app.ws.selectedId);
  const layer = selected();
  controls.sync(uiState());
  controls.markPreset(app.presetId);
  painter.drawOverlay(app.ws.layers, layer);
}

// ---------------------------------------------------------------- conversion

let rafQueued = false;

function schedule(immediate = false) {
  app.dirty = true;
  if (immediate) {
    void run();
    return;
  }
  // Coalesce slider drags into at most one conversion per frame.
  if (rafQueued) return;
  rafQueued = true;
  window.requestAnimationFrame(() => {
    rafQueued = false;
    if (app.dirty) void run();
  });
}

async function run() {
  // A conversion is already in flight: leave `dirty` set so the finally block
  // re-runs with the newest state instead of silently dropping the edit.
  if (app.pending) return;
  app.dirty = false;
  if (!app.source) {
    renderEmptyOut(outCanvas);
    return;
  }

  app.pending = true;
  const t0 = performance.now();
  try {
    // Every layer sees the same resampled image and differs only in what it
    // does to it, so framing is applied once, here.
    const rgba = fitToScreen(app.source.image, app.ws.source);
    for (let i = 0, j = 0; i < NPX; i++, j += 4) {
      app.fitted[i * 3] = rgba[j];
      app.fitted[i * 3 + 1] = rgba[j + 1];
      app.fitted[i * 3 + 2] = rgba[j + 2];
    }
    renderSource(sourceCanvas, rgba);

    app.result = await converter.run(app.fitted, app.ws.layers);
    paintResult(app.result);
    app.frameMs = performance.now() - t0;
  } catch (err) {
    console.error(err);
    toast(err instanceof Error ? err.message : String(err));
  } finally {
    app.pending = false;
    if (app.dirty) schedule();
  }
}

function paintResult(result: ConversionResult) {
  const ctx = outCanvas.getContext('2d');
  if (!ctx) return;
  const img = new ImageData(new Uint8ClampedArray(result.screen), SCREEN_W, SCREEN_H);
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------- input

async function acceptImage(loaded: LoadedImage) {
  app.source = loaded;
  // Remember the picture itself, not just the options, so a reload or an
  // accidental refresh does not cost the user their image.
  saveImage(loaded);
  await run();
}

function guard(p: Promise<LoadedImage>) {
  p.then(acceptImage).catch((err) => toast(err instanceof Error ? err.message : String(err)));
}

/** Most recent image, as a data URL. Quota-limited, so failures are ignored. */
const IMAGE_KEY = 'spectrum-screener/image/v1';

function saveImage(loaded: LoadedImage) {
  const dataUrl = loaded.dataUrl;
  if (!dataUrl) return;
  try {
    localStorage.setItem(IMAGE_KEY, JSON.stringify({ name: loaded.name, dataUrl }));
  } catch {
    // Too large for the quota: persistence of the image is best-effort, the
    // options are tiny and still saved.
    try {
      localStorage.removeItem(IMAGE_KEY);
    } catch {
      // Ignore.
    }
  }
}

async function restoreImage(): Promise<LoadedImage | null> {
  try {
    const raw = localStorage.getItem(IMAGE_KEY);
    if (!raw) return null;
    const { name, dataUrl } = JSON.parse(raw) as { name?: string; dataUrl?: string };
    if (!dataUrl) return null;
    return await dataUrlToImage(dataUrl, name ?? 'restored.png');
  } catch {
    return null;
  }
}

const fileInput = $<HTMLInputElement>('#file-input');
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) guard(fileToImage(file));
  fileInput.value = '';
});

// An explicit button, because the canvases fill the stage: they have to take
// clicks for painting, which leaves no room for "click the background to open a
// file". Drag, drop and paste still work.
$('#upload-btn').addEventListener('click', () => fileInput.click());

const dropzone = $<HTMLElement>('#dropzone');
dropzone.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dropzone.classList.remove('dragover');
  const file = ev.dataTransfer?.files?.[0];
  if (file) guard(fileToImage(file));
});

window.addEventListener('paste', (ev: ClipboardEvent) => {
  imageFromClipboard(ev)
    .then((loaded) => (loaded ? acceptImage(loaded) : undefined))
    .catch((err) => toast(err instanceof Error ? err.message : String(err)));
});

window.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') {
    ev.preventDefault();
    fileInput.click();
  }
});

// ---------------------------------------------------------------- chrome

function applyUi(ui: UiPrefs) {
  applyScale(ui.scale);
}
applyUi(app.ui);

// ---------------------------------------------------------------- scaling

/**
 * The Spectrum view is only ever shown at a whole-integer scale. A fractional
 * factor resamples the 1-bit pixels, which turns clean attribute edges into
 * grey mush and makes dithering impossible to judge.
 */
function applyScale(scale: number) {
  const n = clampInt(scale, 1, 8);
  const screen = $<HTMLElement>('#out-screen');
  screen.classList.add('integer');
  screen.style.setProperty('--scale', String(n));
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#scale-seg button'))) {
    b.classList.toggle('on', Number(b.dataset.scale) === n);
  }
  updateStageLayout();
}

/**
 * At 256 * n px the Spectrum picture outgrows its half of the stage from about
 * 3x onwards, so switch the stage to one column and let it use the full width.
 * Measured rather than guessed at a breakpoint, because the threshold depends on
 * the window width.
 */
function updateStageLayout() {
  const stage = $<HTMLElement>('#dropzone');
  const out = $<HTMLElement>('#out-screen');
  const wanted = 256 * clampInt(Number(out.style.getPropertyValue('--scale')) || 2, 1, 8);
  // Half the stage, minus the gap and padding between the two views.
  const available = stage.clientWidth / 2 - 20;
  stage.classList.toggle('fit-expanded', wanted > available);
  // The expanded grid track needs the number, since `min(100%, ...)` inside a
  // shrink-to-fit track collapses to nothing.
  stage.style.setProperty('--scale-now', String(wanted / 256));
}

function clampInt(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

window.addEventListener('resize', () => updateStageLayout());

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#scale-seg button'))) {
  b.addEventListener('click', () => {
    const n = Number(b.dataset.scale);
    app.ui = saveUi({ scale: n });
    applyScale(n);
  });
}

// ---------------------------------------------------------------- export menu

const exportMenu = $<HTMLElement>('#export-menu');
const exportToggle = exportMenu.querySelector<HTMLButtonElement>('.export-btn')!;
const exportItems = exportMenu.querySelector<HTMLElement>('.menu-items')!;

function setExportOpen(open: boolean) {
  exportItems.hidden = !open;
  exportToggle.setAttribute('aria-expanded', String(open));
  exportMenu.classList.toggle('open', open);
}

exportToggle.addEventListener('click', (ev) => {
  ev.stopPropagation();
  setExportOpen(exportItems.hidden);
});

document.addEventListener('click', (ev) => {
  if (!exportItems.hidden && !exportMenu.contains(ev.target as Node)) setExportOpen(false);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!exportItems.hidden) setExportOpen(false);
    const framing = $<HTMLElement>('#framing-menu');
    if (framing && !framing.querySelector<HTMLElement>('.menu-items')!.hidden) setMenuOpen(framing, false);
  }
});

// ---------------------------------------------------------------- framing menu

/**
 * The framing dropdown reuses the export-menu plumbing: a disclosure with a
 * panel of controls, closed on Escape or on a click outside.
 */
function setMenuOpen(menu: HTMLElement, open: boolean) {
  const items = menu.querySelector<HTMLElement>('.menu-items');
  const toggle = menu.querySelector<HTMLButtonElement>('button');
  if (!items || !toggle) return;
  items.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  menu.classList.toggle('open', open);
}

const framingMenu = $<HTMLElement>('#framing-menu');
const framingToggle = framingMenu.querySelector<HTMLButtonElement>('button')!;
framingToggle.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const items = framingMenu.querySelector<HTMLElement>('.menu-items')!;
  setMenuOpen(framingMenu, items.hidden);
});
document.addEventListener('click', (ev) => {
  const items = framingMenu.querySelector<HTMLElement>('.menu-items')!;
  if (!items.hidden && !framingMenu.contains(ev.target as Node)) setMenuOpen(framingMenu, false);
});

// Transient status, kept out of the picture area entirely.
let toastTimer: number | undefined;
function toast(message: string) {
  const el = $<HTMLElement>('#toast');
  el.textContent = message;
  el.classList.add('on');
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('on'), 3200);
}

renderEmptyOut(outCanvas);
refreshLayerUi();
updatePaintBar();
wireStateFiles();

// Restore the image from the previous session before the first frame, so a
// reload lands the user exactly where they were.
void restoreImage().then((loaded) => {
  if (loaded) void acceptImage(loaded);
});

