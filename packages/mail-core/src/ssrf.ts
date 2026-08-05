// SPDX-License-Identifier: Apache-2.0
/**
 * SSRF guards for operator-supplied URLs fetched by a Worker. ONE implementation
 * (cross-cutting guard): the image proxy, attachment fetch, and webhook delivery
 * all validate here. `isBlockedHost` is re-checked after EVERY redirect hop;
 * `validateWebhookUrl` is the stricter save/deliver gate for webhooks.
 */

/**
 * Block loopback / private / link-local / ULA / CGNAT — the SSRF-relevant ranges.
 * Re-checked after every redirect hop, not just the first URL.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true; // loopback / unspecified
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    if (host.startsWith("::ffff:")) return true; // IPv4-mapped (could wrap a private v4)
    return false;
  }
  return false; // a normal hostname; Workers' edge fetch can't reach RFC1918 anyway
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_LITERAL = /:/;

/**
 * Validate an operator-supplied webhook URL. Stricter than isBlockedHost alone:
 * webhook delivery is a Worker fetching an arbitrary URL, so this is the SSRF
 * chokepoint. Enforced on SAVE and re-checked at DELIVERY time (DNS answers
 * change between the two). The caller must ALSO fetch with redirect:"manual" —
 * a public URL that 302s to 169.254.169.254 defeats a check done on the origin
 * host only.
 *
 * Rules: https only; standard port (443/none); no literal IPs (a numeric host
 * is never a legitimate webhook target and sidesteps DNS-based checks); no
 * internal TLDs; and the private-range block via isBlockedHost as a backstop.
 */
export function validateWebhookUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "Webhook URLs must use https." };
  if (parsed.port && parsed.port !== "443") {
    return { ok: false, error: "Only the standard https port (443) is allowed." };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (IPV4_LITERAL.test(host) || IPV6_LITERAL.test(host)) {
    return { ok: false, error: "Point the webhook at a hostname, not an IP address." };
  }
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    return { ok: false, error: "That host is not reachable from the public internet." };
  }
  if (isBlockedHost(host)) {
    return { ok: false, error: "That host resolves into a private range." };
  }
  return { ok: true, url: parsed.toString() };
}
