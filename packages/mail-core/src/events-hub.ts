// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user mail event hub — a Durable Object (one instance per user id via
 * idFromName) that turns "a send failed" into a push instead of a DB poll.
 *
 * Transport is hibernatable WebSockets: subscribers' sockets are parked with
 * ctx.acceptWebSocket, so the DO is evicted from memory between events and
 * bills nothing while idle. Producers (the outbound consumer in
 * doota-mail-jobs, or the dev bridge in the web Worker) POST /notify, which
 * wakes the DO just long enough to fan the event out to parked sockets.
 *
 * The subscriber is not the browser: the web Worker's failedSends query.live
 * generator connects as a WebSocket client (mailEventStream) inside its
 * streaming request, so browser-facing transport stays query.live and auth
 * stays in the web Worker. The DB is only read when a stream connects,
 * reconnects, or an event actually arrives.
 *
 * The class is exported by doota-mail-jobs (a DO must live in a deployed
 * script); the web Worker reaches it through a cross-script binding
 * (script_name: "doota-mail-jobs").
 *
 * ponytail: no DO storage. Liveness via a ping/pong heartbeat: the DO
 * auto-responds "pong" to "ping" without waking from hibernation
 * (setWebSocketAutoResponse: no wake, no bill), and the subscriber ends its
 * stream when pongs stop. A half-open socket (dropped with no close event) is
 * thus detected and reconnected instead of hanging the stream forever.
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";

/**
 * Events pushed to a user's clients. Thin on purpose: subscribers re-read the
 * DB for display data (subject, reason, recipients); an event only says what
 * changed and where (thread/mailbox) to look.
 */
export type MailStateEvent = {
  type: "send_state";
  submissionId: string;
  threadId: string | null;
  /** New submission status (sent/delivered/failed/bounced_hard/…). */
  status: string;
};

/** New mail landed in a mailbox the user can read (external inbound or an
 * internal same-org delivery). Drives live inbox lists + unread badges. */
export type InboundMailEvent = {
  type: "inbound";
  threadId: string;
  mailboxId: string;
};

/** A durable notification (assigned / note / …) was written for the user: a
 * bare ping so the client refetches its unread count. new_mail / send_failed
 * already ride the inbound / send_state events; this covers the rest. */
export type NotificationEvent = {
  type: "notification";
};

export type MailEvent = MailStateEvent | InboundMailEvent | NotificationEvent;

export class MailEventHub {
  constructor(private readonly ctx: DurableObjectState) {
    // Heartbeat: pong parked "ping" frames while hibernating — no DO wake, no bill.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/notify") {
      const frame = await req.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(frame);
        } catch {
          // Socket already closing — its owner will reconnect.
        }
      }
      return new Response("ok");
    }

    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      // Hibernation API: the runtime holds the socket while the DO sleeps.
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("expected websocket or /notify", { status: 426 });
  }

  // Push-only hub: subscribers never send, so an inbound frame is a no-op, and
  // the runtime already discards closed sockets from getWebSockets().
  async webSocketMessage(): Promise<void> {}
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Close our end with a valid code so the pair tears down cleanly. 1005/1006
    // (no-status / abnormal) aren't sendable — normalize to 1000.
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    } catch {
      // already closed
    }
  }
  // A parked socket dropped abruptly (client vanished mid-stream). Without this
  // handler the Hibernation runtime has nowhere to deliver the error and surfaces
  // it as an uncaught DO exception ("Worker threw exception"). Absorb it: close
  // our side; the subscriber's stream reconnects + catch-up reads, losing nothing.
  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "socket error");
    } catch {
      // already gone
    }
  }
}

/**
 * Minimal structural surface of the binding: keeps tests trivial to fake and
 * avoids coupling call sites to a workers-types DurableObjectNamespace version.
 */
export type EventHubNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(
      input: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<Response>;
  };
};

/**
 * Best-effort state notification: wake the user's hub. Never throws; a
 * notification must not fail a job that already did its bookkeeping.
 * (The https://hub host is fictitious: a DO stub fetch needs a valid URL but
 * routes over the binding, never DNS — only the path matters.)
 */
export async function notifyMailState(
  hub: EventHubNamespace | undefined,
  userId: string | null,
  evt: Omit<MailStateEvent, "type">,
): Promise<void> {
  if (!hub || !userId) return;
  await post(hub, userId, JSON.stringify({ type: "send_state", ...evt } satisfies MailStateEvent));
}

/** Wake one user's bell: a durable notification (assigned / note) was written.
 * Best-effort; free when the binding is absent. */
export async function notifyNotification(
  hub: EventHubNamespace | undefined,
  userId: string,
): Promise<void> {
  if (!hub) return;
  await post(hub, userId, JSON.stringify({ type: "notification" } satisfies NotificationEvent));
}

/** One frame to one user's hub; swallow errors (streams self-heal on catch-up). */
async function post(hub: EventHubNamespace, userId: string, frame: string): Promise<void> {
  try {
    await hub.get(hub.idFromName(userId)).fetch("https://hub/notify", { method: "POST", body: frame });
  } catch {
    // Stream consumers self-heal via their catch-up read; drop it.
  }
}

/**
 * New-mail fan-out: a delivery landed in `mailboxId`, so wake every user holding
 * a mailbox_access grant on it (shared mailboxes have several). Called from
 * both delivery producers: the inbound consumer and the outbound consumer's
 * internal short-circuit. Best-effort like all hub traffic, and free when the
 * binding is absent.
 */
export async function notifyInboundMail(
  db: DrizzleD1Database<typeof schema>,
  hub: EventHubNamespace | undefined,
  mailboxId: string,
  threadId: string,
): Promise<void> {
  if (!hub) return;
  const users = await db
    .select({
      userId: schema.mailboxAccess.userId,
      canManage: schema.mailboxAccess.canManage,
      assignedOnly: schema.mailboxAccess.assignedOnly,
    })
    .from(schema.mailboxAccess)
    .where(eq(schema.mailboxAccess.mailboxId, mailboxId));
  if (!users.length) return;
  // Assigned-only members are woken only for their threads: a live ping for a
  // thread they can't open would be both noise and a leak.
  const restricted = users.filter((u) => u.assignedOnly && !u.canManage);
  let assigneeUserId: string | null = null;
  if (restricted.length) {
    const state = await db.query.threadState.findFirst({
      where: and(
        eq(schema.threadState.threadId, threadId),
        eq(schema.threadState.mailboxId, mailboxId),
      ),
      columns: { assigneeUserId: true },
    });
    assigneeUserId = state?.assigneeUserId ?? null;
  }
  const frame = JSON.stringify({ type: "inbound", threadId, mailboxId } satisfies InboundMailEvent);
  for (const u of users) {
    if (u.assignedOnly && !u.canManage && u.userId !== assigneeUserId) continue;
    await post(hub, u.userId, frame);
  }
}

/**
 * The notification seam for submission-status writers: resolves the sending
 * user + thread itself, so callers announce a transition with just the id and
 * new status, no per-caller lookup plumbing to forget or duplicate. Pass
 * `known` fields when already in scope to skip the resolving reads. All
 * lookups are gated on the hub existing (free when the binding is absent).
 */
export async function notifySubmissionState(
  db: DrizzleD1Database<typeof schema>,
  hub: EventHubNamespace | undefined,
  submissionId: string,
  status: string,
  known: { userId?: string | null; threadId?: string | null } = {},
): Promise<void> {
  if (!hub) return;
  let userId = known.userId;
  let threadId = known.threadId;
  if (userId === undefined || threadId === undefined) {
    const sub = await db.query.submission.findFirst({
      where: eq(schema.submission.id, submissionId),
      columns: { createdByUserId: true, messageId: true },
    });
    if (!sub) return;
    userId ??= sub.createdByUserId;
    if (threadId === undefined) {
      const msg = await db.query.message.findFirst({
        where: eq(schema.message.id, sub.messageId),
        columns: { threadId: true },
      });
      threadId = msg?.threadId ?? null;
    }
  }
  await notifyMailState(hub, userId ?? null, { submissionId, threadId: threadId ?? null, status });
}

/**
 * Subscribe to a user's events: connect a WebSocket to their hub and yield
 * each pushed event. Ends the iteration when the socket closes, and the
 * caller loops: catch-up read, then re-subscribe. Throws only if the
 * upgrade itself is refused.
 */
export async function* mailEventStream(
  hub: EventHubNamespace,
  userId: string,
): AsyncGenerator<MailEvent> {
  const res = await hub
    .get(hub.idFromName(userId))
    .fetch("https://hub/ws", { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`event hub refused websocket (${res.status})`);
  ws.accept();

  const queue: MailEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let lastSeen = Date.now();
  ws.addEventListener("message", (e) => {
    lastSeen = Date.now(); // any frame (a real event or a "pong") proves the socket lives
    try {
      queue.push(JSON.parse(String(e.data)) as MailEvent);
    } catch {
      // Unparseable frame (e.g. the "pong" heartbeat) — ignore; catch-up reads
      // keep the stream honest.
    }
    wake?.();
  });
  const end = () => {
    closed = true;
    wake?.();
  };
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);

  // Detect a half-open socket (dropped with no close event): the DO pongs each
  // "ping" without waking. If pongs stop, end the stream so the caller
  // reconnects + catch-up reads. DEAD_MS > 2·PING_MS to tolerate one lost frame.
  const PING_MS = 30_000;
  const DEAD_MS = 75_000;
  const beat = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_MS) return end();
    try {
      ws.send("ping");
    } catch {
      end();
    }
  }, PING_MS);

  try {
    while (!closed) {
      const evt = queue.shift();
      if (evt) {
        yield evt;
        continue;
      }
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  } finally {
    clearInterval(beat);
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
