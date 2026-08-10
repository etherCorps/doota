// SPDX-License-Identifier: Apache-2.0
export type Req = { id: number; method: string; params: unknown };
export type Res = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export function createBridge(worker: Worker) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  worker.onmessage = (ev: MessageEvent<Res>) => {
    const settle = pending.get(ev.data.id);
    if (!settle) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) settle.resolve(ev.data.result);
    else settle.reject(new Error(ev.data.error));
  };
  return {
    call<T>(method: string, params: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, params } satisfies Req);
      });
    },
  };
}
