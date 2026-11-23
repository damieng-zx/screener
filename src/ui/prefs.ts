/**
 * UI preferences that are not part of the conversion options: view toggles and
 * disclosure state. Kept apart from `AppState` so that adding a checkbox does
 * not change the meaning of a saved conversion workspace.
 */
const KEY = 'spectrum-screener/ui/v1';

export interface UiPrefs {
  /** Whole-integer display scale for the Spectrum view, 1..4. */
  scale: number;
}

export const DEFAULT_UI: UiPrefs = {
  scale: 2,
};

export function loadUi(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_UI };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    const out: UiPrefs = { ...DEFAULT_UI };
    for (const k of Object.keys(DEFAULT_UI) as (keyof UiPrefs)[]) {
      const v = parsed[k];
      if (typeof v === typeof DEFAULT_UI[k]) (out as unknown as Record<string, unknown>)[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_UI };
  }
}

let cache: UiPrefs | null = null;

/** Merge a partial update and write immediately (reloading right after a click
 *  must not lose the click, so this is deliberately not debounced). */
export function saveUi(patch: Partial<UiPrefs>): UiPrefs {
  const next = { ...(cache ?? loadUi()), ...patch };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage may be full or blocked; preferences are optional.
  }
  return next;
}
