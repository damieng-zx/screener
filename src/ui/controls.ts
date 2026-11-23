import { DITHER_OPTIONS } from '../core/dither';
import { PRESETS as PRESET_LIST } from '../core/defaults';
import { GROUPS, type ControlSpec, type GroupSpec } from './schema';
import type { LocalState } from './state';

export interface ControlsCallbacks {
  onChange: (key: keyof LocalState, value: unknown) => void;
  onPreset: (id: string) => void;
  onExport: (kind: ExportKind) => void;
}

export type ExportKind = 'png' | 'scr' | 'tap' | 'c' | 'asm' | 'json';

/**
 * Builds every control from the schema and keeps the DOM in sync with state.
 * One place to add a slider, one place to read its value.
 */
export class Controls {
  private cb: ControlsCallbacks;
  private sliders = new Map<string, { input: HTMLInputElement; out: HTMLElement; spec: ControlSpec }>();
  private checks = new Map<string, HTMLInputElement>();
  private segs = new Map<string, HTMLButtonElement[]>();
  private selects = new Map<string, HTMLSelectElement>();

  constructor(root: ParentNode, cb: ControlsCallbacks) {
    this.cb = cb;
    const host = root.querySelector<HTMLElement>('#controls');
    if (!host) throw new Error('#controls missing');
    // Groups marked `top` render in the row beside the layers, so the Spectrum
    // constraints sit next to what they constrain. Framing has its own bar.
    const topHost = root.querySelector<HTMLElement>('#top-controls') ?? host;
    const framingHost = root.querySelector<HTMLElement>('#framing-controls');

    for (const group of GROUPS) {
      const target = group.host === 'framing' ? framingHost : group.top ? topHost : host;
      if (!target) continue;
      this.buildGroup(target, group, group.wide ?? false, group.host === 'framing');
    }
    this.buildPresets(root);
    this.buildExports(root);
  }

  private buildGroup(host: HTMLElement, group: GroupSpec, wide: boolean, inline = false) {
    const section = document.createElement('div');
    section.className = 'group';
    if (wide) section.classList.add('wide');
    if (group.narrow) section.classList.add('narrow');
    if (inline) section.classList.add('inline');
    const h = document.createElement('h2');
    h.textContent = group.title;
    // An inline group already sits in a titled bar, so its own heading would
    // just repeat the bar's.
    if (!inline) section.append(h);

    // A two-column body keeps related controls visually grouped instead of one
    // long ragged list running down the page.
    const body = group.columns ? document.createElement('div') : section;
    if (group.columns) {
      body.className = 'columns';
      section.append(body);
    }

    for (const spec of group.controls) {
      const el = this.makeControl(spec);
      // Controls sharing a `row` go side by side, so short ones do not each take
      // a full line in a wide column.
      if (spec.row) {
        let rowEl = body.querySelector<HTMLElement>(`:scope > .control-row[data-row="${spec.row}"]`);
        if (!rowEl) {
          rowEl = document.createElement('div');
          rowEl.className = 'control-row';
          rowEl.dataset.row = String(spec.row);
          body.append(rowEl);
        }
        rowEl.append(el);
      } else {
        body.append(el);
      }
    }

    host.append(section);
  }

  private makeControl(spec: ControlSpec): HTMLElement {
    switch (spec.kind) {
      case 'slider':
        return this.makeSlider(spec);
      case 'check':
        return this.makeCheck(spec);
      case 'seg':
        return this.makeSeg(spec);
      case 'select':
        return this.makeSelect(spec);
    }
  }

  private makeSlider(spec: ControlSpec): HTMLElement {
    const label = document.createElement('label');
    label.className = 'slider';
    const text = document.createElement('span');
    text.textContent = spec.label;
    const out = document.createElement('span');
    out.className = 'value';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min ?? 0);
    input.max = String(spec.max ?? 1);
    input.step = String(spec.step ?? 0.01);
    // Sliders whose range straddles zero get a centre tick, so "dead centre =
    // no effect" is visible rather than something you have to remember.
    if ((spec.min ?? 0) < 0 && (spec.max ?? 1) > 0) label.classList.add('bipolar');
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = format(v, spec.digits ?? 2);
      this.cb.onChange(spec.key, v);
    });
    // Double-click resets a bipolar slider to its neutral centre.
    input.addEventListener('dblclick', () => {
      if (!label.classList.contains('bipolar')) return;
      input.value = '0';
      out.textContent = format(0, spec.digits ?? 2);
      this.cb.onChange(spec.key, 0);
    });
    label.append(text, out, input);
    this.sliders.set(spec.key, { input, out, spec });
    return label;
  }

  private makeCheck(spec: ControlSpec): HTMLElement {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => this.cb.onChange(spec.key, input.checked));
    const text = document.createElement('span');
    text.textContent = spec.label;
    label.append(input, text);
    this.checks.set(spec.key, input);
    return label;
  }

  private makeSeg(spec: ControlSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const caption = document.createElement('span');
    caption.className = 'caption';
    caption.textContent = spec.label;
    const seg = document.createElement('span');
    seg.className = 'seg';
    const buttons: HTMLButtonElement[] = [];
    for (const opt of spec.options ?? []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = opt.value;
      b.textContent = opt.label;
      b.addEventListener('click', () => {
        this.markSeg(spec.key, opt.value);
        this.cb.onChange(spec.key, opt.value);
      });
      seg.append(b);
      buttons.push(b);
    }
    row.append(caption, seg);
    this.segs.set(spec.key, buttons);
    return row;
  }

  private makeSelect(spec: ControlSpec): HTMLElement {
    const label = document.createElement('label');
    label.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = spec.label;
    const sel = document.createElement('select');
    const options = spec.options && spec.options.length ? spec.options : DITHER_OPTIONS.map((d) => ({
      value: d.id,
      label: `${d.name} — ${d.hint}`,
    }));
    for (const o of options) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      sel.append(el);
    }
    sel.addEventListener('change', () =>
      this.cb.onChange(spec.key, spec.numeric ? parseFloat(sel.value) : sel.value),
    );
    label.append(caption, sel);
    this.selects.set(spec.key, sel);
    this.selectMeta.set(spec.key, spec);
    return label;
  }

  private selectMeta = new Map<string, ControlSpec>();

  private markSeg(key: string, value: string) {
    for (const b of this.segs.get(key) ?? []) b.classList.toggle('on', b.dataset.value === value);
  }

  sync(state: LocalState) {
    for (const [key, v] of Object.entries(state)) {
      this.setOnly(key, v);
    }

    this.markPreset(null);
  }

  /**
   * Push a single value into the DOM without disturbing the rest. Used by the
   * layer UI for framing keys, which belong to the picture rather than to the
   * selected layer.
   */
  setOnly(key: string, v: unknown) {
    const slider = this.sliders.get(key);
    if (slider && typeof v === 'number') {
      slider.input.value = String(v);
      slider.out.textContent = format(v, slider.spec.digits ?? 2);
    }
    const check = this.checks.get(key);
    if (check && typeof v === 'boolean') check.checked = v;
    if (this.segs.has(key)) this.markSeg(key, String(v));
    const sel = this.selects.get(key);
    if (sel) {
      const meta = this.selectMeta.get(key);
      // Numeric selects hold a string value in the DOM but a number in state.
      if (typeof v === 'string' || typeof v === 'number') sel.value = String(v);
      void meta;
    }
  }

  markPreset(id: string | null) {
    const sel = document.querySelector<HTMLSelectElement>('#preset-select');
    if (sel) sel.value = id ?? '';
    const host = document.querySelector('#presets');
    if (!host) return;
    for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>('button[data-preset]'))) {
      b.classList.toggle('on', b.dataset.preset === id);
    }
  }

  private buildPresets(root: ParentNode): void {
    const host = root.querySelector<HTMLElement>('#presets');
    if (!host) return;
    // Presets apply to the selected layer, so they live with the layer stack
    // rather than in the page header.
    const label = document.createElement('span');
    label.className = 'caption';
    label.textContent = 'Preset for this layer';
    const sel = document.createElement('select');
    sel.id = 'preset-select';
    sel.title = 'Apply a starting point to the selected layer';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose…';
    sel.append(none);
    for (const p of PRESET_LIST) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} — ${p.hint}`;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      if (sel.value) this.cb.onPreset(sel.value);
    });
    host.append(label, sel);
  }

  private buildExports(root: ParentNode) {
    // Menu items are built from the schema list, and the menu closes after a
    // pick so the dropdown does not linger over the result.
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-export]'))) {
      b.addEventListener('click', () => {
        b.closest<HTMLElement>('.menu-items')?.setAttribute('hidden', '');
        b.closest<HTMLElement>('.menu')?.classList.remove('open');
        b.closest<HTMLElement>('.menu')?.querySelector('.export-btn')?.setAttribute('aria-expanded', 'false');
        this.cb.onExport(b.dataset.export as ExportKind);
      });
    }
  }
}

function format(v: number, digits: number): string {
  if (digits === 0) return String(Math.round(v));
  return v.toFixed(digits);
}
