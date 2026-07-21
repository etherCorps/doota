import { command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { tryCatch } from "$lib/utils/try-catch.js";
import { setOrgLifecycle } from "$lib/server/auth/escape-hatches.js";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import {
  mirrorSubaddressing,
  mirrorRoutingSubdomains,
  currentRoutingSubdomains,
  mirrorReturnPathDomain,
} from "@doota/mail-core/mirror";
import { MAIL_IN_WORKER_NAME } from "$app/env/private";
import {
  addRoutingSubdomain,
  findZone,
  getRoutingConfig,
  listZoneDnsRecords,
  inspectZoneMail,
  listZones,
  pollZoneStatus,
  removeRoutingSubdomain,
  setSubaddressing,
  wireMail,
  zoneCreate,
  type ZoneOnboardStatus,
} from "$lib/server/cloudflare.js";

/**
 * Domain onboarding is superadmin-only and the ONLY writer of Cloudflare state.
 * D1 stores just domain, zone_id, org mapping and the lifecycle `status`; the
 * live DNS/DKIM/routing truth is fetched from CF for settings screens only.
 */

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/;

function requireActor() {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  return user;
}

function requireSuperadmin() {
  const user = requireActor();
  if (user.role !== "superadmin") error(403, "Super-admin only");
  return user;
}

/**
 * Create the org for a domain (super-admin becomes owner) if missing, then set
 * its status/zone. ONLY called after a Cloudflare success — so the DB never
 * holds a domain that CF doesn't have. Idempotent (reuses an existing org).
 */
async function upsertOrg(
  domain: string,
  status: ZoneOnboardStatus,
  zoneId: string,
): Promise<string> {
  const { locals, request } = getRequestEvent();
  const existing = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.domain, domain),
    columns: { id: true },
  });
  const orgId =
    existing?.id ??
    (
      await locals.auth.api.createOrganization({
        body: { name: domain, slug: domain.replace(/\./g, "-"), domain },
        headers: request.headers,
      })
    )?.id;
  if (!orgId) throw error(500, "Could not create the organization.");
  await setOrgLifecycle(orgId, status, zoneId);
  return orgId;
}

/**
 * Wire mail on an active zone, then create/activate the org. CF first: if wiring
 * fails, NO org is written (or an existing one drops to `error`), so the DB never
 * claims a domain CF hasn't accepted.
 */
async function wireAndActivate(
  domain: string,
  zoneId: string,
  sendingSubdomain?: string,
): Promise<string> {
  if (!MAIL_IN_WORKER_NAME) {
    error(500, "MAIL_IN_WORKER_NAME is not configured; cannot wire the catch-all route.");
  }
  let sending: { returnPathDomain?: string } = {};
  try {
    sending = await wireMail(zoneId, MAIL_IN_WORKER_NAME, sendingSubdomain);
  } catch (e) {
    console.error("[domains:wire] failed", e);
    error(502, "Cloudflare wiring failed. Check the API token scopes and try again.");
  }
  const orgId = await upsertOrg(domain, "active", zoneId);
  // Mirror the bounce/return-path subdomain to D1 (outbound envelope + inbound
  // DSN recognition read it off the hot path). Best-effort — CF stays truth.
  if (sending.returnPathDomain) {
    await tryCatch(mirrorReturnPathDomain(getRequestEvent().locals.db, orgId, sending.returnPathDomain));
  }
  // A domain just went live — the first working sending path now exists. If the
  // super-admin who onboarded it hasn't verified their (external) primary email,
  // auto-send that verification now so they never have to trigger it by hand.
  // Best-effort: a failure here must not fail the activation. Covers both entry
  // points, since onboardDomain and refreshDomain both route through here.
  await autoSendSuperadminVerify();
  return orgId;
}

/**
 * Fire the super-admin's primary-email verification once a sending path exists.
 * No-op unless the acting user is an unverified super-admin. better-auth's
 * verify-email endpoint no-ops if the address is already verified, so a redundant
 * call (e.g. activating a second domain) is harmless.
 */
async function autoSendSuperadminVerify() {
  const { locals, request } = getRequestEvent();
  const user = locals.user;
  if (user?.role !== "superadmin" || user.emailVerified) return;
  await tryCatch(
    locals.auth.api.sendVerificationEmail({
      body: { email: user.email, callbackURL: "/onboarding?verified=1" },
      headers: request.headers,
    }),
  );
}

/**
 * Onboard a domain NOT yet configured on Cloudflare: create/find the zone, and —
 * only on CF success — wire mail + create the org. If the zone is still pending
 * we surface the assigned nameservers and persist a pending org (the zone exists
 * on CF, so we must track it to poll later).
 */
export const onboardDomain = command(
  z.object({
    domain: z.string().min(3),
    // Optional outbound DKIM host (e.g. send.acme.com); must sit within the domain.
    sendingSubdomain: z.string().optional(),
  }),
  async ({ domain: raw, sendingSubdomain: subRaw }) => {
    requireSuperadmin();
    const domain = raw.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) {
      return { success: false as const, message: "Enter a valid domain, e.g. acme.com." };
    }
    const sendingSubdomain = subRaw?.trim().toLowerCase() || undefined;
    if (sendingSubdomain && !sendingSubdomain.endsWith(`.${domain}`)) {
      return {
        success: false as const,
        message: `The sending subdomain must be within ${domain}, e.g. send.${domain}.`,
      };
    }

    // CF FIRST — the org row is only written after Cloudflare succeeds.
    let zone;
    try {
      zone = await zoneCreate(domain);
    } catch (e) {
      console.error("[domains:zone] failed", e);
      return {
        success: false as const,
        message: "Cloudflare rejected the zone request. Check the API token and account.",
      };
    }

    if (zone.status === "active") {
      const orgId = await wireAndActivate(domain, zone.id, sendingSubdomain);
      return { success: true as const, orgId, status: "active" as ZoneOnboardStatus, nameServers: [] };
    }

    // Zone created but not active yet — persist a pending org to poll later.
    const orgId = await upsertOrg(domain, zone.status, zone.id);
    return {
      success: true as const,
      orgId,
      status: zone.status,
      nameServers: zone.nameServers,
    };
  },
);

/**
 * Link a domain ALREADY onboarded on the Cloudflare dashboard: no CF writes —
 * just verify Email Routing is ready and sync it into our DB as active. For a
 * zone the operator configured themselves.
 */
export const linkDomain = command(z.string(), async (raw) => {
  requireSuperadmin();
  const domain = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) {
    return { success: false as const, message: "Enter a valid domain." };
  }

  const zone = await findZone(domain);
  if (!zone) {
    return { success: false as const, message: `${domain} is not a zone on your Cloudflare account.` };
  }
  if (zone.status !== "active") {
    return { success: false as const, message: `${domain}'s zone isn't active yet — onboard it instead.` };
  }
  const mail = await inspectZoneMail(zone.id);
  if (!mail.routingReady) {
    return {
      success: false as const,
      message: `Email Routing isn't configured for ${domain} on Cloudflare. Use Onboard instead.`,
    };
  }

  const orgId = await upsertOrg(domain, "active", zone.id);
  return { success: true as const, orgId, status: "active" as ZoneOnboardStatus };
});

/**
 * Re-check a pending zone (superadmin poll). When it flips to active, wire mail
 * and mark active. Never called on the hot path — only from the admin screen.
 */
export const refreshDomain = command(z.string(), async (orgId) => {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { id: true, domain: true, zoneId: true, status: true },
  });
  if (!org) error(404, "Organization not found");
  if (!org.zoneId) error(400, "No Cloudflare zone for this domain yet.");

  const zone = await pollZoneStatus(org.zoneId);

  if (zone.status === "active" && org.status !== "active") {
    await wireAndActivate(org.domain, org.zoneId);
    return { status: "active" as ZoneOnboardStatus, nameServers: [] };
  }

  await setOrgLifecycle(org.id, zone.status);
  return { status: zone.status, nameServers: zone.nameServers };
});

/**
 * Zones on the operator's Cloudflare account, each flagged with whether it's
 * already onboarded in Doota. Drives the "pick a domain" picker so the operator
 * doesn't type it by hand. Fetched live — never persisted.
 */
export const listCloudflareZones = command(async () => {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const [zones, orgs] = await Promise.all([
    listZones(),
    locals.db
      .select({ domain: schema.organization.domain })
      .from(schema.organization),
  ]);
  const onboarded = new Set(orgs.map((o) => o.domain));

  // For zones not yet in our DB, check whether Email Routing is already set up on
  // Cloudflare — if so we offer "Link" (DB-only sync); otherwise "Onboard".
  return Promise.all(
    zones.map(async (z) => {
      const active = z.status === "active";
      let configured = false;
      if (active && !onboarded.has(z.name)) {
        try {
          configured = (await inspectZoneMail(z.id)).routingReady;
        } catch {
          configured = false;
        }
      }
      return {
        id: z.id,
        name: z.name,
        active,
        onboarded: onboarded.has(z.name),
        configured,
      };
    }),
  );
});

/**
 * Update an org's BIMI profile: display name + logo URL. Improves mail
 * deliverability/branding (BIMI advertises a verified logo). Editable by a
 * superadmin or the org's owner/admin — never touches Cloudflare.
 *
 * ponytail: logo is a URL string, not an upload. BIMI needs an HTTPS SVG Tiny-PS;
 * add upload + VMC validation when a customer actually needs the blue check.
 */
export const updateOrgProfile = command(
  z.object({
    orgId: z.string().min(1),
    name: z.string().trim().min(1, "Name is required.").max(120),
    logo: z.string().trim().url("Logo must be a URL.").or(z.literal("")).optional(),
  }),
  async ({ orgId, name, logo }) => {
    const user = requireActor();
    if (user.role !== "superadmin") {
      const adminOf = await actorOrgAdminOf(getRequestEvent().locals.db, user.id);
      if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
    }
    const { locals, request } = getRequestEvent();
    await locals.auth.api.updateOrganization({
      body: { organizationId: orgId, data: { name, logo: logo || null } },
      headers: request.headers,
    });
    return { success: true as const };
  },
);

/**
 * Every DNS record in the org's Cloudflare zone — the apex and all subdomains —
 * for the operator's full view of what's published. Superadmin only; fetched
 * live, never persisted.
 */
export const domainDnsRecords = command(z.string(), async (orgId) => {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { zoneId: true },
  });
  if (!org?.zoneId) error(400, "No Cloudflare zone for this domain yet.");
  return listZoneDnsRecords(org.zoneId);
});

/** Fetch the org's zone (superadmin-gated). Shared by the routing commands. */
async function orgZone(orgId: string) {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { domain: true, zoneId: true },
  });
  if (!org?.zoneId) error(400, "No Cloudflare zone for this domain yet.");
  return { zoneId: org.zoneId, apex: org.domain };
}

/**
 * Normalise a subdomain input to a full host within the apex. Accepts a bare
 * label ("mail") or a full host ("mail.acme.com"); rejects anything outside the
 * apex. Returns the lowercased host or null if invalid.
 */
function normalizeSubdomain(input: string, apex: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return null;
  const host = raw.endsWith(`.${apex}`) || raw === apex ? raw : `${raw}.${apex}`;
  if (host === apex) return null; // the apex is not a subdomain
  if (!host.endsWith(`.${apex}`)) return null;
  return DOMAIN_RE.test(host) ? host : null;
}

/**
 * Live inbound-routing config for the org's DNS tab: Email Routing state,
 * subaddressing flag, and configured routing subdomains. Superadmin only.
 */
export const mailRoutingConfig = command(z.string(), async (orgId) => {
  const { zoneId, apex } = await orgZone(orgId);
  const config = await getRoutingConfig(zoneId, apex);
  // Reconcile-on-view: refresh the D1 mirror from CF truth so a direct dashboard
  // edit self-heals and the inbound hot path stays accurate.
  const { locals } = getRequestEvent();
  await mirrorSubaddressing(locals.db, orgId, config.supportSubaddress);
  await mirrorRoutingSubdomains(locals.db, orgId, config.subdomains);
  return config;
});

/** Add a subdomain to the org's Email Routing. Superadmin only. */
export const addMailSubdomain = command(
  z.object({ orgId: z.string().min(1), subdomain: z.string().min(1) }),
  async ({ orgId, subdomain }) => {
    const { zoneId, apex } = await orgZone(orgId);
    const host = normalizeSubdomain(subdomain, apex);
    if (!host) {
      return { success: false as const, message: `Enter a subdomain within ${apex}, e.g. mail.${apex}.` };
    }
    try {
      await addRoutingSubdomain(zoneId, host);
    } catch (e) {
      console.error("[domains:subdomain] add failed", e);
      return { success: false as const, message: "Cloudflare rejected the subdomain. Check the zone and try again." };
    }
    // Write-through: CF accepted it, mirror into D1 for the resolver.
    const { locals } = getRequestEvent();
    const next = [...(await currentRoutingSubdomains(locals.db, orgId)), host];
    await mirrorRoutingSubdomains(locals.db, orgId, next);
    return { success: true as const, subdomain: host };
  },
);

/** Remove a routing subdomain from the org's Email Routing. Superadmin only. */
export const removeMailSubdomain = command(
  z.object({ orgId: z.string().min(1), subdomain: z.string().min(1) }),
  async ({ orgId, subdomain }) => {
    const { zoneId, apex } = await orgZone(orgId);
    const host = normalizeSubdomain(subdomain, apex);
    if (!host) error(400, "Invalid subdomain.");
    await removeRoutingSubdomain(zoneId, host);
    // Write-through: drop it from the D1 mirror too.
    const { locals } = getRequestEvent();
    const next = (await currentRoutingSubdomains(locals.db, orgId)).filter((h) => h !== host);
    await mirrorRoutingSubdomains(locals.db, orgId, next);
    return { success: true as const };
  },
);

/** Toggle subaddressing (`user+tag@domain`) on the org's zone. Superadmin only. */
export const toggleSubaddressing = command(
  z.object({ orgId: z.string().min(1), on: z.boolean() }),
  async ({ orgId, on }) => {
    const { zoneId } = await orgZone(orgId);
    try {
      await setSubaddressing(zoneId, on);
    } catch (e) {
      console.error("[domains:subaddress] toggle failed", e);
      return { success: false as const, message: "Cloudflare rejected the subaddressing change." };
    }
    // Write-through: mirror the flag into D1 for the resolver.
    const { locals } = getRequestEvent();
    await mirrorSubaddressing(locals.db, orgId, on);
    return { success: true as const, on };
  },
);
