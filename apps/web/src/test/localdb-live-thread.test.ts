// SPDX-License-Identifier: AGPL-3.0-or-later
import { it, expect, vi } from "vitest";
import { flushSync } from "svelte";
import { makeLocalDb } from "$lib/client/localdb";
import type { TimelineItem } from "$lib/client/localdb/schema";
import type { SeedThreadItem } from "$lib/client/localdb/sync.svelte";

/** What rowToItem returns from the worker after a seed (TimelineItem + framedHtml). */
const stubDbRow: TimelineItem & { framedHtml: string } = {
  type: "external_message",
  id: "msg-1",
  threadId: "t1",
  framedHtml: "<html>framed</html>",
};

/** What seedThreadItems accepts (wire shape: seq + payload + framedHtml). */
const stubItem: SeedThreadItem = {
  seq: 0,
  payload: { type: "external_message", id: "msg-1", threadId: "t1" },
  framedHtml: "<html>framed</html>",
};

it("liveThread re-queries after seedThreadItems bumps the thread version", async () => {
  let items: TimelineItem[] = [];
  const bridge = {
    call: vi.fn(async (method: string) => {
      if (method === "listThreadItems") return items;
      return true;
    }),
  };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThread(() => "t1");

  // let the initial effect run + resolve
  flushSync(); await Promise.resolve(); flushSync();

  // prime the return value (DB read returns TimelineItem + framedHtml)
  items = [stubDbRow];
  await local.seedThreadItems("t1", [stubItem], 1, "14");
  flushSync(); await Promise.resolve(); flushSync();

  expect(live.current.length).toBe(1);
  expect(live.current[0].id).toBe("msg-1");
});

it("liveThread destroy removes watcher so further writes do not trigger refresh", async () => {
  let items: TimelineItem[] = [];
  const bridge = {
    call: vi.fn(async (method: string) => {
      if (method === "listThreadItems") return items;
      return true;
    }),
  };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThread(() => "t1");
  flushSync(); await Promise.resolve(); flushSync();

  live.destroy();
  items = [stubDbRow];
  await local.seedThreadItems("t1", [stubItem], 1, "14");
  flushSync(); await Promise.resolve(); flushSync();

  // After destroy, list was not re-queried
  expect(live.current.length).toBe(0);
});

it("seedThreadItems bumps version and liveThread picks up TimelineItem with framedHtml", async () => {
  let items: TimelineItem[] = [];
  const bridge = {
    call: vi.fn(async (method: string) => {
      if (method === "listThreadItems") return items;
      return true;
    }),
  };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThread(() => "t1");
  flushSync(); await Promise.resolve(); flushSync();

  items = [stubDbRow];
  await local.seedThreadItems("t1", [stubItem], 1, "14");
  flushSync(); await Promise.resolve(); flushSync();

  expect(live.current.length).toBe(1);
  expect((live.current[0] as any).framedHtml).toBe("<html>framed</html>");
});
