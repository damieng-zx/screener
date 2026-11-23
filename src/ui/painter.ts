import { SCREEN_H, SCREEN_W } from '../core/palette';
import { stamp, stroke, type Layer } from '../core/layers';

export interface PaintOptions {
  mode: 'paint' | 'erase';
  radius: number;
  hardness: number;
}

export interface PaintCallbacks {
  /** Called after a stroke finishes, so the page converts once per gesture. */
  onCommit: () => void;
  /** Called while dragging, for a cheap overlay-only redraw. */
  onPreview: () => void;
}

/**
 * Mouse painting of a layer mask on the source canvas.
 *
 * Coordinates are mapped through the canvas' CSS size, so the overlay stays
 * correct at any zoom of the page, and painting is always in the 256x192
 * screen space rather than device pixels.
 */
export class Painter {
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private cb: PaintCallbacks;
  private drawing = false;
  private last: { x: number; y: number } | null = null;
  /** Layer being painted; null disables painting entirely. */
  target: Layer | null = null;
  options: PaintOptions = { mode: 'paint', radius: 12, hardness: 0.7 };

  constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, cb: PaintCallbacks) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.cb = cb;
    this.bind();
  }

  private toScreen(ev: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * SCREEN_W;
    const y = ((ev.clientY - rect.top) / rect.height) * SCREEN_H;
    return {
      x: Math.max(0, Math.min(SCREEN_W - 1, x)),
      y: Math.max(0, Math.min(SCREEN_H - 1, y)),
    };
  }

  private bind() {
    const start = (ev: PointerEvent) => {
      if (!this.target) return;
      if (ev.button !== 0) return;
      ev.preventDefault();
      // Alt/Option erases on the fly, which is the usual convention for masks.
      this.options.mode = ev.altKey ? 'erase' : 'paint';
      this.drawing = true;
      this.last = this.toScreen(ev);
      this.canvas.setPointerCapture?.(ev.pointerId);
      this.paintTo(this.last.x, this.last.y);
      this.cb.onPreview();
    };

    const move = (ev: PointerEvent) => {
      if (!this.drawing || !this.target) return;
      const p = this.toScreen(ev);
      this.options.mode = ev.altKey ? 'erase' : this.options.mode;
      if (this.last) {
        stroke(this.target.mask!, this.last.x, this.last.y, p.x, p.y, {
          radius: this.options.radius,
          value: this.options.mode === 'erase' ? 0 : 1,
          hardness: this.options.hardness,
        });
      } else {
        this.paintTo(p.x, p.y);
      }
      this.last = p;
      this.cb.onPreview();
    };

    const end = (ev: PointerEvent) => {
      if (!this.drawing) return;
      this.drawing = false;
      this.last = null;
      try {
        this.canvas.releasePointerCapture?.(ev.pointerId);
      } catch {
        // Capture may already be gone; nothing to do.
      }
      this.cb.onCommit();
    };

    this.canvas.addEventListener('pointerdown', start);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', end);
    // No context menu while right-dragging to erase.
    this.canvas.addEventListener('contextmenu', (ev) => {
      if (this.target) ev.preventDefault();
    });
  }

  private paintTo(x: number, y: number) {
    if (!this.target?.mask) return;
    stamp(this.target.mask, x, y, {
      radius: this.options.radius,
      value: this.options.mode === 'erase' ? 0 : 1,
      hardness: this.options.hardness,
    });
  }

  /** Repaint just the mask overlay; cheap enough to run on every mousemove. */
  drawOverlay(layers: Layer[], selected: Layer | null) {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

    // Every layer with a mask gets a faint tint so the structure is visible,
    // with the selected one brighter.
    const data = ctx.createImageData(SCREEN_W, SCREEN_H);
    const acc = new Float32Array(SCREEN_W * SCREEN_H);
    for (const l of layers) {
      if (!l.visible || !l.mask) continue;
      const weight = l === selected ? 1 : 0.35;
      for (let i = 0; i < acc.length; i++) if (l.mask[i]) acc[i] = Math.max(acc[i], weight);
    }
    for (let i = 0; i < acc.length; i++) {
      const a = acc[i];
      if (a === 0) continue;
      const o = i * 4;
      // A yellow wash reads clearly over nearly any photo.
      data.data[o] = 255;
      data.data[o + 1] = 213;
      data.data[o + 2] = 0;
      data.data[o + 3] = a * 110;
    }
    ctx.putImageData(data, 0, 0);

    // Outline the selected layer's region so its border is unambiguous.
    if (selected?.mask) outlineMask(ctx, selected.mask);
  }
}

/** Trace the boundary of a mask with a thin dark line. */
function outlineMask(ctx: CanvasRenderingContext2D, mask: Uint8Array) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,213,0,0.85)';
  ctx.lineWidth = 1;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < SCREEN_W && y < SCREEN_H && mask[y * SCREEN_W + x] !== 0;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      if (!inside(x, y)) continue;
      // Only draw edges; interior pixels are already tinted.
      if (inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1)) continue;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 1, y + 1);
      ctx.stroke();
    }
  }
  ctx.restore();
}
