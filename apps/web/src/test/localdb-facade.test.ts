// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { flushSync } from "svelte";
import { makeLocalDb } from "$lib/client/localdb";

it("liveThreadList re-queries after applyDeltas bumps the mailbox version", async () => {
  let rows: any[] = [{ threadId: "t1", placement: "inbox" }];
  const bridge = { call: vi.fn(async (method: string) => (method === "list" ? rows : true)) };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThreadList(() => "mb_a", () => "inbox");
  // let the initial effect run + resolve
  flushSync(); await Promise.resolve(); flushSync();
  rows = [{ threadId: "t1", placement: "inbox" }, { threadId: "t2", placement: "inbox" }];
  await local.applyDeltas("mb_a", [], [], 5);
  flushSync(); await Promise.resolve(); flushSync();
  expect(live.current.length).toBe(2);
});
