// SPDX-License-Identifier: Apache-2.0
import { render } from "@ethercorps/un-jinja";
import type { MailFrom } from "@doota/db/org-domains";
import layout from "./templates/_layout.html?raw";
import verifyEmail from "./templates/verify-email.html?raw";
import resetLink from "./templates/reset-link.html?raw";
import resetCode from "./templates/reset-code.html?raw";
import recoveryVerify from "./templates/recovery-verify.html?raw";
import invite from "./templates/invite.html?raw";
import memberJoined from "./templates/member-joined.html?raw";
import welcome from "./templates/welcome.html?raw";

/**
 * Transactional email templates. HTML lives in `./templates/*.html` (imported
 * as raw strings, so they bundle into the Worker — no fs at runtime) and is
 * rendered with un-jinja (Jinja2-like, auto-escapes by default). Each body is
 * composed into the shared branded `_layout.html`, which pulls the org name +
 * logo + from-address so every mail is org-branded (T2 sender + BIMI logo).
 *
 * Replaces the old `@better-svelte-email` renderer (dropped — buggy per T6).
 */

type Ctx = Record<string, unknown> & { brand: Brand };
type Brand = { name: string; logo: string | null; email: string };
type Template = { body: string; subject: string | ((ctx: Ctx) => string) };

const TEMPLATES = {
  "verify-email": { body: verifyEmail, subject: "Verify your email" },
  "reset-link": { body: resetLink, subject: "Reset your password" },
  "reset-code": { body: resetCode, subject: "Your password reset code" },
  "recovery-verify": { body: recoveryVerify, subject: "Confirm your recovery email" },
  invite: {
    body: invite,
    subject: (ctx: Ctx) => `You've been invited to ${ctx.brand.name}`,
  },
  // Invite-completion pair: the inviter learns their member is in; the
  // invitee's thank-you is the first mail in their new inbox.
  "member-joined": {
    body: memberJoined,
    subject: (ctx: Ctx) => `${String(ctx.memberName)} joined ${ctx.brand.name}`,
  },
  welcome: {
    body: welcome,
    subject: (ctx: Ctx) => `Welcome to ${ctx.brand.name}`,
  },
} satisfies Record<string, Template>;

export type EmailName = keyof typeof TEMPLATES;

/** Branding context for the layout. `from` carries the org name/logo/address. */
function brandOf(from?: MailFrom): Brand {
  return {
    name: from?.name || "Doota",
    logo: from?.logo ?? null,
    email: from?.email ?? "",
  };
}

/**
 * Render a transactional email to `{ subject, html, text }`. `from` supplies the
 * org branding; the rest of `vars` fills the template (links, codes, etc.).
 */
export function renderEmail(
  name: EmailName,
  opts: { from?: MailFrom } & Record<string, unknown>,
): { subject: string; html: string; text: string } {
  const { from, ...vars } = opts;
  const ctx: Ctx = { ...vars, brand: brandOf(from) };
  const t = TEMPLATES[name];
  const subject = typeof t.subject === "function" ? t.subject(ctx) : t.subject;
  // Body renders with auto-escaping; it's then injected into the layout via the
  // `safe` filter (already-escaped HTML must not be escaped a second time).
  const content = render(t.body, ctx);
  const html = render(layout, { ...ctx, content, subject, preview: subject });
  return { subject, html, text: htmlToText(content) };
}

/**
 * Derive a plaintext part from the rendered body. The templates surface every
 * actionable value (link, code) as visible text, so stripping tags keeps them.
 * ponytail: good-enough tag stripper for our own transactional templates — not a
 * general HTML→text engine. Swap for a library only if templates get richer.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h1|h2|h3|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
