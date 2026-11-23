/// <reference lib="webworker" />
import { convert } from '../core/convert';
import type { WorkerRequest, WorkerResponse } from '../core/types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const result = convert(req.source, req.options, req.seq);
    const res: WorkerResponse = { seq: req.seq, ok: true, result };
    ctx.postMessage(res);
  } catch (err) {
    const res: WorkerResponse = {
      seq: req.seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(res);
  }
});

export {};
