// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createBridge } from "$lib/client/localdb/rpc";

// A fake Worker: echoes {id, result: params.n * 2} for method "double".
class FakeWorker {
  onmessage: ((ev: { data: any }) => void) | null = null;
  postMessage(msg: any) {
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result: msg.params.n * 2 } }));
  }
}

describe("localdb rpc bridge", () => {
  it("correlates a request to its response by id", async () => {
    const bridge = createBridge(new FakeWorker() as any);
    expect(await bridge.call<number>("double", { n: 21 })).toBe(42);
  });
});
