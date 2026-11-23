import type { LocalState } from './state';

export type ControlKind = 'slider' | 'check' | 'seg' | 'select';

export interface ControlSpec {
  key: keyof LocalState;
  label: string;
  kind: ControlKind;
  min?: number;
  max?: number;
  step?: number;
  /** Slider display digits. */
  digits?: number;
  /** Options for `select`; `value` is a string, coerced when `numeric`. */
  options?: { value: string; label: string }[];
  /** A `select` whose value should be stored as a number. */
  numeric?: boolean;
  /**
   * Controls sharing a positive `row` value are laid out side by side, in
   * declaration order, before the next row starts.
   */
  row?: number;
}

export interface GroupSpec {
  title: string;
  wide?: boolean;
  /** Lay the controls out in two columns inside this group. */
  columns?: boolean;
  /** Render above the image controls, beside the layer panel. */
  top?: boolean;
  /** Keep this group's column narrow. */
  narrow?: boolean;
  /** Render into its own host element instead of a control panel. */
  host?: 'framing';
  controls: ControlSpec[];
}

/** Compact dropdown values for framing, so the whole bar fits on one line. */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const PAN_STEPS = [-0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5];

export const GROUPS: GroupSpec[] = [
  {
    // First, because dithering is what makes a result look like a Spectrum and
    // it is the control people reach for most. A single column keeps it narrow.
    title: 'Dithering',
    narrow: true,
    controls: [
      { key: 'dither', label: 'Dither', kind: 'select', options: [] },
      { key: 'ditherStrength', label: 'Dither strength', kind: 'slider', min: 0, max: 2, step: 0.01, digits: 2 },
      { key: 'preQuantize', label: 'Pre-quantise source', kind: 'check' },
      { key: 'preDither', label: 'Pre-dither', kind: 'select', options: [] },
    ],
  },
  {
    title: 'Tone',
    controls: [
      { key: 'exposure', label: 'Exposure', kind: 'slider', min: -2, max: 2, step: 0.01, digits: 2 },
      { key: 'brightness', label: 'Brightness', kind: 'slider', min: -0.5, max: 0.5, step: 0.005, digits: 2 },
      { key: 'contrast', label: 'Contrast', kind: 'slider', min: -0.9, max: 2, step: 0.01, digits: 2 },
      { key: 'gamma', label: 'Gamma', kind: 'slider', min: 0.3, max: 3, step: 0.01, digits: 2 },
      { key: 'blackPoint', label: 'Black point', kind: 'slider', min: 0, max: 0.5, step: 0.005, digits: 3 },
      { key: 'whitePoint', label: 'White point', kind: 'slider', min: 0.5, max: 1, step: 0.005, digits: 3 },
    ],
  },
  {
    title: 'Colour',
    controls: [
      { key: 'saturation', label: 'Saturation', kind: 'slider', min: 0, max: 2.5, step: 0.01, digits: 2 },
      { key: 'vibrance', label: 'Vibrance', kind: 'slider', min: -0.5, max: 1, step: 0.01, digits: 2 },
      { key: 'hue', label: 'Hue', kind: 'slider', min: -180, max: 180, step: 1, digits: 0 },
      { key: 'temperature', label: 'Temperature', kind: 'slider', min: -1, max: 1, step: 0.01, digits: 2 },
      { key: 'tint', label: 'Tint', kind: 'slider', min: -1, max: 1, step: 0.01, digits: 2 },
    ],
  },
  {
    title: 'Detail',
    controls: [
      { key: 'blur', label: 'Blur', kind: 'slider', min: 0, max: 3, step: 0.05, digits: 2 },
      { key: 'sharpen', label: 'Sharpen', kind: 'slider', min: 0, max: 8, step: 0.01, digits: 2 },
      { key: 'posterize', label: 'Posterize', kind: 'slider', min: 0, max: 16, step: 1, digits: 0 },
      { key: 'binarize', label: 'Binarise', kind: 'check' },
      { key: 'threshold', label: 'Threshold', kind: 'slider', min: 0, max: 1, step: 0.005, digits: 2 },
      {
        // Radial vignette, split into density and reach. Centre = none.
        // Lives with the other edge-shaping controls rather than with tone.
        key: 'vignette',
        label: 'Vignette',
        kind: 'slider',
        min: -1,
        max: 1,
        step: 0.01,
        digits: 2,
      },
      { key: 'vignetteSize', label: 'Vignette size', kind: 'slider', min: 0, max: 1, step: 0.01, digits: 2 },
    ],
  },
  {
    // Framing decides how the source lands on the 256x192 grid, so it sits above
    // the pictures. Dropdowns rather than sliders, so the whole bar is one line.
    title: 'Framing',
    host: 'framing',
    controls: [
      {
        key: 'fit',
        label: 'Fit',
        kind: 'select',
        options: [
          { value: 'fit', label: 'Fit' },
          { value: 'fill', label: 'Fill' },
          { value: 'stretch', label: 'Stretch' },
        ],
      },
      {
        key: 'zoom',
        label: 'Zoom',
        kind: 'select',
        numeric: true,
        options: ZOOM_STEPS.map((v) => ({ value: String(v), label: `${v}×` })),
      },
      {
        key: 'offsetX',
        label: 'Pan X',
        kind: 'select',
        numeric: true,
        options: PAN_STEPS.map((v) => ({ value: String(v), label: v === 0 ? 'centre' : String(v) })),
      },
      {
        key: 'offsetY',
        label: 'Pan Y',
        kind: 'select',
        numeric: true,
        options: PAN_STEPS.map((v) => ({ value: String(v), label: v === 0 ? 'centre' : String(v) })),
      },
      {
        key: 'smooth',
        label: 'Smoothing',
        kind: 'select',
        numeric: true,
        options: [1, 2, 3, 4, 5, 6].map((v) => ({ value: String(v), label: v === 1 ? 'off' : String(v) })),
      },
    ],
  },
  {
    // The hardware rules, beside the layers they apply to.
    title: 'Spectrum constraints',
    top: true,
    controls: [
      {
        key: 'method',
        label: 'Cell fitting',
        kind: 'select',
        options: [
          { value: 'smart', label: 'Smart — dither-aware' },
          { value: 'exhaustive', label: 'Exhaustive — nearest two' },
          { value: 'frequency', label: 'Frequency — most common two' },
          { value: 'average', label: 'Average — fit cell mean' },
        ],
      },
      {
        key: 'brightMode',
        label: 'Brightness',
        kind: 'seg',
        options: [
          { value: 'auto', label: 'auto' },
          { value: 'normal', label: 'normal' },
          { value: 'bright', label: 'bright' },
        ],
      },
      { key: 'singleBias', label: 'Single-cell bias', kind: 'slider', min: 0, max: 1, step: 0.01, digits: 2, row: 1 },
      { key: 'cohesion', label: 'Cohesion', kind: 'slider', min: 0, max: 1, step: 0.01, digits: 2, row: 1 },
      { key: 'allowSingleColour', label: 'Single-colour cells', kind: 'check', row: 2 },
      {
        key: 'flashMode',
        label: 'Flash',
        kind: 'select',
        row: 2,
        options: [
          { value: 'off', label: 'Off' },
          { value: 'checker', label: 'Checkerboard' },
          { value: 'random', label: 'Random' },
        ],
      },
    ],
  },
];
