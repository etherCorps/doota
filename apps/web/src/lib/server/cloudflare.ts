import Cloudflare from "cloudflare";
import { APP_CLOUDFLARE_ACCOUNT_ID, APP_CLOUDFLARE_API_TOKEN } from "$app/env/private";

/**
 * Cloudflare is the source of truth for all mail wiring. This module is the ONLY
 * place we talk to the CF API. It must never be called on the inbound-email hot
 * path or on login validation — those read the cached D1 domain→org→zone map.
 *
 * Credential is a SCOPED API Token (Bearer), never the Global API Key. No
 * account email. Every call here is idempotent: check-then-create where a list
 * exists, tolerate "already exists / already enabled" otherwise.
 */

export type ZoneOnboardStatus =
  | "pending_zone"
  | "pending_nameservers"
  | "wiring"
  | "active"
  | "error";

let client: Cloudflare | undefined;

export function cf(): Cloudflare {
  if (!APP_CLOUDFLARE_API_TOKEN || !APP_CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      "Cloudflare is not configured. Set APP_CLOUDFLARE_API_TOKEN and APP_CLOUDFLARE_ACCOUNT_ID (scoped API token).",
    );
  }
  // Bearer token only — apiEmail/global key is intentionally not passed.
  return (client ??= new Cloudflare({ apiToken: APP_CLOUDFLARE_API_TOKEN }));
}

/**
 * Map a live CF zone to our onboarding status. `active` means DNS is delegated
 * to Cloudflare and the zone is live — the prerequisite for wiring mail.
 */
export function statusForZone(status: string | undefined): ZoneOnboardStatus {
  switch (status) {
    case "active":
      return "active";
    case "pending":
    case "initializing":
      return "pending_nameservers";
    default:
      return "error";
  }
}

/**
 * True for CF errors that mean "the thing you asked to create already exists /
 * is already enabled" — benign for an idempotent wire step, so we swallow them.
 */
function isBenignConflict(err: unknown): boolean {
  const e = err as { status?: number; errors?: Array<{ code?: number; message?: string }>; message?: string };
  if (e?.status === 409) return true;
  const blob =
    (e?.errors?.map((x) => `${x.code} ${x.message}`).join(" ") ?? "") +
    " " +
    (e?.message ?? "");
  return /already\s+(exists|enabled|active|been)|duplicate|is enabled/i.test(blob);
}

async function tolerant<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isBenignConflict(err)) return undefined;
    throw err;
  }
}

export type ZoneRef = {
  id: string;
  name: string;
  status: ZoneOnboardStatus;
  nameServers: string[];
};

function toZoneRef(z: {
  id: string;
  name: string;
  status?: string;
  name_servers?: string[];
}): ZoneRef {
  return {
    id: z.id,
    name: z.name,
    status: statusForZone(z.status),
    nameServers: z.name_servers ?? [],
  };
}

/**
 * Idempotent zone create. If the domain is already a zone on this account we
 * return it (the "already on the operator's CF account" path); otherwise POST a
 * new full zone and return its pending status + assigned nameservers.
 */
export async function zoneCreate(domain: string): Promise<ZoneRef> {
  const c = cf();
  const existing = await c.zones.list({
    account: { id: APP_CLOUDFLARE_ACCOUNT_ID },
    name: domain,
  });
  const found = existing.result?.[0];
  if (found) return toZoneRef(found);

  const created = await c.zones.create({
    account: { id: APP_CLOUDFLARE_ACCOUNT_ID },
    name: domain,
    type: "full",
  });
  return toZoneRef(created);
}

/** Live zone status — used only by the (superadmin) poll, never the hot path. */
export async function pollZoneStatus(zoneId: string): Promise<ZoneRef> {
  const z = await cf().zones.get({ zone_id: zoneId });
  return toZoneRef(z);
}

/** Find an existing zone by name WITHOUT creating one (for the Link path). */
export async function findZone(domain: string): Promise<ZoneRef | undefined> {
  const res = await cf().zones.list({ account: { id: APP_CLOUDFLARE_ACCOUNT_ID }, name: domain });
  const found = res.result?.[0];
  return found ? toZoneRef(found) : undefined;
}

/**
 * Every zone on the operator's Cloudflare account — the source for the "pick a
 * domain" onboarding picker (no manual typing). Super-admin/settings only.
 */
export async function listZones(): Promise<ZoneRef[]> {
  const res = await cf().zones.list({ account: { id: APP_CLOUDFLARE_ACCOUNT_ID } });
  return (res.result ?? []).map((z) => toZoneRef(z));
}

export type ZoneDnsRecord = {
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
  proxied?: boolean;
};

/**
 * Every DNS record in the zone, LIVE from Cloudflare (never persisted). Cloudflare
 * holds the full zone — the apex (domain.tld itself) and every subdomain — so this
 * is the operator's complete view of what's published. Best-effort: [] on error.
 */
export async function listZoneDnsRecords(zoneId: string): Promise<ZoneDnsRecord[]> {
  try {
    const page = await cf().dns.records.list({ zone_id: zoneId, per_page: 100 });
    // `priority`/`proxied` exist only on some record subtypes in the CF union.
    const rows = (page.result ?? []).map((r) => {
      const rec = r as { priority?: number; proxied?: boolean };
      return {
        type: r.type ?? "",
        name: r.name ?? "",
        content: r.content ?? "",
        priority: rec.priority,
        ttl: r.ttl,
        proxied: rec.proxied,
      };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
    return rows;
  } catch (e) {
    console.error("[cf:dns] zone records", e);
    return [];
  }
}

/** Enable Email Routing on the zone. Tolerates already-enabled. */
export async function enableEmailRouting(zoneId: string): Promise<void> {
  await tolerant(() => cf().emailRouting.enable({ zone_id: zoneId, body: {} }));
}

/**
 * Provision the zone-level inbound DNS (MX + SPF) Email Routing needs. For a
 * Cloudflare-hosted full zone, `enableEmailRouting` already adds these — the
 * `POST /dns` endpoint's `name` is for a SUBDOMAIN, so passing the zone apex is
 * rejected (422). We therefore only use it for subdomain routing; for the apex
 * this is a best-effort no-name call and any error is non-fatal (enable did it).
 *
 * ponytail: best-effort. If you ever host DNS outside Cloudflare (partial zone),
 * surface the records from `listZoneDnsRecords` and have the operator add them.
 */
export async function writeDnsRecords(
  zoneId: string,
  subdomain?: string,
): Promise<void> {
  try {
    await cf().emailRouting.dns.create(
      subdomain
        ? { zone_id: zoneId, name: subdomain }
        : { zone_id: zoneId },
    );
  } catch (e) {
    if (!isBenignConflict(e)) console.warn("[cf:dns] routing dns (non-fatal)", e);
  }
}

/**
 * Onboard a SENDING subdomain (outbound DKIM/DMARC/return-path). Cloudflare
 * Email Sending requires a subdomain — the apex is rejected — so this is a no-op
 * unless a subdomain is supplied. Idempotent (create re-enables an existing one).
 */
export async function onboardSendingDomain(
  zoneId: string,
  sendingSubdomain?: string,
): Promise<{ dkimSelector?: string; returnPathDomain?: string }> {
  const name = sendingSubdomain?.trim().toLowerCase();
  if (!name) return {};
  const res = await cf().emailSending.subdomains.create({ zone_id: zoneId, name });
  return {
    dkimSelector: res?.dkim_selector,
    returnPathDomain: res?.return_path_domain,
  };
}

/**
 * Inspect a zone's mail config on Cloudflare — used to decide "already onboarded
 * on the CF dashboard → offer Link" vs "not onboarded → Onboard". Read-only.
 */
export async function inspectZoneMail(zoneId: string): Promise<{
  routingReady: boolean;
  catchAllToWorker: (worker: string) => boolean;
  sendingConfigured: boolean;
}> {
  const c = cf();
  const [routing, catchAll, subs] = await Promise.all([
    c.emailRouting.get({ zone_id: zoneId }).catch(() => null),
    c.emailRouting.rules.catchAlls.get({ zone_id: zoneId }).catch(() => null),
    c.emailSending.subdomains.list({ zone_id: zoneId }).catch(() => null),
  ]);
  const actions = (catchAll?.actions ?? []) as Array<{ type?: string; value?: string[] }>;
  return {
    routingReady: !!routing?.enabled && routing?.status === "ready",
    catchAllToWorker: (worker: string) =>
      actions.some((a) => a.type === "worker" && (a.value ?? []).includes(worker)),
    sendingConfigured: (subs?.result ?? []).some((s) => s.enabled),
  };
}

/**
 * Point the zone's catch-all routing rule at the deployed mail-in Worker.
 * `update` is an upsert, so this is idempotent by construction.
 */
export async function createRoutingRule(
  zoneId: string,
  workerName: string,
): Promise<void> {
  try {
    await cf().emailRouting.rules.catchAlls.update({
      zone_id: zoneId,
      actions: [{ type: "worker", value: [workerName] }],
      matchers: [{ type: "all" }],
      enabled: true,
    });
  } catch (e) {
    // Mail-in Worker not deployed yet (404 / code 2016) — don't block onboarding.
    // Routing + DNS are wired; the catch-all can be attached later (Refresh) once
    // the Worker exists. ponytail: deploy the worker, then re-run to route inbound.
    const err = e as { status?: number; errors?: Array<{ code?: number }> };
    const missingWorker =
      err?.status === 404 || err?.errors?.some((x) => x.code === 2016);
    if (missingWorker) {
      console.warn(`[cf:catchall] Worker "${workerName}" not found — catch-all left unset.`);
      return;
    }
    throw e;
  }
}

/**
 * Live inbound-routing config for the org's DNS tab: whether Email Routing is on,
 * whether subaddressing (`+`) is honored, and which subdomains have routing MX.
 * All read live from Cloudflare — never persisted (CF is the source of truth).
 *
 * Subdomains are inferred from the zone's MX records that point at Cloudflare
 * Email Routing (`*.mx.cloudflare.net`) whose name sits below the apex.
 * ponytail: MX heuristic. If a customer runs non-CF inbound MX on a subdomain
 * this would miss it — fine, we only manage CF-routed subdomains here.
 */
export type RoutingConfig = {
  enabled: boolean;
  supportSubaddress: boolean;
  status?: string;
  subdomains: string[];
};

export async function getRoutingConfig(
  zoneId: string,
  apex: string,
): Promise<RoutingConfig> {
  const c = cf();
  const [settings, subdomains] = await Promise.all([
    c.emailRouting.get({ zone_id: zoneId }).catch(() => null),
    listRoutingSubdomains(zoneId, apex).catch(() => [] as string[]),
  ]);
  return {
    enabled: !!settings?.enabled,
    supportSubaddress: !!settings?.support_subaddress,
    status: settings?.status,
    subdomains,
  };
}

async function listRoutingSubdomains(zoneId: string, apex: string): Promise<string[]> {
  const names = new Set<string>();
  const suffix = `.${apex}`;
  for await (const rec of cf().dns.records.list({ zone_id: zoneId, type: "MX" })) {
    const name = (rec.name ?? "").toLowerCase();
    const content = (rec.content ?? "").toLowerCase();
    if (name !== apex && name.endsWith(suffix) && content.endsWith("mx.cloudflare.net")) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Add a subdomain to the zone's Email Routing (provisions its MX/SPF so
 * `*@sub.apex` is delivered to the same catch-all Worker). Idempotent — CF
 * tolerates re-adding. `sub` must be a full host within the apex.
 */
export async function addRoutingSubdomain(zoneId: string, sub: string): Promise<void> {
  await tolerant(() => cf().emailRouting.dns.create({ zone_id: zoneId, name: sub }));
}

/**
 * Remove a routing subdomain by deleting its Email Routing DNS records (the
 * per-subdomain `dns.delete` endpoint is zone-wide, so we target the records by
 * name via the zone DNS API instead). Safe no-op if nothing matches.
 */
export async function removeRoutingSubdomain(zoneId: string, sub: string): Promise<void> {
  const c = cf();
  const ids: string[] = [];
  for await (const rec of c.dns.records.list({ zone_id: zoneId, search: sub })) {
    if ((rec.name ?? "").toLowerCase() === sub) ids.push(rec.id);
  }
  for (const id of ids) await tolerant(() => c.dns.records.delete(id, { zone_id: zoneId }));
}

/**
 * Toggle subaddressing (plus-addressing, `user+tag@domain`) on the zone's Email
 * Routing. No typed setter in the SDK (v7 only exposes enable/disable/get), so
 * this uses the raw PATCH escape hatch. Endpoint confirmed against the CF API
 * reference: PATCH /zones/{id}/email/routing { support_subaddress }.
 * ponytail: raw path — if CF ever moves it, the toast surfaces the error and
 * this is the one line to fix.
 */
export async function setSubaddressing(zoneId: string, on: boolean): Promise<void> {
  await cf().patch(`/zones/${zoneId}/email/routing`, {
    body: { support_subaddress: on },
  });
}

// ---- Zone observability: analytics · email logs · audit logs ----------------
//
// All read-only, LIVE from Cloudflare (never persisted). To respect Cloudflare's
// API rate limit (~1200 req / 5 min per token; the GraphQL Analytics API has its
// own per-minute ceiling) these go through a tiny per-isolate TTL cache so an
// admin refreshing a dashboard collapses to at most one upstream call per TTL
// window per zone+view. Best-effort: any upstream/GraphQL error degrades to an
// empty result (the UI shows "no data") rather than 500ing the page.
//
// ponytail: in-memory per-isolate cache — resets on isolate recycle and isn't
// shared across colos. Fine for an internal admin panel (few viewers). If you
// ever expose these widely and start hitting CF limits, back this with KV/D1.

const _obsCache = new Map<string, { exp: number; val: unknown }>();

async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = _obsCache.get(key);
  if (hit && hit.exp > now) return hit.val as T;
  const val = await fn();
  _obsCache.set(key, { exp: now + ttlMs, val });
  return val;
}

/**
 * GraphQL Analytics API. Not exposed by the SDK's typed surface (and its raw
 * request unwraps the REST `result` envelope, which /graphql doesn't use), so
 * this posts directly with the same scoped Bearer token. Returns `data` or null.
 * The token must carry the "Analytics Read" permission for these datasets.
 */
async function cfGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await r.json()) as { data?: T; errors?: Array<{ message?: string }> };
    // GraphQL can return PARTIAL data alongside per-field errors — surface the
    // errors but keep whatever data came back (a bad field must not blank the view).
    if (j.errors?.length) console.warn("[cf:graphql]", r.status, j.errors.map((e) => e.message).join("; "));
    if (!r.ok && !j.data) return null;
    return j.data ?? null;
  } catch (e) {
    console.error("[cf:graphql] request failed", e);
    return null;
  }
}

/** Coerce an unknown CF value to a display string (fields are sometimes objects,
 * lists, or numbers rather than the plain strings the schema implies). */
function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ") || null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.email ?? o.address ?? o.value ?? o.name ?? o.text);
  }
  return null;
}

export type EmailAnalyticsRow = { date: string; status: string; count: number };

const ANALYTICS_Q = `query($zoneTag:string!,$start:Date!,$end:Date!){
  viewer{ zones(filter:{zoneTag:$zoneTag}){
    emailSendingAdaptiveGroups(filter:{date_geq:$start,date_leq:$end},limit:1000,orderBy:[date_ASC]){
      count dimensions{ date status }
    }
  }}
}`;

/** Cloudflare's email analytics window maxes at 4w3d (31d), measured to the
 * request instant — so a 31-day span overflows by the current time-of-day and is
 * rejected (quota error). Cap at 30 for headroom. */
const MAX_DAYS = 30;
const clampDays = (days: number) => Math.min(Math.max(Math.round(days), 1), MAX_DAYS);

/**
 * Aggregated outbound sending counts over the last `days`, grouped by day +
 * status (delivered / deliveryFailed / …). Clamped to Cloudflare's 31-day window.
 */
export async function zoneEmailAnalytics(zoneId: string, days = 7): Promise<EmailAnalyticsRow[]> {
  const d = clampDays(days);
  return memo(`analytics:${zoneId}:${d}`, 300_000, async () => {
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    const data = await cfGraphql<{
      viewer: { zones: { emailSendingAdaptiveGroups: { count: number; dimensions: { date: string; status: string } }[] }[] };
    }>(ANALYTICS_Q, { zoneTag: zoneId, start: iso(new Date(Date.now() - d * 864e5)), end: iso(new Date()) });
    const rows = data?.viewer?.zones?.[0]?.emailSendingAdaptiveGroups ?? [];
    return rows.map((r) => ({ date: r.dimensions.date, status: r.dimensions.status, count: r.count }));
  });
}

/** Per-zone sends TODAY, summed from the analytics dataset (per-domain context
 * for the org overview). The account-wide daily limit lives in accountSendLimits. */
export async function zoneSendUsage(zoneId: string): Promise<{ today: number }> {
  return memo(`usage:${zoneId}`, 300_000, async () => {
    const rows = await zoneEmailAnalytics(zoneId, MAX_DAYS);
    const today = new Date().toISOString().slice(0, 10);
    let day = 0;
    for (const r of rows) if (r.date === today) day += r.count;
    return { today: day };
  });
}

export type SendLimits = {
  /** Emails allowed per `unit` window; null if Cloudflare didn't return it. */
  dailyLimit: number | null;
  unit: string | null;
  /** Sent in the current window. */
  sent: number | null;
  overQuota: boolean;
  /** When the window resets (ISO). */
  resetsAt: string | null;
};

/**
 * The account's LIVE sending limit + usage, straight from Cloudflare
 * (`GET /accounts/{id}/email/sending/limits`). The daily quota is dynamic
 * (scales with reputation), so it's read live — never hardcoded. Account-scoped
 * (superadmin/dashboard). Unknown fields degrade to null, not a fabricated value.
 */
export async function accountSendLimits(): Promise<SendLimits> {
  return memo("acct-limits", 60_000, async () => {
    const unknown: SendLimits = { dailyLimit: null, unit: null, sent: null, overQuota: false, resetsAt: null };
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${APP_CLOUDFLARE_ACCOUNT_ID}/email/sending/limits`,
        { headers: { Authorization: `Bearer ${APP_CLOUDFLARE_API_TOKEN}` } },
      );
      const j = (await r.json()) as {
        result?: { quota?: { value?: number; unit?: string }; usage?: { sent?: number; over_quota?: boolean; resets_at?: string } };
      };
      if (!r.ok || !j.result) return unknown;
      const { quota, usage } = j.result;
      return {
        dailyLimit: typeof quota?.value === "number" ? quota.value : null,
        unit: quota?.unit ?? null,
        sent: typeof usage?.sent === "number" ? usage.sent : null,
        overQuota: !!usage?.over_quota,
        resetsAt: usage?.resets_at ?? null,
      };
    } catch (e) {
      console.error("[cf:limits] request failed", e);
      return unknown;
    }
  });
}

export type EmailEvent = {
  datetime: string | null;
  to: string | null;
  from: string | null;
  subject: string | null;
  status: string | null;
  errorCause: string | null;
  dkim: string | null;
  dmarc: string | null;
  spf: string | null;
};

// Individual-event dataset — recipient is `to` (a scalar); `envelopeTo` is a
// GROUP dimension and comes back as an object on this dataset. Confirmed fields.
const EVENTS_Q = `query($zoneTag:string!,$start:Time!,$end:Time!){
  viewer{ zones(filter:{zoneTag:$zoneTag}){
    emailSendingAdaptive(filter:{datetime_geq:$start,datetime_leq:$end},limit:100,orderBy:[datetime_DESC]){
      datetime to from subject status errorCause dkim dmarc spf
    }
  }}
}`;

/** Individual outbound email events over the last `days` (up to 100, adaptively
 * sampled by Cloudflare) — the per-message delivery log. Every field is coerced
 * to a display string; CF returns some as objects/lists. */
export async function zoneEmailEvents(zoneId: string, days = 1): Promise<EmailEvent[]> {
  const d = clampDays(days);
  return memo(`events:${zoneId}:${d}`, 60_000, async () => {
    const data = await cfGraphql<{ viewer: { zones: { emailSendingAdaptive: Record<string, unknown>[] }[] } }>(
      EVENTS_Q,
      { zoneTag: zoneId, start: new Date(Date.now() - d * 864e5).toISOString(), end: new Date().toISOString() },
    );
    const rows = data?.viewer?.zones?.[0]?.emailSendingAdaptive ?? [];
    return rows.map((e) => ({
      datetime: str(e.datetime),
      to: str(e.to),
      from: str(e.from),
      subject: str(e.subject),
      status: str(e.status),
      errorCause: str(e.errorCause),
      dkim: str(e.dkim),
      dmarc: str(e.dmarc),
      spf: str(e.spf),
    }));
  });
}

export type AuditEntry = {
  id: string;
  when: string | null;
  action: string | null;
  ok: boolean;
  actor: string | null;
  resource: string | null;
};

/**
 * Recent account audit-log entries scoped to this zone (who changed what, when).
 * Account-scoped endpoint filtered by `zone.name` — Cloudflare's audit log is
 * per-account but every entry carries the zone it touched. Fields are read
 * tolerantly (v1/v2 differ on timestamp + shape) and coerced to display strings.
 */
export async function zoneAuditLogs(zoneName: string, days = 30): Promise<AuditEntry[]> {
  const d = clampDays(days);
  return memo(`audit:${zoneName}:${d}`, 60_000, async () => {
    try {
      const params = new URLSearchParams({
        since: new Date(Date.now() - d * 864e5).toISOString(),
        before: new Date().toISOString(),
        per_page: "50",
        "zone.name": zoneName,
      });
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${APP_CLOUDFLARE_ACCOUNT_ID}/audit_logs?${params}`,
        { headers: { Authorization: `Bearer ${APP_CLOUDFLARE_API_TOKEN}` } },
      );
      const j = (await r.json()) as { result?: Record<string, unknown>[]; errors?: Array<{ message?: string }> };
      if (!r.ok) {
        console.warn("[cf:audit]", r.status, j.errors?.map((e) => e.message).join("; "));
        return [];
      }
      return (j.result ?? []).map((e, i) => {
        const action = e.action as Record<string, unknown> | undefined;
        const actor = e.actor as Record<string, unknown> | undefined;
        const resource = e.resource as Record<string, unknown> | undefined;
        return {
          id: str(e.id) ?? String(i),
          when: str(e.when ?? e.created_at ?? e.timestamp),
          action: str(action?.type ?? e.action),
          ok: action?.result !== false,
          actor: str(actor?.email ?? actor?.type ?? e.actor),
          resource: str(resource?.type ?? resource?.id ?? e.resource),
        };
      });
    } catch (e) {
      console.error("[cf:audit] request failed", e);
      return [];
    }
  });
}

/**
 * Run the full idempotent wire once a zone is active. Safe to re-run: every
 * step tolerates "already done". Returns the sending metadata (DKIM selector).
 */
export async function wireMail(
  zoneId: string,
  mailInWorkerName: string,
  sendingSubdomain?: string,
): Promise<{ dkimSelector?: string; returnPathDomain?: string }> {
  // Inbound: create the zone routing DNS (MX/SPF/TXT) FIRST — routing only goes
  // `ready` once the records exist — then enable, then point the catch-all at
  // our mail-in Worker. (Verified sequence against the CF API.)
  await writeDnsRecords(zoneId);
  await enableEmailRouting(zoneId);
  await createRoutingRule(zoneId, mailInWorkerName);
  // Outbound sending is only wired when a subdomain is supplied (apex rejected).
  return onboardSendingDomain(zoneId, sendingSubdomain);
}
