// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in merge variables (docs/service-accounts.md § Templates). Doota fills
 * these automatically at send — the caller never supplies them (and they win
 * over caller `data` of the same name, so they're reserved). Everything else in
 * a template is a **custom** variable the caller passes via the API `data` object.
 *
 * Shared: the builder lists these (click-to-use), and the send path fills them.
 */
export type BuiltinVariable = { name: string; description: string };

export const BUILTIN_VARIABLES: BuiltinVariable[] = [
  { name: "recipient", description: "The recipient's email address." },
  { name: "sender_name", description: "The sending mailbox's display name." },
  { name: "sender_email", description: "The sending mailbox address." },
  { name: "year", description: "Current year, e.g. 2026." },
  { name: "date", description: "Current date, YYYY-MM-DD." },
  { name: "unsubscribe_url", description: "One-click unsubscribe link for the recipient (filled at send)." },
];

/** Reserved built-in names — used to split provided vs custom in the builder. */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_VARIABLES.map((v) => v.name));

/** Build a template's variablesSchema JSON from names + a caller-supplied sensitive set. */
export function variablesSchemaJson(names: string[], sensitive: string[] = []): string {
  const set = new Set(sensitive);
  const schema: Record<string, { sensitive?: boolean }> = {};
  for (const n of names) schema[n] = set.has(n) ? { sensitive: true } : {};
  return JSON.stringify(schema);
}

/** Fill the built-in values for a send. These override caller `data` of the same name. */
export function builtinMergeData(opts: {
  fromAddress: string;
  fromName?: string | null;
  recipients: string[];
}): Record<string, string> {
  const now = new Date();
  return {
    recipient: opts.recipients[0] ?? "",
    sender_name: opts.fromName || opts.fromAddress,
    sender_email: opts.fromAddress,
    year: String(now.getUTCFullYear()),
    date: now.toISOString().slice(0, 10),
  };
}
