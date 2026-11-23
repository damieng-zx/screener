import { toAsm, toCHeader, toJson, toPng, toScr, toTap } from '../core/export';
import type { ConversionResult } from '../core/types';
import type { ExportKind } from './controls';

export async function download(kind: ExportKind, result: ConversionResult, baseName: string, scale: number): Promise<void> {
  switch (kind) {
    case 'png': {
      const blob = await toPng(result, { scale, grid: false });
      save(blob, `${baseName}.png`);
      return;
    }
    case 'scr':
      save(new Blob([toScr(result)], { type: 'application/octet-stream' }), `${baseName}.scr`);
      return;
    case 'tap':
      save(new Blob([toTap(result, baseName)], { type: 'application/octet-stream' }), `${baseName}.tap`);
      return;
    case 'c':
      save(new Blob([toCHeader(result, sanitiseName(baseName))], { type: 'text/x-c' }), `${baseName}.h`);
      return;
    case 'asm':
      save(new Blob([toAsm(result, sanitiseName(baseName))], { type: 'text/plain' }), `${baseName}.asm`);
      return;
    case 'json':
      save(new Blob([toJson(result)], { type: 'application/json' }), `${baseName}.json`);
      return;
  }
}

function save(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Strip a filename down to something valid as a C identifier / label. */
export function sanitiseName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
  return (stem || 'screen').slice(0, 16);
}
