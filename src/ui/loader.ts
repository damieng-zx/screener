import { type SourceImage } from '../core/image';

export interface LoadedImage {
  name: string;
  image: SourceImage;
  bytes: number;
  mime: string;
  /** Original file as a data URL, so the image can be restored after reload. */
  dataUrl?: string;
}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

export async function fileToImage(file: File): Promise<LoadedImage> {
  if (!ACCEPTED.includes(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    throw new Error(`${file.name}: only PNG, JPEG and WebP are supported`);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await decode(url);
    return {
      name: file.name,
      image: toSource(img),
      bytes: file.size,
      mime: file.type || 'image/unknown',
      dataUrl: await fileToDataUrl(file),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Re-open an image from a stored data URL (used to restore the last session). */
export async function dataUrlToImage(dataUrl: string, name = 'restored.png'): Promise<LoadedImage> {
  const img = await decode(dataUrl);
  const comma = dataUrl.indexOf(',');
  const bytes = Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
  return {
    name,
    image: toSource(img),
    bytes,
    mime: dataUrl.slice(5, dataUrl.indexOf(';')),
    dataUrl,
  };
}

async function fileToDataUrl(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return `data:${file.type || 'image/png'};base64,${btoa(bin)}`;
}

async function decode(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not decode the image'));
  });
  img.src = url;
  await loaded;
  return img;
}

function toSource(img: HTMLImageElement): SourceImage {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  ctx.drawImage(img, 0, 0);
  return {
    width: canvas.width,
    height: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

/** Clipboard paste handler: grab the first image blob on the clipboard. */
export async function imageFromClipboard(ev: ClipboardEvent): Promise<LoadedImage | null> {
  const items = ev.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file || !file.type.startsWith('image/')) continue;
    return fileToImage(file);
  }
  return null;
}

/** Paint an already-fitted 256x192 RGBA buffer into the source canvas. */
export function renderSource(canvas: HTMLCanvasElement, rgba: Uint8ClampedArray<ArrayBufferLike> | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!rgba) {
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
}

/** Simple watermark when no image is loaded yet. */
export function renderEmptyOut(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 213, 0, 0.25)';
  ctx.lineWidth = 1;
  for (let y = 0; y <= h; y += 8) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  for (let x = 0; x <= w; x += 8) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
}
