// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { getDecryptedBlob, decryptContent, importKey } from "./crypto";
import { rawObjectToText } from "./mime";
import {
  evalRules,
  applyRuleOutcome,
  ruleSetNeedsBody,
  emptyOutcome,
  type RuleRow,
  type RuleMessageView,
} from "./rules";
import { log } from "./log";
import type { MailEnv } from "./inbound-worker";

type Db = DrizzleD1Database<typeof schema>;

/**
 * "Apply to existing messages" (build guide, Phase 2) — a resumable queue
 * backfill, never a synchronous action. The CURSOR LIVES IN D1
 * (rule.backfill_cursor), not the queue payload: a lost/evicted job resumes
 * from the row, progress (backfill_done) is UI-readable, and re-kicking is
 * idempotent. Cursor protocol: NULL = idle/finished, "" = kicked, "<delivery
 * id>" = mid-run.
 *
 * Deliberately applies only labels + move/junk to existing mail: no forwards
 * (re-forwarding history is a mail bomb), no markRead/snooze (retroactively
 * mutating read state surprises more than it helps).
 */
export type RuleBackfillJob = {
  kind: "rule_backfill";
  ruleId: string;
  /** The confirm dialog's explicit override of user-placed threads. */
  overrideUserPlacement: boolean;
};

const BATCH = 100;

/** Count of threads a backfill would move that the user placed by hand — the
 * number the confirm dialog must show before offering the override. */
export async function countUserPlacedMatches(db: Db, mailboxId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.threadState)
    .where(
      and(eq(schema.threadState.mailboxId, mailboxId), eq(schema.threadState.placementOrigin, "user")),
    );
  return rows[0]?.n ?? 0;
}

export async function kickRuleBackfill(
  db: Db,
  queue: Queue<RuleBackfillJob>,
  input: { ruleId: string; overrideUserPlacement: boolean },
): Promise<void> {
  await db
    .update(mail.rule)
    .set({ backfillCursor: "", backfillDone: 0, backfillStartedAt: new Date() })
    .where(eq(mail.rule.id, input.ruleId));
  await queue.send({ kind: "rule_backfill", ruleId: input.ruleId, overrideUserPlacement: input.overrideUserPlacement });
}

/**
 * One batch; re-enqueues itself until the mailbox is exhausted. Idempotent —
 * label application and placement writes converge, so a redelivered batch
 * re-processes at worst BATCH messages.
 */
export async function handleRuleBackfill(db: Db, env: MailEnv, job: RuleBackfillJob): Promise<void> {
  const rule = await db.query.rule.findFirst({ where: eq(schema.rule.id, job.ruleId) });
  if (!rule || !rule.enabled || rule.backfillCursor == null) return; // deleted/disabled/finished
  const ruleRow: RuleRow = {
    id: rule.id,
    name: rule.name,
    position: rule.position,
    enabled: rule.enabled,
    conditions: rule.conditions,
    actions: rule.actions,
    stopProcessing: rule.stopProcessing,
  };
  const needsBody = ruleSetNeedsBody([ruleRow]);
  const ck = await importKey(env.MAIL_DEK);

  const deliveries = await db
    .select({
      deliveryId: mail.delivery.id,
      messageId: mail.delivery.messageId,
    })
    .from(mail.delivery)
    .where(and(eq(mail.delivery.mailboxId, rule.mailboxId), gt(mail.delivery.id, rule.backfillCursor)))
    .orderBy(asc(mail.delivery.id))
    .limit(BATCH);

  let processed = 0;
  for (const del of deliveries) {
    processed++;
    const message = await db.query.message.findFirst({ where: eq(schema.message.id, del.messageId) });
    if (!message) continue;
    const view: RuleMessageView = {
      from: message.fromAddr,
      to: safeJsonArray(message.toAddrs),
      cc: safeJsonArray(message.ccAddrs),
      // Subject is encrypted at rest; a tier-1 decrypt of one D1 column, not R2.
      subject: (await decryptContent(ck, message.subjectEnc)) ?? null,
      listId: null, // not materialized on message — backfill list rules miss
      hasAttachment:
        ((await db.$count(mail.attachment, eq(mail.attachment.messageId, message.id))) ?? 0) > 0,
      size: null, // raw size not stored — backfill size rules miss
    };
    // The tier-2 gate: R2 is touched ONLY when the rule declares a body
    // condition (needsBody), and at most once per message.
    const outcome = await evalRules([ruleRow], view, async () => {
      if (!needsBody || !message.r2RawKey) return null;
      const buf = await getDecryptedBlob(env.MAIL_RAW, message.r2RawKey, ck);
      return buf ? await rawObjectToText(message.r2RawKey, buf) : null;
    });
    if (!outcome.matchedRuleIds.length) continue;
    // Backfill applies filing only — strip forwards/markRead/snooze.
    const filed = {
      ...emptyOutcome(),
      matchedRuleIds: outcome.matchedRuleIds,
      moveToLabelId: outcome.moveToLabelId,
      winningMoveRuleId: outcome.winningMoveRuleId,
      junk: outcome.junk,
      junkRuleId: outcome.junkRuleId,
      addLabelIds: outcome.addLabelIds,
      removeLabelIds: outcome.removeLabelIds,
    };
    await applyRuleOutcome(db, {
      mailboxId: rule.mailboxId,
      threadId: message.threadId,
      outcome: filed,
      overrideUserPlacement: job.overrideUserPlacement,
    });
  }

  const lastId = deliveries.length ? deliveries[deliveries.length - 1].deliveryId : null;
  const finished = deliveries.length < BATCH;
  await db
    .update(mail.rule)
    .set({
      backfillCursor: finished ? null : lastId,
      backfillDone: rule.backfillDone + processed,
    })
    .where(eq(mail.rule.id, rule.id));
  if (!finished) {
    if (!env.MAIL_QUEUE) return;
    await (env.MAIL_QUEUE as unknown as Queue<RuleBackfillJob>).send(job);
  } else {
    log.info("rules.backfill_done", { ruleId: rule.id, processed: rule.backfillDone + processed });
  }
}

function safeJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
