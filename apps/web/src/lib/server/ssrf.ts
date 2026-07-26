// SPDX-License-Identifier: Apache-2.0

/**
 * Block loopback / private / link-local / ULA / CGNAT — the SSRF-relevant ranges —
 * for the image proxy. Re-checked after every redirect hop, not just the first URL.
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
