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

// Framed-document chrome tones. The opaque-origin iframe can't reach the app's
// CSS tokens, so these are the one place the email frame's ink/paper/rule live —
// keep server-injected chrome (e.g. the clipped-message notice) on the same set.
export const FRAME_INK = "#25252c";
export const FRAME_PAPER = "#ffffff";
export const FRAME_RULE = "#e4e4e7";

// DoS guards, sized for REAL mail: table-based newsletters/receipts (Amazon,
// Postcards/Designmodo, Mailchimp) routinely run 200-600KB and 20k-50k tags of
// deeply-nested tables. The old 1MB/15k ceiling rejected those and dumped the
// ugly text/plain alternative — so genuine marketing HTML rendered as walls of
// text. These caps still bound pathological input; the "view entire message"
// path raises them further (body/+server.ts).
/** Bodies larger than this are treated as hostile/DoS and fall back to text. */
export const MAX_HTML_BYTES = 2_500_000;
/** Rough tag-count ceiling (counts `<`), a cheap guard before the parser runs. */
export const MAX_NODES = 60_000;

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
  opts: {
    resolveCid?: (cid: string) => string | null;
    /** Raised caps for the explicit "view entire message" path — still fully
     * sanitized + sandboxed, just allowed to be big. */
    maxBytes?: number;
    maxNodes?: number;
  } = {},
): SanitizeResult {
  if (rawHtml.length > (opts.maxBytes ?? MAX_HTML_BYTES)) return { ok: false, reason: "too-large" };
  const nodeApprox = (rawHtml.match(/</g) ?? []).length;
  if (nodeApprox > (opts.maxNodes ?? MAX_NODES)) return { ok: false, reason: "too-many-nodes" };
  const withCids = opts.resolveCid ? rewriteCids(rawHtml, opts.resolveCid) : rawHtml;
  // neosanitize already strips data:text/html and keeps inert data:image/* — but
  // blank data:image/svg+xml specifically: SVG-in-<img> is only inert by the
  // browser's secure-mode guarantee, so don't lean on it. Plain raster data:
  // images (logos/signatures) are kept — dropping them all breaks real mail.
  const html = scrubCss(
    sanitizer
      .sanitize(withCids)
      .replace(/(\bsrc\s*=\s*["'])data:image\/svg\+xml[^"']*(["'])/gi, "$1$2"),
  );
  return { ok: true, html };
}

/**
 * Neutralize the legacy CSS attack vectors that survive HTML sanitization inside
 * kept `<style>` blocks + inline styles (neosanitize sanitizes markup, not CSS
 * semantics). The opaque sandboxed frame already blocks scripts, so these are
 * defense-in-depth for ancient IE/Gecko engines — cheap to render inert by
 * corrupting the keyword so the declaration is dropped by any CSS parser.
 * (@import and remote url() are handled by rewriteRemoteResourceUrls.)
 */
function scrubCss(html: string): string {
  return html
    .replace(/expression\s*\(/gi, "blocked-fn(") // IE CSS expression()
    .replace(/-(?:moz|ms)-binding\s*:/gi, "-x-binding:") // XBL/HTC binding
    .replace(/\bbehavior\s*:/gi, "x-behavior:") // IE .htc behavior
    .replace(/url\(\s*['"]?\s*(?:javascript|vbscript|data:text\/html)[^)]*\)/gi, "url()");
}

// Remote-resource rewriting (golden-standard image handling). Real HTML mail
// references remote URLs in FIVE places, not just `<img src>`: `src`/`poster`
// attrs, the `background=` attr (table-based hero art), `srcset`, and CSS
// `url(...)` in inline styles AND `<style>` blocks. Gmail/Apple proxy ALL of
// them at parse time; we do the same so backgrounds/logos render AND every
// remote fetch goes through our privacy proxy (never straight to the sender).
const ATTR_URL_RE = /\b(?:src|poster|background)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
const SRCSET_RE = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^)'"]+?)\1\s*\)/gi;
/** Each URL in a srcset descriptor list ("a.png 1x, b.png 2x"). */
function srcsetUrls(list: string): string[] {
  return list
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((u) => /^https?:\/\//i.test(u));
}

/** Every distinct remote http(s) URL the email would fetch — across img/poster/
 * background attrs, srcset, and CSS url(). Caller signs these, then rewrites. */
export function collectRemoteResourceUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(ATTR_URL_RE)) urls.add(m[1]);
  for (const m of html.matchAll(SRCSET_RE)) for (const u of srcsetUrls(m[1])) urls.add(u);
  for (const m of html.matchAll(CSS_URL_RE)) urls.add(m[2]);
  return [...urls];
}

/**
 * Rewrite every remote resource URL via `resolve` (→ our same-origin proxy).
 * A URL `resolve` maps to null is dropped (blanked) — used for the images-off
 * pass so nothing remote is referenced at all. Also strips `@import` outright:
 * external CSS is a tracking + injection vector with no place in mail.
 */
export function rewriteRemoteResourceUrls(html: string, resolve: (url: string) => string | null): string {
  const out = html.replace(/@import\b[^;]*;?/gi, ""); // no external stylesheets, ever
  return out
    .replace(ATTR_URL_RE, (whole, url) => {
      const r = resolve(url);
      return r === null ? whole.replace(url, "") : whole.replace(url, r);
    })
    .replace(SRCSET_RE, (whole, list: string) => {
      const rewritten = list
        .split(",")
        .map((part) => {
          const seg = part.trim();
          const [u, ...rest] = seg.split(/\s+/);
          if (!/^https?:\/\//i.test(u)) return seg;
          const r = resolve(u);
          return r === null ? "" : [r, ...rest].join(" ");
        })
        .filter(Boolean)
        .join(", ");
      return `srcset="${rewritten}"`;
    })
    .replace(CSS_URL_RE, (whole, _q, url) => {
      const r = resolve(url);
      return r === null ? "url()" : `url('${r}')`;
    });
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
    // Images shrink to the frame on narrow panes (phone/tablet) instead of forcing
    // horizontal overflow. Fixed-width layout tables can still scroll — that's the
    // sender's markup, not ours to reflow.
    "img,video{max-width:100%!important;height:auto}" +
    // A SOLID light surface: with color-scheme forced light, dark text on a
    // transparent body would be invisible over a dark app bubble. Renders the
    // email as its own light card (Gmail-style) regardless of app theme. Small
    // padding so content isn't flush to the rounded frame; the email brings the rest.
    `body{margin:0;padding:10px;font:14px system-ui,sans-serif;color:${FRAME_INK};background:${FRAME_PAPER}}`;
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
