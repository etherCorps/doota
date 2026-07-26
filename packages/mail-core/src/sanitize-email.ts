// SPDX-License-Identifier: Apache-2.0
import { Sanitizer } from "neosanitize";

/**
 * Untrusted email HTML → safe HTML, plus a framed single-document builder.
 *
 * The sanitizer core is **neosanitize** — an html5lib-conformant tokenizer that
 * closes mutation-XSS gaps by construction and is fuzz-tested. We never hand-roll
 * the allowlist walk (hand-rolled sanitizers are exactly what gets bypassed); this
 * module only *configures* the policy, rewrites `cid:` refs the parser would drop,
 * enforces DoS caps, and reshapes the output into one framed document (A2).
 *
 * MUST run server-side, before the HTML reaches the client. Sanitize-at-READ: the
 * raw MIME in R2 + the encrypted body stay canonical; this is a pure function of
 * them, so any fix here protects ALL historical mail immediately.
 */

// Deny-by-default element allowlist (Part B). Anything NOT listed is dropped —
// which is how script/iframe/object/embed/applet/frame(set)/form/input/button/
// textarea/select/base/meta/link/svg/math/template/etc. are removed (by omission).
// neosanitize's inviolable baseline ALSO strips script, on* handlers, and
// javascript:/vbscript: URLs regardless of this list. `<meta>` is deliberately
// absent so a `<meta http-equiv=refresh>` can never survive.
const TAGS = [
  // structure kept so the email's own body/.class rules still match after A2;
  // flattened into ONE body by buildFramedDocument below.
  "html", "head", "body", "style",
  // flow + text
  "p", "div", "span", "br", "hr", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "b", "strong", "i", "em", "u", "s", "strike", "del", "ins",
  "sub", "sup", "small", "big", "mark", "code", "kbd", "samp", "var",
  "cite", "q", "abbr", "address", "wbr", "center", "font", "tt",
  // tables (email's workhorse layout)
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  // links + inline images (remote-image blocking is CSP's job, not the sanitizer's)
  "a", "img",
];

// Allowlist attributes per tag (`*` = any). Note `background` (a URL attr the
// baseline doesn't scheme-check) is deliberately omitted.
const ATTRS: Record<string, string[]> = {
  "*": [
    "class", "id", "style", "title", "dir", "lang",
    "align", "valign", "width", "height", "bgcolor",
    "colspan", "rowspan", "border", "cellpadding", "cellspacing", "nowrap", "span",
  ],
  a: ["href", "target", "rel", "name"],
  img: ["src", "alt", "width", "height", "border"],
  font: ["color", "face", "size"],
  col: ["span", "width"],
};

const sanitizer = Sanitizer.builder({ tags: TAGS, attrs: ATTRS }).build();

/** Bodies larger than this are treated as hostile/DoS and fall back to text. */
export const MAX_HTML_BYTES = 1_000_000;
/** Rough tag-count ceiling (counts `<`), a cheap guard before the parser runs. */
export const MAX_NODES = 15_000;

export type SanitizeResult =
  | { ok: true; html: string }
  | { ok: false; reason: "too-large" | "too-many-nodes" };

/** Rewrite `src="cid:..."` to a resolver-provided URL BEFORE sanitizing, since
 * neosanitize drops the non-web `cid:` scheme. Unresolved cids are left for the
 * sanitizer to strip. */
function rewriteCids(html: string, resolve: (cid: string) => string | null): string {
  if (!html.includes("cid:")) return html;
  return html.replace(/(\bsrc\s*=\s*["'])cid:([^"']+)(["'])/gi, (m0, pre, cid, post) => {
    let norm: string;
    try {
      norm = decodeURIComponent(cid).trim().replace(/^<|>$/g, "");
    } catch {
      norm = cid.trim().replace(/^<|>$/g, "");
    }
    const url = resolve(norm);
    // Unresolved cid = a missing inline part; blank the src so no cid: string
    // survives (it wouldn't load under CSP img-src 'self' anyway).
    return `${pre}${url ?? ""}${post}`;
  });
}

/**
 * Sanitize untrusted email HTML. Returns not-ok (caller falls back to the
 * plain-text alternative) when the body is oversized or absurdly deep — untrusted
 * input must be bounded (Part F). True per-message time-boxing needs isolation the
 * Worker runtime can't give a sync call; the size + node caps bound the cost.
 */
export function sanitizeEmailHtml(
  rawHtml: string,
  opts: { resolveCid?: (cid: string) => string | null } = {},
): SanitizeResult {
  if (rawHtml.length > MAX_HTML_BYTES) return { ok: false, reason: "too-large" };
  const nodeApprox = (rawHtml.match(/</g) ?? []).length;
  if (nodeApprox > MAX_NODES) return { ok: false, reason: "too-many-nodes" };
  const withCids = opts.resolveCid ? rewriteCids(rawHtml, opts.resolveCid) : rawHtml;
  return { ok: true, html: sanitizer.sanitize(withCids) };
}

/**
 * Reshape already-sanitized HTML into ONE framed document (A2): our head (charset,
 * viewport, reset, CSP meta, forced light color-scheme) + a SINGLE body carrying
 * the email's own body attributes (so its `body{}` / `.class` / `#id` rules still
 * match), with the email's `<style>` blocks and content hoisted in. Kills the
 * nested-document bug and the tripled padding (A3: wrapper padding is zero — email
 * always brings its own).
 *
 * `inner` MUST be sanitizer output — this does string surgery on trusted-safe HTML.
 */
export function buildFramedDocument(
  sanitized: string,
  opts: { csp: string; headExtra?: string; bodyExtra?: string },
): string {
  // Transfer the email's <body> attributes onto our single body (sanitized, so safe).
  const bodyAttrs = sanitized.match(/<body\b([^>]*)>/i)?.[1]?.trim() ?? "";
  // Drop the structural wrappers; keep <style> blocks + body children in order.
  const flat = sanitized
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .replace(/<!doctype[^>]*>/gi, "")
    .trim();
  const reset =
    "*{resize:none!important}" + // stray editor drag-grips from legacy sends
    "html{color-scheme:light}" + // email's prefers-color-scheme:dark must NOT fire (Part I)
    "body{margin:0;padding:0;font:14px system-ui,sans-serif;color:#25252c;background:transparent}";
  return (
    `<!doctype html><html><head>` +
    `<meta charset="utf-8">` + // forced: removes charset-confusion ambiguity (Part B)
    `<meta name="viewport" content="width=device-width">` +
    `<meta http-equiv="Content-Security-Policy" content="${opts.csp}">` +
    `<meta name="color-scheme" content="light">` +
    `<style>${reset}</style>${opts.headExtra ?? ""}</head>` +
    `<body ${bodyAttrs}>${flat}${opts.bodyExtra ?? ""}</body></html>`
  );
}
