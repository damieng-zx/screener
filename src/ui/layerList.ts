import { countOwned, type Layer, type LayerBlend } from '../core/layers';
import { PALETTE, SCREEN_H, SCREEN_W } from '../core/palette';

export interface LayerListCallbacks {
  onSelect: (id: string) => void;
  onToggle: (id: string, visible: boolean) => void;
  onRename: (id: string, name: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, direction: -1 | 1) => void;
  onFill: (id: string, filled: boolean) => void;
  onInvert: (id: string) => void;
  /** Change what this layer borrows, and from whom. */
  onBlend: (id: string, blend: LayerBlend, blendWith: string | null) => void;
}

/** The layer stack: order, visibility, selection and the paint helpers. */
export class LayerList {
  private host: HTMLElement;
  private cb: LayerListCallbacks;
  constructor(host: HTMLElement, cb: LayerListCallbacks) {
    this.host = host;
    this.cb = cb;
  }

  render(layers: Layer[], selectedId: string | null) {
    this.host.textContent = '';
    // Topmost first, like every other layer stack: the last entry wins, so it
    // belongs at the top of the list.
    for (let i = layers.length - 1; i >= 0; i--) {
      this.host.append(this.row(layers, i, selectedId));
    }
  }

  private row(layers: Layer[], index: number, selectedId: string | null): HTMLElement {
    const layer = layers[index];
    const li = document.createElement('li');
    li.className = 'layer' + (layer.id === selectedId ? ' on' : '') + (layer.visible ? '' : ' hidden-layer');
    li.dataset.layer = layer.id;

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'mini eye';
    eye.textContent = layer.visible ? '◉' : '○';
    eye.title = layer.visible ? 'Hide layer' : 'Show layer';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.cb.onToggle(layer.id, !layer.visible);
    });

    const name = document.createElement('input');
    name.className = 'layer-name';
    name.value = layer.name;
    name.addEventListener('change', () => this.cb.onRename(layer.id, name.value.trim() || 'Layer'));
    name.addEventListener('click', (ev) => ev.stopPropagation());

    const swatch = document.createElement('span');
    swatch.className = 'layer-swatch';
    swatch.style.background = swatchFor(layer);

    const owned = countOwned(layer);
    const count = document.createElement('span');
    count.className = 'layer-count';
    count.textContent = layer.mask === null ? 'all' : `${Math.round((owned / (SCREEN_W * SCREEN_H)) * 100)}%`;
    count.title =
      layer.mask === null
        ? 'This layer covers the whole screen'
        : `${owned} of ${SCREEN_W * SCREEN_H} pixels painted`;

    const actions = document.createElement('span');
    actions.className = 'layer-actions';

    const up = this.iconButton('▲', 'Move up (drawn later)', () => this.cb.onReorder(layer.id, 1));
    const down = this.iconButton('▼', 'Move down', () => this.cb.onReorder(layer.id, -1));
    const fill = this.iconButton('▣', 'Paint the whole screen', () => {
      if (layer.mask === null) return;
      this.cb.onFill(layer.id, true);
    });
    const clear = this.iconButton('▢', 'Unpaint everything', () => this.cb.onFill(layer.id, false));
    const inv = this.iconButton('◐', 'Invert the painted area', () => this.cb.onInvert(layer.id));
    const del = this.iconButton('✕', 'Delete layer', () => this.cb.onDelete(layer.id));
    if (index === layers.length - 1) up.disabled = true;
    if (index === 0) down.disabled = true;
    // The bottom layer is the background: it has no mask to edit.
    if (layer.mask === null) {
      fill.disabled = true;
      clear.disabled = true;
      inv.disabled = true;
      del.disabled = layers.length < 2;
    }
    actions.append(up, down, inv, fill, clear, del);

    li.append(eye, swatch, name, count, actions);

    // The attribute/bitmap compositing row. Only meaningful when there is
    // another layer to borrow from.
    if (layers.length > 1) {
      const blend = document.createElement('div');
      blend.className = 'layer-blend';
      blend.addEventListener('click', (ev) => ev.stopPropagation());

      const what = document.createElement('select');
      what.className = 'blend-what';
      what.title = 'Which part of this layer comes from elsewhere';
      const options: { value: LayerBlend; label: string }[] = [
        { value: 'own', label: 'own' },
        { value: 'attributes', label: 'attrs from' },
        { value: 'bitmap', label: 'pixels from' },
      ];
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        what.append(opt);
      }
      what.value = layer.blend ?? 'own';

      const from = document.createElement('select');
      from.className = 'blend-from';
      from.title = 'The layer to borrow from';
      for (const other of layers) {
        if (other.id === layer.id) continue;
        const opt = document.createElement('option');
        opt.value = other.id;
        opt.textContent = other.name;
        from.append(opt);
      }
      from.value = layer.blendWith ?? layers.find((l) => l.id !== layer.id)!.id;
      from.disabled = (layer.blend ?? 'own') === 'own';

      what.addEventListener('change', () => {
        const mode = what.value as LayerBlend;
        from.disabled = mode === 'own';
        this.cb.onBlend(layer.id, mode, mode === 'own' ? null : from.value);
      });
      from.addEventListener('change', () => {
        this.cb.onBlend(layer.id, (what.value as LayerBlend) ?? 'attributes', from.value);
      });

      blend.append(what, from);
      li.append(blend);
    }

    li.addEventListener('click', () => this.cb.onSelect(layer.id));
    return li;
  }

  private iconButton(label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fn();
    });
    return b;
  }
}

/** A tiny colour preview so layers are distinguishable at a glance. */
function swatchFor(layer: Layer): string {
  const o = layer.options;
  const bright = o.brightMode === 'bright';
  const warm = o.temperature > 0.1;
  const cool = o.temperature < -0.1;
  const idx = bright ? (warm ? 13 : cool ? 11 : 14) : warm ? 6 : cool ? 1 : 7;
  return PALETTE[idx]?.hex ?? '#888';
}

export function nextLayerName(layers: Layer[]): string {
  let n = 1;
  const names = new Set(layers.map((l) => l.name));
  while (names.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

