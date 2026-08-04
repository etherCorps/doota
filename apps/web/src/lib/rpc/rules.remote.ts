// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, asc, eq, max } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { getAuthz } from "$lib/server/authz.js";
import {
  validateConditions,
  validateActions,
  RuleValidationError,
  type RuleAction,
} from "@doota/mail-core/rules";
import {
  kickRuleBackfill,
  countUserPlacedMatches,
  type RuleBackfillJob,
} from "@doota/mail-core/rules-backfill";

/**
 * Rules rpc. Rules are per MAILBOX (evaluation runs at ingest for that
 * mailbox); a mailbox grant is the write gate — same chokepoint as filing by
 * hand. The DSL is validated here via the closed-enum validators; nothing
 * unvalidated ever reaches the executor.
 */

async function grantOn(mailboxId: string) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true },
  });
  if (!box) error(404, "Mailbox not found");
  const { mailboxIds } = await getAuthz();
  if (!mailboxIds.includes(mailboxId)) error(403, "You need access to this mailbox.");
  return { box, user: locals.user, db: locals.db };
}

function validated(conditions: unknown, actions: unknown) {
  try {
    return { conditions: validateConditions(conditions), actions: validateActions(actions) };
  } catch (e) {
    if (e instanceof RuleValidationError) error(400, e.message);
    throw e;
  }
}

/** Labels a rule set files into — folders these feed get the ✱ badge. */
function filedLabelIds(actions: RuleAction[]): string[] {
  return actions
    .filter((a): a is Extract<RuleAction, { labelId: string }> => a.type === "moveTo" || a.type === "addLabel")
    .map((a) => a.labelId);
}

export const mailboxRules = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { db } = await grantOn(mailboxId);
  const rows = await db.query.rule.findMany({
    where: eq(schema.rule.mailboxId, mailboxId),
    orderBy: asc(schema.rule.position),
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    enabled: r.enabled,
    conditions: JSON.parse(r.conditions),
    actions: JSON.parse(r.actions),
    stopProcessing: r.stopProcessing,
    backfill: {
      running: r.backfillCursor != null,
      done: r.backfillDone,
      startedAt: r.backfillStartedAt ? r.backfillStartedAt.getTime() : null,
    },
  }));
});

export const createRule = command(
  z.object({
    mailboxId: z.string().min(1),
    name: z.string().trim().min(1).max(80),
    conditions: z.unknown(),
    actions: z.unknown(),
    stopProcessing: z.boolean().default(false),
  }),
  async (input) => {
    const { box, user, db } = await grantOn(input.mailboxId);
    const { conditions, actions } = validated(input.conditions, input.actions);
    const [{ maxPos }] = await db
      .select({ maxPos: max(mail.rule.position) })
      .from(mail.rule)
      .where(eq(mail.rule.mailboxId, input.mailboxId));
    const [row] = await db
      .insert(mail.rule)
      .values({
        orgId: box.orgId,
        mailboxId: input.mailboxId,
        name: input.name,
        createdByUserId: user.id,
        position: (maxPos ?? -1) + 1,
        conditions: JSON.stringify(conditions),
        actions: JSON.stringify(actions),
        stopProcessing: input.stopProcessing,
      })
      .returning({ id: mail.rule.id });
    // Rule-fed folders default to notifications OFF (build guide: filing away
    // mail that still buzzes achieves nothing). Creation-time only — a later
    // manual re-enable is respected.
    const fed = filedLabelIds(actions);
    if (fed.length) {
      await db
        .update(mail.label)
        .set({ notifyNewMail: false })
        .where(and(eq(mail.label.orgId, box.orgId), eq(mail.label.id, fed[0])));
    }
    return { ok: true as const, id: row.id };
  },
);

export const updateRule = command(
  z.object({
    mailboxId: z.string().min(1),
    ruleId: z.string().min(1),
    name: z.string().trim().min(1).max(80).optional(),
    conditions: z.unknown().optional(),
    actions: z.unknown().optional(),
    stopProcessing: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }),
  async (input) => {
    const { db } = await grantOn(input.mailboxId);
    const existing = await db.query.rule.findFirst({
      where: and(eq(schema.rule.id, input.ruleId), eq(schema.rule.mailboxId, input.mailboxId)),
    });
    if (!existing) error(404, "Rule not found");
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.stopProcessing !== undefined) set.stopProcessing = input.stopProcessing;
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (input.conditions !== undefined || input.actions !== undefined) {
      const { conditions, actions } = validated(
        input.conditions ?? JSON.parse(existing.conditions),
        input.actions ?? JSON.parse(existing.actions),
      );
      set.conditions = JSON.stringify(conditions);
      set.actions = JSON.stringify(actions);
    }
    if (Object.keys(set).length) {
      await db.update(mail.rule).set(set).where(eq(mail.rule.id, input.ruleId));
    }
    return { ok: true as const };
  },
);

export const deleteRule = command(
  z.object({ mailboxId: z.string().min(1), ruleId: z.string().min(1) }),
  async ({ mailboxId, ruleId }) => {
    const { db } = await grantOn(mailboxId);
    await db
      .delete(mail.rule)
      .where(and(eq(mail.rule.id, ruleId), eq(mail.rule.mailboxId, mailboxId)));
    return { ok: true as const };
  },
);

export const reorderRules = command(
  z.object({ mailboxId: z.string().min(1), ruleIds: z.array(z.string().min(1)).min(1).max(200) }),
  async ({ mailboxId, ruleIds }) => {
    const { db } = await grantOn(mailboxId);
    for (let position = 0; position < ruleIds.length; position++) {
      await db
        .update(mail.rule)
        .set({ position })
        .where(and(eq(mail.rule.id, ruleIds[position]), eq(mail.rule.mailboxId, mailboxId)));
    }
    return { ok: true as const };
  },
);

/** The count the "apply to existing" confirm dialog must show before offering
 * the user-placement override. */
export const backfillPreview = query(
  z.object({ mailboxId: z.string().min(1) }),
  async ({ mailboxId }) => {
    const { db } = await grantOn(mailboxId);
    return { userPlacedThreads: await countUserPlacedMatches(db, mailboxId) };
  },
);

export const applyRuleToExisting = command(
  z.object({
    mailboxId: z.string().min(1),
    ruleId: z.string().min(1),
    overrideUserPlacement: z.boolean().default(false),
  }),
  async ({ mailboxId, ruleId, overrideUserPlacement }) => {
    const { db } = await grantOn(mailboxId);
    const existing = await db.query.rule.findFirst({
      where: and(eq(schema.rule.id, ruleId), eq(schema.rule.mailboxId, mailboxId)),
      columns: { id: true },
    });
    if (!existing) error(404, "Rule not found");
    const queue = getRequestEvent().platform?.env?.MAIL_QUEUE as Queue<RuleBackfillJob> | undefined;
    if (!queue) error(500, "Mail queue is not configured.");
    await kickRuleBackfill(db, queue, { ruleId, overrideUserPlacement });
    return { ok: true as const };
  },
);

/** "Why is this here?" — the sheet behind the ✱ chip. */
export const whyHere = query(
  z.object({ mailboxId: z.string().min(1), threadId: z.string().min(1) }),
  async ({ mailboxId, threadId }) => {
    const { db } = await grantOn(mailboxId);
    const state = await db.query.threadState.findFirst({
      where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.mailboxId, mailboxId)),
      columns: { placement: true, placementOrigin: true, placementRuleId: true, placementUserId: true, placementAt: true },
    });
    if (!state) error(404, "Thread is not in this mailbox.");
    let ruleName: string | null = null;
    let ruleConditions: unknown = null;
    if (state.placementRuleId) {
      const ruleRow = await db.query.rule.findFirst({
        where: eq(schema.rule.id, state.placementRuleId),
        columns: { name: true, conditions: true },
      });
      ruleName = ruleRow?.name ?? null;
      ruleConditions = ruleRow ? JSON.parse(ruleRow.conditions) : null;
    }
    let movedByName: string | null = null;
    if (state.placementUserId) {
      const mover = await db.query.user.findFirst({
        where: eq(schema.user.id, state.placementUserId),
        columns: { name: true },
      });
      movedByName = mover?.name ?? null;
    }
    return {
      placement: state.placement,
      origin: state.placementOrigin,
      at: state.placementAt ? state.placementAt.getTime() : null,
      rule: state.placementRuleId ? { id: state.placementRuleId, name: ruleName, conditions: ruleConditions } : null,
      movedBy: state.placementUserId ? { id: state.placementUserId, name: movedByName } : null,
    };
  },
);
