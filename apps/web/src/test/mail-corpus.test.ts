// SPDX-License-Identifier: Apache-2.0
// Corpus test: realistic full-body samples from the major clients/providers run
// end-to-end through the render pipeline — strip quotes → classify rich → sanitize
// → collect remote refs for the proxy. Guards the two failures that actually bit
// us: a forwarded/marketing template stripped to empty, and a rich template
// misread as a text bubble. Bodies mirror each client's real DOM (marker classes,
// wrapper divs, table layouts), not the tiny synthetic snippets in the contract test.
import { describe, it, expect } from "vitest";
import { stripQuotesHtml, isRichHtml, deriveContentKind } from "@doota/mail-core/mail-thread-contract";
import { sanitizeEmailHtml, collectRemoteResourceUrls } from "@doota/mail-core/sanitize-email";

const sanitized = (html: string) => {
  const r = sanitizeEmailHtml(html);
  if (!r.ok) throw new Error(`sanitizer fell back: ${r.reason}`);
  return r.html;
};

// --- Realistic bodies -------------------------------------------------------

// Gmail forward: whole original wrapped in a top-level gmail_quote with an empty
// head. The original is a Mailchimp-style table with a remote hero image.
const GMAIL_FWD = `<div dir="ltr"><br></div><br><div class="gmail_quote">
<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <b>Acme</b> &lt;news@acme.com&gt;<br>Date: Mon, 14 Jul 2026<br>Subject: Summer sale<br></div><br><br>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#f4f4f4">
<tr><td align="center"><img src="https://cdn.acme.com/hero.png" width="600" alt="Summer"></td></tr>
<tr><td style="padding:24px;font-family:Helvetica"><h1>Up to 50% off</h1><p>Shop the sale.</p></td></tr>
</table></div>`;

// Gmail reply: reply text, then the quoted parent in a gmail_quote with a real head.
const GMAIL_REPLY = `<div dir="ltr">Sounds good, shipping Friday.</div>
<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Jul 14, 2026 at 9:02 AM Bob &lt;bob@x.com&gt; wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">Can you ship this week?</blockquote></div>`;

// Outlook / OWA reply: WordSection body, divRplyFwdMsg divider with "Subject: RE:".
const OUTLOOK_REPLY = `<div class="WordSection1"><p class="MsoNormal">Approved, thanks.</p></div>
<div id="divRplyFwdMsg"><hr><b>From:</b> Carol &lt;carol@corp.com&gt;<br><b>Sent:</b> Monday<br><b>Subject:</b> RE: Q3 budget<br></div>
<div><p class="MsoNormal">Please review the attached budget.</p></div>`;

// Apple Mail reply: reply text then blockquote type="cite" (its quote wrapper).
const APPLE_REPLY = `<div>Yes, let's meet at 3.</div><br>
<div><blockquote type="cite">On Jul 14, 2026, at 08:11, Dana &lt;dana@me.com&gt; wrote:<br><br>Does 3pm work?</blockquote></div>`;

// Yahoo reply: yahoo_quoted wrapper.
const YAHOO_REPLY = `<div dir="ltr">Confirmed.</div><div class="yahoo_quoted"><div>On Monday, Eve wrote:</div><blockquote>the original</blockquote></div>`;

// Mailchimp newsletter (delivered directly, not forwarded): full mc table layout
// with remote images in src and a CSS background-image.
const MAILCHIMP = `<table class="mcnEmailBody" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff">
<tr><td class="mcnImageBlockInner" style="background-image:url('https://mc.us1.list-manage.com/bg.jpg')">
<img class="mcnImage" src="https://mc.us1.list-manage.com/logo.png" width="180" alt="Brand"></td></tr>
<tr><td class="mcnTextContent" style="font-family:Georgia;color:#202020;padding:18px">
<h1>This week in tech</h1><p>Top stories, curated.</p><a href="https://acme.com/read">Read more</a></td></tr>
</table>`;

// Amazon-style receipt: nested transactional table, no images.
const AMAZON = `<table width="100%" cellpadding="0" cellspacing="0"><tr><td>
<table width="600" style="border:1px solid #ddd"><tr><td style="padding:20px;font-family:Arial">
<h2>Your order has shipped</h2><table><tr><td>1× Widget</td><td align="right">$19.99</td></tr>
<tr><td><b>Total</b></td><td align="right"><b>$19.99</b></td></tr></table></td></tr></table></td></tr></table>`;

// --- Tests ------------------------------------------------------------------

describe("corpus — forwards & templates are kept whole and render as HTML", () => {
  const kept: [string, string][] = [
    ["Gmail forward", GMAIL_FWD],
    ["Mailchimp newsletter", MAILCHIMP],
    ["Amazon receipt", AMAZON],
  ];
  for (const [name, body] of kept) {
    it(`${name}: not stripped to empty, classified rich → HTML frame`, () => {
      const stripped = stripQuotesHtml(body);
      // The point of these messages IS the template — stripping must not gut it.
      expect(stripped.replace(/\s/g, "").length).toBeGreaterThan(body.replace(/\s/g, "").length * 0.8);
      expect(isRichHtml(stripped)).toBe(true);
      expect(deriveContentKind({ strippedText: "", hasAttachments: false, htmlLength: stripped.length })).toBe("card");
    });
    it(`${name}: survives the sanitizer with its table intact`, () => {
      const out = sanitized(body);
      expect(out).toMatch(/<table/i);
      expect(out).not.toMatch(/<script|onclick|onerror/i);
    });
  }

  it("Gmail forward & Mailchimp expose remote refs for the proxy (src + css url)", () => {
    expect(collectRemoteResourceUrls(GMAIL_FWD)).toContain("https://cdn.acme.com/hero.png");
    const mc = collectRemoteResourceUrls(MAILCHIMP);
    expect(mc).toContain("https://mc.us1.list-manage.com/logo.png");
    expect(mc).toContain("https://mc.us1.list-manage.com/bg.jpg"); // background-image, not just <img src>
  });
});

describe("corpus — replies strip to the reply text across clients", () => {
  const replies: [string, string, RegExp, RegExp][] = [
    ["Gmail", GMAIL_REPLY, /shipping Friday/, /Can you ship this week/],
    ["Outlook", OUTLOOK_REPLY, /Approved, thanks/, /Please review the attached budget/],
    ["Apple Mail", APPLE_REPLY, /let's meet at 3/, /Does 3pm work/],
    ["Yahoo", YAHOO_REPLY, /Confirmed/, /the original/],
  ];
  for (const [name, body, keep, drop] of replies) {
    it(`${name}: keeps the reply, drops the quoted parent`, () => {
      const out = stripQuotesHtml(body);
      expect(out).toMatch(keep);
      expect(out).not.toMatch(drop);
    });
  }
});
