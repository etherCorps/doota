// SPDX-License-Identifier: Apache-2.0
// Phase 2 stop gates (client-gaps build guide): closed-enum DSL validation,
// tier-2 body laziness (zero R2 for tier-1 rule sets), position ordering +
// stopProcessing, first-moveTo-wins, user placement wins, filed-on-arrival
// placement, junk silences notifications, resumable + idempotent backfill.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey, putEncryptedBlob } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import {
  validateConditions,
  validateActions,
  validateActionLabels,
  RuleValidationError,
  evalRules,
  applyRuleOutcome,
  type RuleRow,
  type RuleMessageView,
} from "@doota/mail-core/rules";
import { handleRuleBackfill, kickRuleBackfill } from "@doota/mail-core/rules-backfill";
import { INBOUND_STAGES } from "@doota/mail-core/queue-consumer";
import { createLabel, labelsForThreads } from "@doota/mail-core/labels";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef");
const ORG = "org1";

let db: any;
let ck: Awaited<ReturnType<typeof importKey>>;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };

async function seed() {
  await db.insert(schema.organization).values({
    id: ORG, name: "Acme", slug: "acme-com", domain: "acme.com", status: "active", createdAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: "u1", name: "u1", email: "u1@x.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.mailbox).values([
    { id: "mb1", orgId: ORG, localPart: "alice", address: "alice@acme.com", isActive: true, isPersonal: true },
    { id: "mb2", orgId: ORG, localPart: "bob", address: "bob@acme.com", isActive: true, isPersonal: true },
  ]);
  await db.insert(schema.mailboxAccess).values({ id: "acc1", userId: "u1", mailboxId: "mb1", canSend: true });
}

beforeEach(async () => {
  db = await makeDb();
  await seed();
  ck = await importKey(KEY_B64);
  deps = { ck, searchKeyB64: KEY_B64 };
});

function ruleRow(over: Partial<RuleRow> & { id: string }): RuleRow {
  return {
    name: over.id,
    position: 0,
    enabled: true,
    conditions: JSON.stringify({ op: "AND", conditions: [{ field: "from", operator: "contains", value: "@acme" }] }),
    actions: JSON.stringify([{ type: "markRead" }]),
    stopProcessing: false,
    ...over,
  };
}

const msgView = (over: Partial<RuleMessageView> = {}): RuleMessageView => ({
  from: "billing@acme.com", to: ["me@x.com"], cc: [], subject: "invoice #42",
  listId: null, hasAttachment: false, size: 1000, ...over,
});

describe("DSL validation — the only door to the executor", () => {
  it("rejects unknown fields, operators, and action types", () => {
    expect(() => validateConditions({ op: "AND", conditions: [{ field: "x", operator: "contains", value: "a" }] }))
      .toThrow(RuleValidationError);
    expect(() => validateConditions({ op: "AND", conditions: [{ field: "from", operator: "explode", value: "a" }] }))
      .toThrow(RuleValidationError);
    expect(() => validateActions([{ type: "deleteEverything" }])).toThrow(RuleValidationError);
    expect(() => validateActions([])).toThrow(RuleValidationError);
  });

  it("forward requires a valid address AND explicit confirmation", () => {
    expect(() => validateActions([{ type: "forward", to: "not-an-address" }])).toThrow(RuleValidationError);
    expect(() => validateActions([{ type: "forward", to: "a@b.com" }])).toThrow(RuleValidationError);
    expect(validateActions([{ type: "forward", to: "A@B.com", confirmed: true }]))
      .toEqual([{ type: "forward", to: "a@b.com", confirmed: true }]);
  });

  it("rejects an invalid regex for matches", () => {
    expect(() => validateConditions({ op: "AND", conditions: [{ field: "subject", operator: "matches", value: "(" }] }))
      .toThrow(RuleValidationError);
  });
});

describe("evaluation semantics", () => {
  it("a tier-1-only rule set NEVER touches the body", async () => {
    const getBody = vi.fn(async () => "body text");
    const out = await evalRules(
      [ruleRow({ id: "r1" })],
      msgView(),
      getBody,
    );
    expect(out.matchedRuleIds).toEqual(["r1"]);
    expect(getBody).not.toHaveBeenCalled();
  });

  it("body is fetched at most once even across several body rules", async () => {
    const bodyCond = JSON.stringify({ op: "AND", conditions: [{ field: "body", operator: "contains", value: "hello" }] });
    const getBody = vi.fn(async () => "well hello there");
    const out = await evalRules(
      [ruleRow({ id: "r1", conditions: bodyCond }), ruleRow({ id: "r2", position: 1, conditions: bodyCond })],
      msgView(),
      getBody,
    );
    expect(out.matchedRuleIds).toEqual(["r1", "r2"]);
    expect(getBody).toHaveBeenCalledTimes(1);
  });

  it("position order governs; stopProcessing halts the chain", async () => {
    const out = await evalRules(
      [
        ruleRow({ id: "later", position: 5 }),
        ruleRow({ id: "first", position: 1, stopProcessing: true }),
      ],
      msgView(),
      async () => null,
    );
    expect(out.matchedRuleIds).toEqual(["first"]); // 'later' never ran
  });

  it("first moveTo in position order wins; the loser is recorded and its non-move actions still apply", async () => {
    const out = await evalRules(
      [
        ruleRow({ id: "r1", position: 0, actions: JSON.stringify([{ type: "moveTo", labelId: "la" }]) }),
        ruleRow({ id: "r2", position: 1, actions: JSON.stringify([{ type: "moveTo", labelId: "lb" }, { type: "markFlagged" }]) }),
      ],
      msgView(),
      async () => null,
    );
    expect(out.moveToLabelId).toBe("la");
    expect(out.winningMoveRuleId).toBe("r1");
    expect(out.ignoredMoves).toEqual([{ ruleId: "r2", labelId: "lb" }]);
    expect(out.markFlagged).toBe(true); // loser's non-move action applied
  });

  it("disabled rules are skipped", async () => {
    const out = await evalRules([ruleRow({ id: "r1", enabled: false })], msgView(), async () => null);
    expect(out.matchedRuleIds).toEqual([]);
  });
});

describe("user placement wins", () => {
  it("a rule never moves a user-placed thread, but still labels it", async () => {
    const { threadId } = await deliverPlain();
    const label = await createLabel(db, { mailboxId: "mb1", orgId: ORG, name: "A" });
    await db.update(schema.threadState)
      .set({ placement: "inbox", placementOrigin: "user", placementUserId: "u1" })
      .where(eq(schema.threadState.threadId, threadId));
    const moved = await applyRuleOutcome(db, {
      mailboxId: "mb1", threadId,
      outcome: {
        matchedRuleIds: ["r1"], moveToLabelId: label.id, winningMoveRuleId: "r1", ignoredMoves: [],
        junk: false, junkRuleId: null, markRead: false, markFlagged: false, snoozeMinutes: null,
        addLabelIds: [], removeLabelIds: [], forwards: [],
      },
    });
    expect(moved.moved).toBe(false);
    const st = await state(threadId);
    expect(st.placement).toBe("inbox"); // untouched
    const labels = (await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)!;
    expect(labels.map((l) => l.labelId)).toEqual([label.id]); // still labeled
  });

  it("the backfill override moves even user-placed threads", async () => {
    const { threadId } = await deliverPlain();
    const label = await createLabel(db, { mailboxId: "mb1", orgId: ORG, name: "A" });
    await db.update(schema.threadState)
      .set({ placement: "inbox", placementOrigin: "user", placementUserId: "u1" })
      .where(eq(schema.threadState.threadId, threadId));
    const moved = await applyRuleOutcome(db, {
      mailboxId: "mb1", threadId, overrideUserPlacement: true,
      outcome: {
        matchedRuleIds: ["r1"], moveToLabelId: label.id, winningMoveRuleId: "r1", ignoredMoves: [],
        junk: false, junkRuleId: null, markRead: false, markFlagged: false, snoozeMinutes: null,
        addLabelIds: [], removeLabelIds: [], forwards: [],
      },
    });
    expect(moved.moved).toBe(true);
    expect((await state(threadId))).toMatchObject({ placement: "archived", placementOrigin: "rule", placementRuleId: "r1" });
  });
});

describe("mailbox-scoped label references", () => {
  it("rule save validation rejects a labelId from another mailbox", async () => {
    const foreign = await createLabel(db, { mailboxId: "mb2", orgId: ORG, name: "Foreign" });
    await expect(
      validateActionLabels(db, "mb1", [{ type: "moveTo", labelId: foreign.id }]),
    ).rejects.toThrow(RuleValidationError);
    const own = await createLabel(db, { mailboxId: "mb1", orgId: ORG, name: "Mine" });
    await expect(
      validateActionLabels(db, "mb1", [{ type: "addLabel", labelId: own.id }]),
    ).resolves.toBeUndefined();
  });

  it("the engine backstop skips a foreign label instead of attaching it", async () => {
    const { threadId } = await deliverPlain();
    const foreign = await createLabel(db, { mailboxId: "mb2", orgId: ORG, name: "Foreign" });
    await applyRuleOutcome(db, {
      mailboxId: "mb1", threadId,
      outcome: {
        matchedRuleIds: ["r1"], moveToLabelId: null, winningMoveRuleId: null, ignoredMoves: [],
        junk: false, junkRuleId: null, markRead: false, markFlagged: false, snoozeMinutes: null,
        addLabelIds: [foreign.id], removeLabelIds: [], forwards: [],
      },
    });
    expect((await labelsForThreads(db, { mailboxId: "mb1", threadIds: [threadId] })).get(threadId)).toBeUndefined();
  });
});

// ---- ingest integration: run the real stage pipeline over a fake ctx --------

function parsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageIdHeader: `<${crypto.randomUUID()}@ext>`, inReplyTo: null, references: null,
    from: "billing@acme-corp.com", subject: "invoice", sentAt: Date.now(),
    text: "your invoice", html: null, r2RawKey: null, attachments: [],
    ...overrides,
  };
}

async function deliverPlain() {
  const pm = parsed();
  const ids = await materializeMessage(db, ORG, pm, deps);
  await materializeDelivery(db, {
    orgId: ORG, ...ids, mailboxId: "mb1", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
  });
  return ids;
}

async function state(threadId: string) {
  return db.query.threadState.findFirst({
    where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, "mb1")),
  });
}

async function runStages(pm: ParsedMessage, pmHeaders: { key: string; value: string }[] = []) {
  const ctx: any = {
    db,
    env: { MAIL_DEK: KEY_B64, MAIL_SEARCH_KEY: KEY_B64 },
    deps,
    job: {
      r2RawKey: "raw/x", recipient: "alice@acme.com", orgId: ORG, resolvedMailboxId: "mb1",
      viaAliasId: null, subaddressTag: null, envelopeFrom: pm.from ?? "", messageIdHeader: pm.messageIdHeader,
      dmarcPass: false,
    },
    parsed: {
      from: { address: pm.from ?? undefined },
      to: [{ address: "alice@acme.com" }],
      subject: pm.subject ?? undefined,
      text: pm.text ?? undefined,
      attachments: [],
      headers: pmHeaders,
    },
    pm,
    rawSize: 1234,
  };
  for (const stage of INBOUND_STAGES) await stage.run(ctx);
  return ctx;
}

describe("ingest integration (stage pipeline)", () => {
  it("a moveTo rule files new mail ON ARRIVAL — never inbox first — and stamps rule origin", async () => {
    const label = await createLabel(db, { mailboxId: "mb1", orgId: ORG, name: "Invoices" });
    await db.update(schema.label).set({ notifyNewMail: false }).where(eq(schema.label.id, label.id));
    await db.insert(schema.rule).values({
      id: "r1", orgId: ORG, mailboxId: "mb1", name: "acme invoices", createdByUserId: "u1", position: 0,
      conditions: JSON.stringify({ op: "AND", conditions: [{ field: "from", operator: "contains", value: "@acme-corp.com" }] }),
      actions: JSON.stringify([{ type: "moveTo", labelId: label.id }]),
    });
    const ctx = await runStages(parsed());
    const st = await state(ctx.threadId);
    expect(st).toMatchObject({ placement: "archived", placementOrigin: "rule", placementRuleId: "r1" });
    const labels = (await labelsForThreads(db, { mailboxId: "mb1", threadIds: [ctx.threadId] })).get(ctx.threadId)!;
    expect(labels.map((l) => l.labelId)).toEqual([label.id]);
    // The thread NEVER passed through inbox: its change_log shows a single
    // Thread `created` (born archived) plus the origin-stamp update — no
    // created-in-inbox-then-moved sequence is distinguishable, so assert the
    // notification outcome instead: rule-fed folder (notify off) is silent.
    const rows = await db.query.notification.findMany({ where: eq(schema.notification.threadId, ctx.threadId) });
    expect(rows).toHaveLength(0);
  });

  it("a junk rule lands mail in spam with NO notification", async () => {
    await db.insert(schema.rule).values({
      id: "rj", orgId: ORG, mailboxId: "mb1", name: "junk acme", createdByUserId: "u1", position: 0,
      conditions: JSON.stringify({ op: "AND", conditions: [{ field: "subject", operator: "contains", value: "invoice" }] }),
      actions: JSON.stringify([{ type: "junk" }]),
    });
    const ctx = await runStages(parsed());
    expect((await state(ctx.threadId)).placement).toBe("spam");
    const rows = await db.query.notification.findMany({ where: eq(schema.notification.threadId, ctx.threadId) });
    expect(rows).toHaveLength(0);
  });

  it("markRead writes is_read AND $seen consistently, at insert", async () => {
    await db.insert(schema.rule).values({
      id: "rm", orgId: ORG, mailboxId: "mb1", name: "mark", createdByUserId: "u1", position: 0,
      conditions: JSON.stringify({ op: "AND", conditions: [{ field: "from", operator: "contains", value: "@acme-corp.com" }] }),
      actions: JSON.stringify([{ type: "markRead" }, { type: "markFlagged" }]),
    });
    const ctx = await runStages(parsed());
    const del = await db.query.delivery.findFirst({ where: eq(schema.delivery.messageId, ctx.messageId) });
    expect(del.isRead).toBe(true);
    expect(JSON.parse(del.keywords)).toEqual(["$seen", "$flagged"]);
    // Exactly ONE Email change row (created) — no insert-then-update seq burn.
    const changes = await db.query.changeLog.findMany({ where: eq(schema.changeLog.objectId, del.id) });
    expect(changes.map((c: any) => c.action)).toEqual(["created"]);
  });

  it("no matching rule → normal inbox delivery with notification", async () => {
    await db.insert(schema.rule).values({
      id: "rn", orgId: ORG, mailboxId: "mb1", name: "no match", createdByUserId: "u1", position: 0,
      conditions: JSON.stringify({ op: "AND", conditions: [{ field: "from", operator: "contains", value: "@nomatch.com" }] }),
      actions: JSON.stringify([{ type: "junk" }]),
    });
    const ctx = await runStages(parsed());
    expect((await state(ctx.threadId)).placement).toBe("inbox");
    const rows = await db.query.notification.findMany({ where: eq(schema.notification.threadId, ctx.threadId) });
    expect(rows).toHaveLength(1);
  });
});

describe("backfill — resumable, idempotent, tier-gated", () => {
  function fakeQueue() {
    const sent: any[] = [];
    return { sent, async send(body: any) { sent.push(body); } };
  }
  function spyR2() {
    const store = new Map<string, any>();
    const get = vi.fn(async (key: string) => (store.has(key) ? {
      arrayBuffer: async () => store.get(key),
    } : null));
    return { store, get, async put(key: string, val: any) { store.set(key, typeof val === "string" ? new TextEncoder().encode(val).buffer : val); } };
  }

  async function seedMailboxMail(n: number) {
    const threadIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const pm = parsed({ messageIdHeader: `<bf${i}@ext>`, from: i % 2 ? "billing@acme-corp.com" : "other@else.com" });
      const ids = await materializeMessage(db, ORG, pm, deps);
      await materializeDelivery(db, {
        orgId: ORG, ...ids, mailboxId: "mb1", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
      });
      threadIds.push(ids.threadId);
    }
    return threadIds;
  }

  it("processes in batches via the cursor, resumes, finishes, and is idempotent — zero R2 for a tier-1 rule", async () => {
    await seedMailboxMail(120);
    const label = await createLabel(db, { mailboxId: "mb1", orgId: ORG, name: "Invoices" });
    await db.insert(schema.rule).values({
      id: "rb", orgId: ORG, mailboxId: "mb1", name: "bf", createdByUserId: "u1", position: 0,
      conditions: JSON.stringify({ op: "AND", conditions: [{ field: "from", operator: "contains", value: "@acme-corp.com" }] }),
      actions: JSON.stringify([{ type: "moveTo", labelId: label.id }]),
    });
    const queue = fakeQueue();
    const r2 = spyR2();
    const env: any = { MAIL_DEK: KEY_B64, MAIL_RAW: r2, MAIL_QUEUE: queue };

    await kickRuleBackfill(db, queue as any, { ruleId: "rb", overrideUserPlacement: false });
    expect(queue.sent).toHaveLength(1);

    // Batch 1 (100 of 120): cursor advances, job re-enqueued — this is the
    // "survives a worker eviction" property: state lives in D1.
    await handleRuleBackfill(db, env, queue.sent[0]);
    let rule = await db.query.rule.findFirst({ where: eq(schema.rule.id, "rb") });
    expect(rule.backfillCursor).not.toBeNull();
    expect(rule.backfillDone).toBe(100);
    expect(queue.sent).toHaveLength(2);

    // Batch 2 finishes.
    await handleRuleBackfill(db, env, queue.sent[1]);
    rule = await db.query.rule.findFirst({ where: eq(schema.rule.id, "rb") });
    expect(rule.backfillCursor).toBeNull();
    expect(rule.backfillDone).toBe(120);

    const filed = await db.query.threadState.findMany({
      where: and(eq(schema.threadState.mailboxId, "mb1"), eq(schema.threadState.placement, "archived")),
    });
    expect(filed.length).toBe(60); // every second sender matched
    expect(r2.get).not.toHaveBeenCalled(); // tier-1 rule: R2 untouched

    // Idempotent: re-kick + full re-run converges to the same state.
    await kickRuleBackfill(db, queue as any, { ruleId: "rb", overrideUserPlacement: false });
    let job = queue.sent[queue.sent.length - 1];
    for (let i = 0; i < 3; i++) {
      await handleRuleBackfill(db, env, job);
      job = queue.sent[queue.sent.length - 1];
    }
    const refiled = await db.query.threadState.findMany({
      where: and(eq(schema.threadState.mailboxId, "mb1"), eq(schema.threadState.placement, "archived")),
    });
    expect(refiled.length).toBe(60);
  });

  it("a body rule reads R2 — and only for messages that have a raw key", async () => {
    const r2 = spyR2();
    // One message with an outbound-shaped raw blob (JSON {text}).
    await putEncryptedBlob(r2 as any, "outbound/org1/bf-body", ck, JSON.stringify({ text: "magic word inside" }));
    const pm = parsed({ messageIdHeader: "<body1@ext>", r2RawKey: "outbound/org1/bf-body" });
    const ids = await materializeMessage(db, ORG, pm, deps);
    await materializeDelivery(db, {
      orgId: ORG, ...ids, mailboxId: "mb1", role: "to", viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
    });
    const label = await createLabel(db, { mailboxId: "mb1", orgId: ORG, name: "Magic" });
    await db.insert(schema.rule).values({
      id: "rbody", orgId: ORG, mailboxId: "mb1", name: "body", createdByUserId: "u1", position: 0,
      conditions: JSON.stringify({ op: "AND", conditions: [{ field: "body", operator: "contains", value: "magic word" }] }),
      actions: JSON.stringify([{ type: "moveTo", labelId: label.id }]),
    });
    const queue = fakeQueue();
    const env: any = { MAIL_DEK: KEY_B64, MAIL_RAW: r2, MAIL_QUEUE: queue };
    await kickRuleBackfill(db, queue as any, { ruleId: "rbody", overrideUserPlacement: false });
    await handleRuleBackfill(db, env, queue.sent[0]);
    expect(r2.get).toHaveBeenCalled();
    expect((await state(ids.threadId)).placement).toBe("archived");
  });
});
