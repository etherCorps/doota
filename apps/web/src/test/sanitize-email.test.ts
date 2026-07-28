// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  sanitizeEmailHtml,
  buildFramedDocument,
  MAX_HTML_BYTES,
  MAX_NODES,
  collectRemoteResourceUrls,
  rewriteRemoteResourceUrls,
} from "@doota/mail-core/sanitize-email";

// neosanitize emits a full <html><head><body> skeleton (we allow those tags so
// A2 can transfer body attrs), so assert on containment, not exact fragments.
const clean = (html: string, opts?: Parameters<typeof sanitizeEmailHtml>[1]) => {
  const r = sanitizeEmailHtml(html, opts);
  if (!r.ok) throw new Error(`unexpected fallback: ${r.reason}`);
  return r.html;
};

describe("email sanitizer — script/handler stripping", () => {
  it("removes <script>, event handlers, and javascript: (incl. encoded/whitespace)", () => {
    const a = clean("<p onclick='x()'>hi</p><script>alert(1)</script>");
    expect(a).toContain("<p>hi</p>");
    expect(a).not.toMatch(/onclick|script|alert/i);
    expect(clean("<a href='javascript:alert(1)'>x</a>")).not.toMatch(/javascript|href/i);
    expect(clean("<a href='java&#x09;script:alert(1)'>x</a>")).not.toMatch(/javascript|href/i);
    expect(clean("<a href='  javascript:alert(1)'>y</a>")).not.toMatch(/javascript|href/i);
    expect(clean("<a href='https://ok.com'>ok</a>")).toContain('<a href="https://ok.com">ok</a>');
  });

  it("strips <meta http-equiv=refresh> and <base>", () => {
    const out = clean('<meta http-equiv="refresh" content="0;url=http://evil"><base href="http://evil/"><p>x</p>');
    expect(out).not.toMatch(/refresh/i);
    expect(out).not.toMatch(/<base/i);
    expect(out).toContain("<p>x</p>");
  });

  it("strips SVG and its event handlers / xlink:href", () => {
    const out = clean("<svg onload='alert(1)'><a xlink:href='javascript:alert(1)'>x</a></svg><p>ok</p>");
    expect(out).not.toMatch(/<svg/i);
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/xlink/i);
    expect(out).toContain("<p>ok</p>");
  });

  it("drops iframe/object/embed/form controls, keeps <style>", () => {
    const a = clean("<iframe src=x></iframe><object></object><p>a</p>");
    expect(a).toContain("<p>a</p>");
    expect(a).not.toMatch(/iframe|object/i);
    const b = clean("<form><input><button>b</button></form><p>a</p>");
    expect(b).toContain("<p>a</p>");
    expect(b).not.toMatch(/<form|<input|<button/i);
    expect(clean("<style>.a{color:red}</style><p>a</p>")).toContain("<style>.a{color:red}</style>");
  });
});

describe("email sanitizer — DoS caps (Part F)", () => {
  it("falls back on an oversized body", () => {
    const huge = "<p>a</p>".repeat(MAX_HTML_BYTES); // way over the byte cap
    const r = sanitizeEmailHtml(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-large");
  });
  it("falls back on absurd node counts", () => {
    const deep = "<div>".repeat(MAX_NODES + 100);
    const r = sanitizeEmailHtml(deep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-many-nodes");
  });
  it("renders a realistically-large table newsletter inline (not text fallback)", () => {
    // ~24k tags of nested tables — a normal marketing email, well over the old
    // 15k cap that used to dump it to plain text.
    const cell = "<table><tr><td><span>x</span></td></tr></table>";
    const news = `<div>${cell.repeat(3_000)}</div>`; // 3000 * 8 ≈ 24k tags
    expect((news.match(/</g) ?? []).length).toBeGreaterThan(15_000);
    const r = sanitizeEmailHtml(news);
    expect(r.ok).toBe(true);
  });
});

describe("email sanitizer — cid rewrite", () => {
  it("rewrites cid: src via the resolver before sanitizing", () => {
    const out = clean('<img src="cid:logo@x">', { resolveCid: (c) => (c === "logo@x" ? "/api/attachments/abc" : null) });
    expect(out).toContain('src="/api/attachments/abc"');
  });
  it("keeps inert data:image raster but blanks data:image/svg+xml", () => {
    expect(clean('<img src="data:image/png;base64,AAA">')).toContain("data:image/png");
    const svg = clean('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
    expect(svg).not.toContain("svg+xml");
    expect(svg).toMatch(/<img[^>]*src=""/);
  });

  it("blanks an unresolved cid: image (no cid: string survives)", () => {
    const out = clean('<img src="cid:missing">', { resolveCid: () => null });
    expect(out).not.toContain("cid:");
    expect(out).toMatch(/<img[^>]*src=""/);
  });
});

describe("framed document (A2)", () => {
  it("collapses a nested full document into ONE body carrying the email's body attrs + rules", () => {
    const raw =
      '<!doctype html><html><head><style>.body{font-family:Roboto}</style></head>' +
      '<body class="body" style="color:blue"><div class="main">Hello</div></body></html>';
    const doc = buildFramedDocument(clean(raw), { csp: "default-src 'none'" });
    // Exactly one <body>, and it carries the email's class so `.body` still matches.
    expect(doc.match(/<body\b/gi)?.length).toBe(1);
    expect(doc).toMatch(/<body[^>]*class="body"/);
    expect(doc).toContain(".body{font-family:Roboto}"); // email <style> preserved
    expect(doc).toContain('<div class="main">Hello</div>');
    // No nested structural wrappers survived inside.
    expect(doc.match(/<html\b/gi)?.length).toBe(1);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain("color-scheme:light"); // Part I: force light
  });
});

describe("remote resource rewriting (golden image handling)", () => {
  const proxy = (u: string) => `/api/img-proxy?url=${encodeURIComponent(u)}`;

  it("collects remote URLs from img, background attr, srcset, and CSS url()", () => {
    const html =
      '<img src="https://cdn.x/a.png">' +
      '<td background="https://cdn.x/hero.png">' +
      '<img srcset="https://cdn.x/1.png 1x, https://cdn.x/2.png 2x">' +
      '<div style="background-image:url(https://cdn.x/bg.png)">' +
      '<style>.h{background:url("https://cdn.x/s.png")}</style>';
    const urls = collectRemoteResourceUrls(html);
    expect(urls).toContain("https://cdn.x/a.png");
    expect(urls).toContain("https://cdn.x/hero.png");
    expect(urls).toContain("https://cdn.x/1.png");
    expect(urls).toContain("https://cdn.x/2.png");
    expect(urls).toContain("https://cdn.x/bg.png");
    expect(urls).toContain("https://cdn.x/s.png");
  });

  it("rewrites every remote reference through the proxy (backgrounds included)", () => {
    const html =
      '<td background="https://cdn.x/hero.png"><div style="background-image:url(https://cdn.x/bg.png)">hi</div></td>';
    const out = rewriteRemoteResourceUrls(html, proxy);
    expect(out).toContain(`background="${proxy("https://cdn.x/hero.png")}"`);
    expect(out).toContain(`url('${proxy("https://cdn.x/bg.png")}')`);
    expect(out).not.toContain("cdn.x/hero.png\"");
  });

  it("strips @import outright (no external stylesheets)", () => {
    const html = '<style>@import url("https://evil/track.css");.a{color:red}</style>';
    const out = rewriteRemoteResourceUrls(html, proxy);
    expect(out).not.toContain("@import");
    expect(out).toContain(".a{color:red}");
  });

  it("drops a URL the resolver blanks (images-off pass)", () => {
    const html = '<img src="https://cdn.x/a.png"><div style="background:url(https://cdn.x/b.png)">';
    const out = rewriteRemoteResourceUrls(html, () => null);
    expect(out).not.toContain("cdn.x");
    expect(out).toContain("url()");
  });

  it("leaves cid/data URLs and relative paths untouched", () => {
    const html = '<img src="cid:logo"><img src="data:image/png;base64,AAAA"><img src="/local.png">';
    expect(collectRemoteResourceUrls(html)).toEqual([]);
    expect(rewriteRemoteResourceUrls(html, proxy)).toBe(html.replace(/@import\b[^;]*;?/gi, ""));
  });
});

describe("email sanitizer — CSS scrub (F2)", () => {
  it("neutralizes expression(), binding, behavior, and js: url() in kept CSS", () => {
    const out = clean(
      "<style>.a{width:expression(alert(1));-moz-binding:url(x.xml);behavior:url(x.htc);background:url(javascript:alert(1))}</style><p>ok</p>",
    );
    expect(out).not.toMatch(/expression\s*\(/i);
    expect(out).not.toMatch(/-moz-binding\s*:/i);
    expect(out).not.toMatch(/[^-]behavior\s*:/i);
    expect(out).not.toMatch(/url\(\s*javascript/i);
    expect(out).toContain("<p>ok</p>");
  });
});
