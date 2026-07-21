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
