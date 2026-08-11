// SPDX-License-Identifier: AGPL-3.0-or-later
import { it, expect, vi } from "vitest";
import { flushSync } from "svelte";
import { makeLocalDb } from "$lib/client/localdb";
import type { TimelineItem } from "$lib/client/localdb/schema";

const stubItem: TimelineItem & { framedHtml: string | null } = {
  type: "external_message",
  id: "msg-1",
  threadId: "t1",
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

  // prime the return value
  items = [stubItem];
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
  items = [stubItem];
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

  items = [stubItem];
  await local.seedThreadItems("t1", [stubItem], 1, "14");
  flushSync(); await Promise.resolve(); flushSync();

  expect(live.current.length).toBe(1);
  expect((live.current[0] as any).framedHtml).toBe("<html>framed</html>");
});
