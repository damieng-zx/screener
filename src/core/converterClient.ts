import { convert } from '../core/convert';
import type { Layer } from '../core/layers';
import type { ConversionResult, ConvertOptions, WorkerRequest, WorkerResponse } from './types';

/**
 * Drives conversion on a worker when possible, so the UI keeps painting while
 * a 256x192 / 64-candidate-per-cell pass is running. Falls back to the main
 * thread where workers are unavailable.
 */
export class Converter {
  private worker: Worker | null = null;
  private seq = 0;
  private failed = false;
  private pending = new Map<number, { resolve: (r: ConversionResult) => void; reject: (e: Error) => void }>();

  constructor() {
    try {
      this.worker = new Worker(new URL('../workers/convert.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
        const { seq, ok, result, error } = ev.data;
        const entry = this.pending.get(seq);
        if (!entry) return;
        this.pending.delete(seq);
        if (ok && result) entry.resolve(result);
        else entry.reject(new Error(error ?? 'Conversion failed'));
      });
      this.worker.addEventListener('error', (ev) => {
        // A broken worker (HMR mid-edit, blocked script, out of memory) must
        // not brick the page: fall back to the main thread from now on.
        this.failed = true;
        this.worker = null;
        for (const entry of this.pending.values()) entry.reject(new Error(ev.message));
        this.pending.clear();
      });
    } catch {
      this.worker = null;
    }
  }

  get isWorker() {
    return this.worker !== null && !this.failed;
  }

  run(source: Uint8Array, options: ConvertOptions | Layer[]): Promise<ConversionResult> {
    const seq = ++this.seq;
    if (!this.worker) {
      try {
        return Promise.resolve(convert(source, options, seq));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return new Promise<ConversionResult>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      // Layers hold typed arrays, which structured-clone across postMessage, so
      // no manual packing is needed.
      const req: WorkerRequest = { seq, source, options };
      this.worker!.postMessage(req);
    });
  }
}
