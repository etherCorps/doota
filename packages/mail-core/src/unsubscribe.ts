// SPDX-License-Identifier: Apache-2.0
// Unsubscribe URL for outbound mail, exposed to templates as {{ unsubscribe_url }}.
// The host comes from the request/page origin — a single worker serves many
// domains, so the host isn't baked into config/env. An optional configured value
// overrides only the path/query: a relative value (default "/unsubscribe")
// resolves against the origin; an absolute http(s) value is used verbatim (an
// external unsubscribe system). A `{email}` token is replaced with the
// URL-encoded recipient; when absent, an `email=` query param is appended.

export function unsubscribeUrlFor(origin: string, email: string, configured?: string | null): string {
  if (!origin) return "";
  let t = (configured && configured.trim()) || "/unsubscribe";
  if (t.includes("{email}")) t = t.replaceAll("{email}", encodeURIComponent(email));
  else t += (t.includes("?") ? "&" : "?") + "email=" + encodeURIComponent(email);
  if (/^https?:\/\//i.test(t)) return t; // operator-supplied absolute URL
  return `${origin.replace(/\/$/, "")}${t.startsWith("/") ? "" : "/"}${t}`;
}
