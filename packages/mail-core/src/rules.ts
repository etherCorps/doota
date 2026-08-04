// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { applyLabel, removeLabel, LabelError } from "./labels";
import { log } from "./log";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Rules engine (build guide, Phase 2). Pure evaluation: rules in, one merged
 * RuleOutcome out — application (labels, placement, forward, notification
 * suppression) lives at the pipeline's rulesEval/placement stages and in the
 * backfill job, so spam (Phase 5) and vacation (Phase 4) can reuse the same
 * evaluator as built-in rule kinds.
 *
 * Two-tier conditions: tier 1 (from/to/cc/subject/listId/hasAttachment/size)
 * is free — already in memory after the metadata stage. tier 2 (`body`) is
 * only materialized when a rule in the ACTIVE set declares a body condition
 * (`ruleSetNeedsBody`, computed once per set): at ingest the parsed text is
 * already in memory, but the backfill must fetch + decrypt from R2 — a
 * mailbox with no body rules must never touch R2 during rules eval.
 */

export type RuleField = "from" | "to" | "cc" | "subject" | "listId" | "hasAttachment" | "size" | "body";
export type RuleOperator = "contains" | "equals" | "matches" | "gt" | "lt";
export type RuleCondition = { field: RuleField; operator: RuleOperator; value: string | number | boolean };
export type RuleConditions = { op: "AND" | "OR"; conditions: RuleCondition[] };

export type RuleAction =
  | { type: "addLabel"; labelId: string }
  | { type: "removeLabel"; labelId: string }
  | { type: "moveTo"; labelId: string }
  | { type: "markRead" }
  | { type: "markFlagged" }
  | { type: "junk" }
  | { type: "snooze"; minutes: number }
  // `confirmed` must be true at write time (UI double-confirm) — a forward
  // target is an exfiltration path on a compromised account.
  | { type: "forward"; to: string; confirmed: true }
  | { type: "stopProcessing" };

const FIELDS = new Set<RuleField>(["from", "to", "cc", "subject", "listId", "hasAttachment", "size", "body"]);
const OPERATORS = new Set<RuleOperator>(["contains", "equals", "matches", "gt", "lt"]);
const ACTION_TYPES = new Set([
  "addLabel", "removeLabel", "moveTo", "markRead", "markFlagged", "junk", "snooze", "forward", "stopProcessing",
]);
const MAX_CONDITIONS = 20;
const MAX_ACTIONS = 10;
const MAX_VALUE_LEN = 200;
const MAX_SNOOZE_MINUTES = 60 * 24 * 365;

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleValidationError";
  }
}

/** Closed-enum validation — the ONLY door to the executor. Throws on anything
 * outside the DSL; returns normalized objects safe to JSON.stringify. */
export function validateConditions(input: unknown): RuleConditions {
  if (typeof input !== "object" || input === null) throw new RuleValidationError("conditions must be an object");
  const obj = input as Record<string, unknown>;
  if (obj.op !== "AND" && obj.op !== "OR") throw new RuleValidationError("conditions.op must be AND or OR");
  if (!Array.isArray(obj.conditions) || obj.conditions.length === 0 || obj.conditions.length > MAX_CONDITIONS) {
    throw new RuleValidationError(`conditions must hold 1–${MAX_CONDITIONS} entries`);
  }
  const out: RuleCondition[] = [];
  for (const raw of obj.conditions) {
    const c = raw as Record<string, unknown>;
    if (!FIELDS.has(c.field as RuleField)) throw new RuleValidationError(`unknown field: ${String(c.field)}`);
    if (!OPERATORS.has(c.operator as RuleOperator)) throw new RuleValidationError(`unknown operator: ${String(c.operator)}`);
    const field = c.field as RuleField;
    const operator = c.operator as RuleOperator;
    if (field === "size") {
      if (operator !== "gt" && operator !== "lt") throw new RuleValidationError("size supports gt/lt");
      if (typeof c.value !== "number" || !Number.isFinite(c.value) || c.value < 0)
        throw new RuleValidationError("size value must be a non-negative number");
    } else if (field === "hasAttachment") {
      if (operator !== "equals") throw new RuleValidationError("hasAttachment supports equals");
      if (typeof c.value !== "boolean") throw new RuleValidationError("hasAttachment value must be boolean");
    } else {
      if (operator === "gt" || operator === "lt") throw new RuleValidationError(`${field} does not support gt/lt`);
      if (typeof c.value !== "string" || c.value.length === 0 || c.value.length > MAX_VALUE_LEN)
        throw new RuleValidationError(`${field} value must be a string of 1–${MAX_VALUE_LEN} chars`);
      if (operator === "matches") {
        try {
          new RegExp(c.value, "i");
        } catch {
          throw new RuleValidationError("matches value is not a valid regular expression");
        }
      }
    }
    out.push({ field, operator, value: c.value as string | number | boolean });
  }
  return { op: obj.op, conditions: out };
}

export function validateActions(input: unknown): RuleAction[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ACTIONS)
    throw new RuleValidationError(`actions must hold 1–${MAX_ACTIONS} entries`);
  const out: RuleAction[] = [];
  for (const raw of input) {
    const a = raw as Record<string, unknown>;
    if (!ACTION_TYPES.has(a.type as string)) throw new RuleValidationError(`unknown action: ${String(a.type)}`);
    switch (a.type) {
      case "addLabel":
      case "removeLabel":
      case "moveTo":
        if (typeof a.labelId !== "string" || !a.labelId) throw new RuleValidationError(`${a.type} needs labelId`);
        out.push({ type: a.type, labelId: a.labelId });
        break;
      case "snooze":
        if (typeof a.minutes !== "number" || a.minutes <= 0 || a.minutes > MAX_SNOOZE_MINUTES)
          throw new RuleValidationError("snooze needs minutes in (0, 1y]");
        out.push({ type: "snooze", minutes: a.minutes });
        break;
      case "forward": {
        if (typeof a.to !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.to))
          throw new RuleValidationError("forward needs a valid destination address");
        if (a.confirmed !== true)
          throw new RuleValidationError("forward destination must be explicitly confirmed");
        out.push({ type: "forward", to: a.to.toLowerCase(), confirmed: true });
        break;
      }
      default:
        out.push({ type: a.type } as RuleAction);
    }
  }
  return out;
}

/** What one message looks like to the evaluator (tier 1 in memory; body lazy). */
export type RuleMessageView = {
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  listId: string | null;
  hasAttachment: boolean;
  /** Raw size in bytes; null when unknown (backfill) — size conditions then miss. */
  size: number | null;
};

export type RuleRow = {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: string;
  actions: string;
  stopProcessing: boolean;
};

/** Merged result of one evaluation pass, ready for the placement stage. */
export type RuleOutcome = {
  matchedRuleIds: string[];
  /** First moveTo in position order wins; later ones land in ignoredMoves. */
  moveToLabelId: string | null;
  winningMoveRuleId: string | null;
  ignoredMoves: { ruleId: string; labelId: string }[];
  junk: boolean;
  junkRuleId: string | null;
  markRead: boolean;
  markFlagged: boolean;
  snoozeMinutes: number | null;
  addLabelIds: string[];
  removeLabelIds: string[];
  forwards: { ruleId: string; to: string }[];
};

export function emptyOutcome(): RuleOutcome {
  return {
    matchedRuleIds: [],
    moveToLabelId: null,
    winningMoveRuleId: null,
    ignoredMoves: [],
    junk: false,
    junkRuleId: null,
    markRead: false,
    markFlagged: false,
    snoozeMinutes: null,
    addLabelIds: [],
    removeLabelIds: [],
    forwards: [],
  };
}

/** True when any ENABLED rule declares a body condition — computed once per
 * set; gates the (backfill-time) R2 fetch + decrypt. */
export function ruleSetNeedsBody(rules: RuleRow[]): boolean {
  return rules.some((r) => {
    if (!r.enabled) return false;
    try {
      return (JSON.parse(r.conditions) as RuleConditions).conditions.some((c) => c.field === "body");
    } catch {
      return false;
    }
  });
}

function matchText(operator: RuleOperator, haystack: string | null, needle: string): boolean {
  if (haystack == null) return false;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (operator === "contains") return h.includes(n);
  if (operator === "equals") return h === n;
  if (operator === "matches") {
    try {
      return new RegExp(needle, "i").test(haystack);
    } catch {
      return false; // validated on write; a legacy bad regex just never matches
    }
  }
  return false;
}

function conditionMatches(c: RuleCondition, msg: RuleMessageView, body: string | null): boolean {
  switch (c.field) {
    case "from":
      return matchText(c.operator, msg.from, String(c.value));
    case "to":
      return msg.to.some((addr) => matchText(c.operator, addr, String(c.value)));
    case "cc":
      return msg.cc.some((addr) => matchText(c.operator, addr, String(c.value)));
    case "subject":
      return matchText(c.operator, msg.subject, String(c.value));
    case "listId":
      return matchText(c.operator, msg.listId, String(c.value));
    case "hasAttachment":
      return msg.hasAttachment === c.value;
    case "size":
      if (msg.size == null) return false;
      return c.operator === "gt" ? msg.size > Number(c.value) : msg.size < Number(c.value);
    case "body":
      return matchText(c.operator, body, String(c.value));
  }
}

/**
 * Evaluate an ordered rule set against one message. `getBody` is called AT
 * MOST ONCE, and only if a live rule actually reaches a body condition —
 * assert on it in tests to prove tier-2 laziness.
 *
 * Precedence (decided here, not by accident of ordering):
 *  - first moveTo in position order wins; later moveTo/junk are recorded as
 *    ignored, their non-move actions still apply;
 *  - stopProcessing (column or action) halts the chain after its rule.
 */
export async function evalRules(
  rules: RuleRow[],
  msg: RuleMessageView,
  getBody: () => Promise<string | null>,
): Promise<RuleOutcome> {
  const out = emptyOutcome();
  let body: string | null = null;
  let bodyLoaded = false;
  const loadBody = async () => {
    if (!bodyLoaded) {
      body = await getBody();
      bodyLoaded = true;
    }
    return body;
  };

  for (const rule of [...rules].sort((a, b) => a.position - b.position)) {
    if (!rule.enabled) continue;
    let conditions: RuleConditions;
    let actions: RuleAction[];
    try {
      conditions = JSON.parse(rule.conditions);
      actions = JSON.parse(rule.actions);
    } catch {
      continue; // unreadable rule row: skip, never guess
    }
    const needsBody = conditions.conditions.some((c) => c.field === "body");
    const bodyText = needsBody ? await loadBody() : null;
    const results = conditions.conditions.map((c) => conditionMatches(c, msg, bodyText));
    const matched = conditions.op === "AND" ? results.every(Boolean) : results.some(Boolean);
    if (!matched) continue;

    out.matchedRuleIds.push(rule.id);
    let stop = rule.stopProcessing;
    for (const action of actions) {
      switch (action.type) {
        case "moveTo":
          if (out.moveToLabelId === null && !out.junk) {
            out.moveToLabelId = action.labelId;
            out.winningMoveRuleId = rule.id;
          } else {
            out.ignoredMoves.push({ ruleId: rule.id, labelId: action.labelId });
          }
          break;
        case "junk":
          // junk is a move (placement spam) for precedence purposes.
          if (out.moveToLabelId === null && !out.junk) {
            out.junk = true;
            out.junkRuleId = rule.id;
          } else {
            out.ignoredMoves.push({ ruleId: rule.id, labelId: "junk" });
          }
          break;
        case "markRead":
          out.markRead = true;
          break;
        case "markFlagged":
          out.markFlagged = true;
          break;
        case "snooze":
          out.snoozeMinutes ??= action.minutes;
          break;
        case "addLabel":
          if (!out.addLabelIds.includes(action.labelId)) out.addLabelIds.push(action.labelId);
          break;
        case "removeLabel":
          if (!out.removeLabelIds.includes(action.labelId)) out.removeLabelIds.push(action.labelId);
          break;
        case "forward":
          if (!out.forwards.some((f) => f.to === action.to)) out.forwards.push({ ruleId: rule.id, to: action.to });
          break;
        case "stopProcessing":
          stop = true;
          break;
      }
    }
    if (stop) break;
  }
  return out;
}

/**
 * Apply a RuleOutcome's thread-level effects (labels, placement, snooze) for
 * one (thread, mailbox). Shared by ingest (placement stage) and the backfill.
 *
 * Precedence case 3: a thread the USER placed is never moved by automatic
 * evaluation — marks/labels still apply. `overrideUserPlacement` is the
 * backfill's explicit-user-action exception (warned in its confirm dialog).
 */
export async function applyRuleOutcome(
  db: Db,
  input: {
    orgId: string;
    mailboxId: string;
    threadId: string;
    outcome: RuleOutcome;
    overrideUserPlacement?: boolean;
    now?: number;
  },
): Promise<{ moved: boolean }> {
  const out = input.outcome;
  const addIds = new Set(out.addLabelIds);
  if (out.moveToLabelId) addIds.add(out.moveToLabelId);
  for (const labelId of addIds) {
    try {
      await applyLabel(db, { orgId: input.orgId, threadId: input.threadId, mailboxId: input.mailboxId, labelId });
    } catch (e) {
      if (e instanceof LabelError) {
        log.warn("rules.label_missing", { labelId, threadId: input.threadId });
        continue; // rule references a deleted label — skip, never fail the delivery
      }
      throw e;
    }
  }
  for (const labelId of out.removeLabelIds) {
    await removeLabel(db, { threadId: input.threadId, mailboxId: input.mailboxId, labelId });
  }

  const state = await db.query.threadState.findFirst({
    where: and(
      eq(schema.threadState.threadId, input.threadId),
      eq(schema.threadState.mailboxId, input.mailboxId),
    ),
    columns: { id: true, placement: true, placementOrigin: true, placementRuleId: true },
  });
  if (!state) return { moved: false };

  const userOwned = state.placementOrigin === "user" && !input.overrideUserPlacement;
  const set: Record<string, unknown> = {};
  let moved = false;
  const wantsMove = out.junk || out.moveToLabelId !== null;
  if (wantsMove && !userOwned) {
    const target = out.junk ? "spam" : "archived";
    const ruleId = out.junk ? out.junkRuleId : out.winningMoveRuleId;
    // Skip the no-op write: this runs per delivery, and thread_state's
    // placement columns are change_log-watched — a redundant SET burns a seq.
    if (state.placement !== target || state.placementRuleId !== ruleId || state.placementOrigin !== "rule") {
      set.placement = target;
      set.hiddenAt = null;
      set.placementOrigin = "rule";
      set.placementRuleId = ruleId;
      set.placementUserId = null;
      set.placementAt = new Date(input.now ?? Date.now());
    }
    moved = true;
  }
  if (out.ignoredMoves.length) {
    // Recorded for the "why is this here?" sheet's "also matched rule X".
    log.info("rules.move_ignored", {
      threadId: input.threadId,
      winner: out.winningMoveRuleId ?? out.junkRuleId,
      ignored: out.ignoredMoves.map((m) => m.ruleId).join(","),
    });
  }
  if (out.snoozeMinutes != null && !userOwned) {
    set.snoozedUntil = new Date((input.now ?? Date.now()) + out.snoozeMinutes * 60_000);
  }
  if (Object.keys(set).length) {
    await db.update(mail.threadState).set(set).where(eq(mail.threadState.id, state.id));
  }
  return { moved };
}

/** Ordered ENABLED rule set for a mailbox (one load per job/batch). */
export async function loadRules(db: Db, mailboxId: string): Promise<RuleRow[]> {
  const rows = await db.query.rule.findMany({
    where: and(eq(schema.rule.mailboxId, mailboxId), eq(schema.rule.enabled, true)),
    orderBy: asc(schema.rule.position),
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    enabled: r.enabled,
    conditions: r.conditions,
    actions: r.actions,
    stopProcessing: r.stopProcessing,
  }));
}
