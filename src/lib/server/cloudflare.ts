import Cloudflare from "cloudflare";
import { CF_ACCOUNT_ID, CF_API_TOKEN } from "$app/env/private";

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
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
    throw new Error(
      "Cloudflare is not configured. Set CF_API_TOKEN and CF_ACCOUNT_ID (scoped API token).",
    );
  }
  // Bearer token only — apiEmail/global key is intentionally not passed.
  return (client ??= new Cloudflare({ apiToken: CF_API_TOKEN }));
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
    account: { id: CF_ACCOUNT_ID },
    name: domain,
  });
  const found = existing.result?.[0];
  if (found) return toZoneRef(found);

  const created = await c.zones.create({
    account: { id: CF_ACCOUNT_ID },
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
  const res = await cf().zones.list({ account: { id: CF_ACCOUNT_ID }, name: domain });
  const found = res.result?.[0];
  return found ? toZoneRef(found) : undefined;
}

/**
 * Every zone on the operator's Cloudflare account — the source for the "pick a
 * domain" onboarding picker (no manual typing). Super-admin/settings only.
 */
export async function listZones(): Promise<ZoneRef[]> {
  const res = await cf().zones.list({ account: { id: CF_ACCOUNT_ID } });
  return (res.result ?? []).map((z) => toZoneRef(z));
}

export type MailDnsRecord = {
  category: "sending" | "routing";
  type: string;
  name: string;
  value: string;
  priority?: number;
};

/**
 * Expected mail DNS records for a domain, fetched LIVE from Cloudflare (never
 * persisted). Surfaced on the domain screen so the operator can populate them if
 * their DNS isn't Cloudflare-hosted. Best-effort: returns what it can, [] on error.
 */
export async function getMailDnsRecords(
  zoneId: string,
  domain: string,
): Promise<MailDnsRecord[]> {
  const records: MailDnsRecord[] = [];
  try {
    const subs = await cf().emailSending.subdomains.list({ zone_id: zoneId });
    const list = subs.result ?? [];
    const sub = list.find((s) => s.name === domain) ?? list[0];
    if (sub?.tag) {
      const page = await cf().emailSending.subdomains.dns.get(sub.tag, {
        zone_id: zoneId,
      });
      for (const r of page.result ?? []) {
        records.push({
          category: "sending",
          type: r.type ?? "TXT",
          name: r.name ?? domain,
          value: r.content ?? "",
          priority: r.priority,
        });
      }
    }
  } catch (e) {
    console.error("[cf:dns] sending records", e);
  }
  return records;
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
 * surface the records from `getMailDnsRecords` and have the operator add them.
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
