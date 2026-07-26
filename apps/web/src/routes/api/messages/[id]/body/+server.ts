// SPDX-License-Identifier: Apache-2.0
import { error, type RequestHandler } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";
import { importKey, decryptContent } from "@doota/mail-core/crypto";
import { sanitizeEmailHtml, buildFramedDocument } from "@doota/mail-core/sanitize-email";
import { actorOrgAdminOf } from "$lib/server/provisioning.js";
import { accessibleMailboxIds } from "@doota/mail-core/mailbox";

/**
 * Serve ONE message's HTML body, sanitized, as an isolated document for the
 * <iframe src>. This is the security boundary for untrusted email HTML:
 *
 *  - Sanitize-at-READ, SERVER-side (here) — raw MIME in R2 + the encrypted body
 *    stay canonical; a sanitizer fix protects all historical mail immediately.
 *  - The frame is loaded with sandbox="allow-scripts" and NO allow-same-origin,
 *    so despite being same-origin it runs in an OPAQUE origin and can't touch the
 *    app. We can therefore set a real CSP *header* (srcdoc can't) AND run our own
 *    measuring/link script (allowed by a script-src sha256 hash; the email's
 *    scripts were removed by the sanitizer and would never match the hash).
 *  - Remote images never hit the browser directly: on opt-in they're rewritten to
 *    the same-origin image proxy, so img-src stays 'self' and the sender never
 *    sees the reader's IP.
 *
 * NEVER add allow-same-origin to the frame that loads this — combined with
 * allow-scripts it lets the framed document strip its own sandbox and escape.
 */

// Our own script, injected AFTER sanitization (the email's scripts are gone and
// wouldn't match the script-src hash). It reports height and handles link clicks
// IN the click gesture — opening in the frame, not via the parent, so the browser
// doesn't popup-block it. Only mailto: is handed up (to the composer). The link
// security rules mirror lib/utils/mail-link.ts (classifyMailLink), kept in sync.
const INJECTED_SCRIPT =
  "(function(){" +
  "function h(){var b=document.body;if(!b)return;" +
  "parent.postMessage({__mailframe:1,type:'height',value:Math.ceil(b.getBoundingClientRect().height)+8},'*');}" +
  "addEventListener('load',h);if(document.readyState!=='loading')h();" +
  "try{new ResizeObserver(h).observe(document.body);}catch(e){}" +
  "function textHost(t){t=(t||'').trim();if(!t||/\\s/.test(t))return null;" +
  "var m=t.match(/^(?:https?:\\/\\/)?([a-z0-9.-]+\\.[a-z]{2,})/i);return m?m[1].toLowerCase():null;}" +
  "document.addEventListener('click',function(e){" +
  "var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;e.preventDefault();" +
  "var href=a.getAttribute('href')||'';" +
  "if(!/^[a-z][a-z0-9+.-]*:/i.test(href))return;" + // absolute-scheme only; drop relative
  "var u;try{u=new URL(href);}catch(_){return;}var s=u.protocol.toLowerCase();" +
  "if(s==='mailto:'){parent.postMessage({__mailframe:1,type:'mailto',address:decodeURIComponent(u.pathname)},'*');return;}" +
  "if(s!=='http:'&&s!=='https:')return;" + // drop javascript:, data:, file:, …
  "var host=u.hostname.toLowerCase();" +
  "var idn=host.split('.').some(function(l){return l.indexOf('xn--')===0;});" +
  "var claimed=textHost(a.textContent||'');" +
  "var mismatch=!!claimed&&claimed!==host&&host.slice(-(claimed.length+1))!=='.'+claimed&&claimed.slice(-(host.length+1))!=='.'+host;" +
  "if(idn||mismatch){var msg=mismatch?('The link text says \"'+claimed+'\" but it actually goes to '+host+'.'):" +
  "(host+' uses internationalized (non-ASCII) characters that can imitate a real domain.');" +
  "if(!confirm(msg+'\\n\\nOpen it anyway?'))return;}" +
  "window.open(u.href,'_blank','noopener,noreferrer');" +
  "},true);})();";

async function sha256Base64(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

/** On opt-in, route remote images through the same-origin proxy so img-src stays
 * 'self' and the browser never fetches from the sender directly. */
function proxyRemoteImages(html: string): string {
  return html.replace(/(\bsrc\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi, (_m, pre, url, post) => {
    return `${pre}/api/img-proxy?url=${encodeURIComponent(url)}${post}`;
  });
}

export const GET: RequestHandler = async ({ params, url, locals, platform }) => {
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  const dek = platform?.env?.MAIL_DEK;
  if (!dek) error(500, "Mail encryption key is not configured.");

  const msg = await locals.db.query.message.findFirst({
    where: eq(schema.message.id, params.id!),
    columns: { id: true, orgId: true, bodyHtmlEnc: true, bodyStrippedEnc: true },
  });
  if (!msg) error(404, "Message not found");

  // Access mirrors thread read + the attachment endpoint: a delivery to one of
  // the user's mailboxes, or org-level read via can().
  const myBoxes = await accessibleMailboxIds(locals.db, user.id);
  let allowed = false;
  if (myBoxes.length) {
    const del = await locals.db.query.delivery.findFirst({
      where: and(eq(schema.delivery.messageId, msg.id), inArray(schema.delivery.mailboxId, myBoxes)),
      columns: { id: true },
    });
    allowed = !!del;
  }
  if (!allowed) {
    const orgAdminOf = await actorOrgAdminOf(locals.db, user.id);
    allowed = can(
      { id: user.id, role: user.role, orgAdminOf },
      "read",
      { type: "mailbox", ownerId: "", organizationId: msg.orgId },
    );
  }
  if (!allowed) error(403, "You can't access this message.");

  const ck = await importKey(dek);
  const rawHtml = await decryptContent(ck, msg.bodyHtmlEnc);
  const loadImages = url.searchParams.get("images") === "1";

  // cid: → our authenticated attachment endpoint, resolved from THIS message's parts.
  const atts = await locals.db
    .select({ id: schema.attachment.id, partId: schema.attachment.partId })
    .from(schema.attachment)
    .where(eq(schema.attachment.messageId, msg.id));
  const resolveCid = (cid: string): string | null => {
    const a = atts.find((x) => (x.partId ?? "").replace(/^<|>$/g, "") === cid);
    return a ? `/api/attachments/${a.id}` : null;
  };

  let inner: string;
  const result = rawHtml ? sanitizeEmailHtml(rawHtml, { resolveCid }) : null;
  if (result && result.ok) {
    inner = loadImages ? proxyRemoteImages(result.html) : result.html;
  } else {
    // No HTML, or oversized/hostile (Part F) → fall back to the plain-text body.
    const text = (await decryptContent(ck, msg.bodyStrippedEnc)) ?? "";
    inner = `<div style="white-space:pre-wrap;font:14px system-ui,sans-serif">${escapeText(text)}</div>`;
  }

  const scriptHash = await sha256Base64(INJECTED_SCRIPT);
  // Remote images load only via the same-origin proxy → img-src stays 'self'.
  const directives = [
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "media-src data:",
    `script-src 'sha256-${scriptHash}'`,
    "form-action 'none'",
    "base-uri 'none'",
    // Explicit even though default-src covers them — intent is readable and a future
    // default-src relaxation can't silently reopen these.
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "connect-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ];
  const metaCsp = directives.join("; ");
  // Header-only directives (a <meta> CSP can't express these).
  const headerCsp = `${metaCsp}; sandbox allow-scripts; frame-ancestors 'self'`;

  const doc = buildFramedDocument(inner, {
    csp: metaCsp,
    bodyExtra: `<script>${INJECTED_SCRIPT}</script>`,
  });

  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": headerCsp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
};
