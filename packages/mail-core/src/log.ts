// SPDX-License-Identifier: Apache-2.0
/**
 * Structured logging for the mail pipeline. In Workers, console.* is captured
 * asynchronously by the runtime (no syscall/stdout write), so the only real
 * costs are the level check and the fields-object allocation — logging a flat
 * object is what makes Workers Logs index the fields for dash queries, so we
 * never build interpolated strings.
 *
 * Conventions: `event` is dot-namespaced ("out.sent", "in.job_retry"). Every
 * line about a specific mail carries its correlation id — `subId` (outbound
 * submission), `r2Key` (inbound raw), or `msgId` (provider/RFC message-id) —
 * so one grep or dash filter follows a message across workers.
 */
import { tryCatch } from "@doota/utils/try-catch";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type Fields = Record<string, unknown>;

// ponytail: module-level min, setLogLevel("debug") from a worker entry if a
// LOG_LEVEL env var ever gets wired; per-request levels when actually needed.
let min: number = LEVELS.info;

export function setLogLevel(level: keyof typeof LEVELS): void {
  min = LEVELS[level];
}

/**
 * Read LOG_LEVEL from a worker env ("debug" | "info" | "warn" | "error") —
 * call at the top of each handler; memoized so repeats are one boolean check.
 * Set per-worker via wrangler vars or dash (no redeploy needed from dash).
 */
let applied = false;
export function initLogLevel(env: { LOG_LEVEL?: string }): void {
  if (applied) return;
  applied = true;
  const l = env.LOG_LEVEL?.toLowerCase();
  if (l && l in LEVELS) min = LEVELS[l as keyof typeof LEVELS];
}

/** Spread into fields: log.error("x", { subId, ...errInfo(e) }). */
export function errInfo(e: unknown): Fields {
  return e instanceof Error ? { err: e.message, stack: e.stack } : { err: String(e) };
}

export const log = {
  debug(event: string, fields?: Fields): void {
    if (min <= LEVELS.debug) console.log({ level: "debug", event, ...fields });
  },
  info(event: string, fields?: Fields): void {
    if (min <= LEVELS.info) console.log({ event, ...fields });
  },
  warn(event: string, fields?: Fields): void {
    if (min <= LEVELS.warn) console.warn({ event, ...fields });
  },
  error(event: string, fields?: Fields): void {
    console.error({ event, ...fields });
  },
};

/**
 * Best-effort side effect: await `promise`, and on failure `log.warn(event)`
 * with the error fields merged in — never throws. Collapses the ubiquitous
 * `try { await x } catch (e) { log.warn(event, { ...errInfo(e) }) }` used for
 * notifications, cache busts, and correspondent upserts — work that must not
 * fail the mail path. Returns whether it succeeded, for the rare caller that
 * wants to branch on it.
 */
export async function tryLog(event: string, promise: Promise<unknown>, fields?: Fields): Promise<boolean> {
  const { error } = await tryCatch(promise);
  if (error) log.warn(event, { ...fields, ...errInfo(error) });
  return !error;
}
