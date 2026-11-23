import { DEFAULT_OPTIONS } from '../core/defaults';
import { DEFAULT_SOURCE, type SourceOptions } from '../core/image';
import { createBaseLayer, deserialiseLayers, serialiseLayers, type Layer, type StoredLayer } from '../core/layers';
import type { ConvertOptions } from '../core/types';

export type LocalState = ConvertOptions & SourceOptions;

export interface Workspace {
  layers: Layer[];
  /** Framing is a property of the picture, not of any one region. */
  source: SourceOptions;
  selectedId: string;
}

const KEY = 'spectrum-screener/v2';

export function defaultWorkspace(): Workspace {
  const base = createBaseLayer(DEFAULT_OPTIONS);
  return { layers: [base], source: { ...DEFAULT_SOURCE }, selectedId: base.id };
}

interface StoredWorkspace {
  layers: StoredLayer[];
  source?: Partial<SourceOptions>;
  selectedId?: string;
}

/**
 * A portable snapshot: everything needed to resume, including masks and (when
 * it fits) the source image itself, so a saved state is self-contained on
 * another machine.
 */
export interface StateFile {
  format: 'spectrum-screener';
  version: 2;
  layers: StoredLayer[];
  source: SourceOptions;
  selectedId: string;
  /** Name and data URL of the picture the layers were painted against. */
  image?: { name: string; dataUrl: string };
}

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultWorkspace();
    const parsed = JSON.parse(raw) as StoredWorkspace;
    if (!Array.isArray(parsed.layers) || parsed.layers.length === 0) return defaultWorkspace();
    const layers = deserialiseLayers(parsed.layers);
    const source: SourceOptions = { ...DEFAULT_SOURCE, ...(parsed.source ?? {}) };
    const selectedId = layers.some((l) => l.id === parsed.selectedId)
      ? parsed.selectedId!
      : layers[layers.length - 1].id;
    return { layers, source: sanitiseSource(source), selectedId };
  } catch {
    return defaultWorkspace();
  }
}

let saveTimer: number | undefined;
/** Latest workspace to write. A debounced save must not hold a stale object: a
 *  preset click can land while a slider write is still pending, and whichever
 *  timer fires last would otherwise resurrect the older options. */
let pending: Workspace | null = null;

/**
 * Persist the layer stack, masks and framing. Debounced while a slider is
 * dragging, but `flush` writes immediately — a reload right after clicking a
 * preset must not lose the click.
 */
export function saveWorkspace(ws: Workspace, flush = false): void {
  pending = ws;
  if (saveTimer !== undefined) clearTimeout(saveTimer);

  const write = () => {
    saveTimer = undefined;
    const out = pending;
    if (!out) return;
    try {
      const stored: StoredWorkspace = {
        layers: serialiseLayers(out.layers),
        source: out.source,
        selectedId: out.selectedId,
      };
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
      // Storage can be full or blocked; settings persistence is optional.
    }
  };

  if (flush) {
    write();
    return;
  }
  saveTimer = window.setTimeout(write, 250);
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

export function sanitiseSource(s: SourceOptions): SourceOptions {
  return {
    ...s,
    zoom: clamp(s.zoom, 0.05, 16),
    offsetX: clamp(s.offsetX, -1, 1),
    offsetY: clamp(s.offsetY, -1, 1),
    smooth: clamp(s.smooth, 1, 16),
  };
}

export function sanitiseOptions(state: ConvertOptions): ConvertOptions {
  return {
    ...state,
    exposure: clamp(state.exposure, -4, 4),
    brightness: clamp(state.brightness, -1, 1),
    contrast: clamp(state.contrast, -1, 4),
    gamma: clamp(state.gamma, 0.1, 5),
    blackPoint: clamp(state.blackPoint, 0, 0.9),
    whitePoint: clamp(state.whitePoint, Math.max(0.1, state.blackPoint + 0.01), 1),
    saturation: clamp(state.saturation, 0, 4),
    vibrance: clamp(state.vibrance, -1, 2),
    hue: clamp(state.hue, -180, 180),
    temperature: clamp(state.temperature, -1, 1),
    tint: clamp(state.tint, -1, 1),
    blur: clamp(state.blur, 0, 8),
    sharpen: clamp(state.sharpen, 0, 8),
    posterize: clamp(Math.round(state.posterize), 0, 32),
    threshold: clamp(state.threshold, 0, 1),
    vignette: clamp(state.vignette, -1, 1),
    vignetteSize: clamp(state.vignetteSize, 0, 1),
    paletteMask: state.paletteMask & 0x7fff,
    ditherStrength: clamp(state.ditherStrength, 0, 2),
    cohesion: clamp(state.cohesion, 0, 1),
    singleBias: clamp(state.singleBias, 0, 1),
  };
}

// ---------------------------------------------------------------------------
// Portable state files

export function exportState(ws: Workspace, image: { name: string; dataUrl: string } | null): StateFile {
  return {
    format: 'spectrum-screener',
    version: 2,
    layers: serialiseLayers(ws.layers),
    source: ws.source,
    selectedId: ws.selectedId,
    ...(image ? { image } : {}),
  };
}

export interface ImportedState {
  workspace: Workspace;
  image: { name: string; dataUrl: string } | null;
}

/** Parse a saved state file. Throws a readable message on anything unexpected. */
export function importState(text: string): ImportedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const raw = parsed as Partial<StateFile>;
  if (!raw || raw.format !== 'spectrum-screener') {
    throw new Error('That is not a Spectrum Screener state file.');
  }
  if (!Array.isArray(raw.layers) || raw.layers.length === 0) {
    throw new Error('The state file has no layers.');
  }

  const layers = deserialiseLayers(raw.layers);
  const source = sanitiseSource({ ...DEFAULT_SOURCE, ...(raw.source ?? {}) });
  const selectedId = layers.some((l) => l.id === raw.selectedId)
    ? raw.selectedId!
    : layers[layers.length - 1].id;
  const image =
    raw.image && typeof raw.image.dataUrl === 'string' && raw.image.dataUrl.startsWith('data:image/')
      ? { name: raw.image.name || 'restored.png', dataUrl: raw.image.dataUrl }
      : null;

  return { workspace: { layers, source, selectedId }, image };
}
