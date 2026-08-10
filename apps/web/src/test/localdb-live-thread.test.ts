// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { flushSync } from "svelte";
import { makeLocalDb } from "$lib/client/localdb";
import type { MessageDTO } from "@doota/mail-core/mail-thread-contract";

const stubMsg: MessageDTO = {
  type: "external_message",
  id: "msg-1",
  threadId: "t1",
  messageIdHeader: "<msg-1@test>",
  from: "alice@example.com",
  fromName: "Alice",
  to: [],
  cc: [],
  replyTo: null,
  sentAt: 1000,
  contentKind: "bubble",
  subject: "Hello",
  bodyStripped: "Hi there",
  bodyFull: null,
  htmlKind: null,
  hasRemoteImages: false,
  keywords: [],
  isRead: false,
  outbound: false,
  viaAlias: null,
} as unknown as MessageDTO;

it("liveThread re-queries after applyMessageDeltas bumps the thread version", async () => {
  let messages: MessageDTO[] = [];
  const bridge = {
    call: vi.fn(async (method: string) => {
      if (method === "listMessages") return messages;
      return true;
    }),
  };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThread(() => "t1");

  // let the initial effect run + resolve
  flushSync(); await Promise.resolve(); flushSync();

  // prime the return value
  messages = [stubMsg];
  await local.applyMessageDeltas("t1", [stubMsg], [], 5);
  flushSync(); await Promise.resolve(); flushSync();

  expect(live.current.length).toBe(1);
  expect(live.current[0].id).toBe("msg-1");
});

it("liveThread destroy removes watcher so further writes do not trigger refresh", async () => {
  let messages: MessageDTO[] = [];
  const bridge = {
    call: vi.fn(async (method: string) => {
      if (method === "listMessages") return messages;
      return true;
    }),
  };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThread(() => "t1");
  flushSync(); await Promise.resolve(); flushSync();

  live.destroy();
  messages = [stubMsg];
  await local.applyMessageDeltas("t1", [stubMsg], [], 5);
  flushSync(); await Promise.resolve(); flushSync();

  // After destroy, list was not re-queried
  expect(live.current.length).toBe(0);
});

it("seedThreadMessages also bumps the thread version", async () => {
  let messages: MessageDTO[] = [];
  const bridge = {
    call: vi.fn(async (method: string) => {
      if (method === "listMessages") return messages;
      return true;
    }),
  };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThread(() => "t1");
  flushSync(); await Promise.resolve(); flushSync();

  messages = [stubMsg];
  await local.seedThreadMessages("t1", [stubMsg], 1, "14");
  flushSync(); await Promise.resolve(); flushSync();

  expect(live.current.length).toBe(1);
});
