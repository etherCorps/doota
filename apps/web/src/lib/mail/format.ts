// SPDX-License-Identifier: Apache-2.0
// Pure, stateless formatting + reply-audience helpers extracted from the mail
// hub page. No reactive state, no component context — everything here is a plain
// function of its arguments, which keeps the 2.7k-line page readable and lets
// these be unit-tested in isolation. Identity-dependent helpers take the derived
// `self` set as a parameter rather than closing over a prop.
import type { MessageDTO } from '@doota/mail-core/mail-thread-contract';
import type { SendIdentity } from '@doota/mail-core/identities';

export function fmtTime(ms: number | null): string {
	if (!ms) return '';
	return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Sender identity for list rows + message monograms. `from` is a raw header
// ("Name <addr>" or a bare address); pull a human name.
export function senderName(from: string | null): string {
	if (!from) return 'Unknown';
	const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
	if (named?.[1]?.trim()) return named[1].trim();
	// Email-derived fallback (no display name): tidy the local part and capitalize
	// the first character so a bare "bob.smith@" reads as "Bob smith", not "bob smith".
	const local = from.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
	if (!local) return from;
	return local.charAt(0).toUpperCase() + local.slice(1);
}
// Prefer the display name the sending provider actually put in the mail data
// (fromName) over splitting the email — falls back to the header parse / local
// part when a bare address is all we have (e.g. pre-fromName mail).
export const senderLabel = (m: { fromName?: string | null; from: string | null }): string =>
	m.fromName?.trim() || senderName(m.from);
// The bare email out of a `from` header ("Name <addr>" or a bare address).
export const senderAddr = (from: string | null): string =>
	(from?.match(/<([^>]+)>/)?.[1] ?? from ?? '').trim();
export function senderEmail(from: string | null): string {
	return from?.match(/<([^>]+)>/)?.[1] ?? from ?? '';
}

// Day dividers for the chat view. Items are a mixed union; each type carries its
// timestamp under a different key.
export function itemMs(it: unknown): number | null {
	const o = it as { sentAt?: number | null; at?: number | null; createdAt?: number | null };
	return o.sentAt ?? o.at ?? o.createdAt ?? null;
}
export function isNewDay(items: unknown[], i: number): boolean {
	const ms = itemMs(items[i]);
	if (ms == null) return false;
	for (let j = i - 1; j >= 0; j--) {
		const prev = itemMs(items[j]);
		if (prev != null) return new Date(ms).toDateString() !== new Date(prev).toDateString();
	}
	return true;
}
export const fmtDay = (ms: number) =>
	new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** First text line of a message, for the collapsed-header preview. */
export function msgSnippet(m: MessageDTO): string {
	return (m.bodyStripped ?? m.bodyFull ?? '').split('\n').find((l) => l.trim()) ?? '';
}

// Grouped day → message, so a message's files stay together as one tile grid.
/** Attachments worth surfacing: skip inline (cid) parts — they render in the body
 * — and the calendar `.ics` of an invite (the invite card already carries it).
 * Matches the per-message tile filter + the thread's attachment badge count. */
export const shownAttachments = (m: MessageDTO) =>
	m.attachments.filter(
		(a) =>
			!a.inline &&
			!(m.calendarInvite && (a.contentType?.includes('calendar') || a.filename?.toLowerCase().endsWith('.ics')))
	);

export function groupAttachments(msgs: MessageDTO[]) {
	const days: { day: string; entries: { msg: MessageDTO; atts: MessageDTO['attachments'] }[] }[] = [];
	for (const msg of msgs) {
		const atts = shownAttachments(msg);
		if (!atts.length) continue;
		const day = msg.sentAt ? fmtDay(msg.sentAt) : 'Unknown date';
		let d = days.at(-1);
		if (!d || d.day !== day) {
			d = { day, entries: [] };
			days.push(d);
		}
		d.entries.push({ msg, atts });
	}
	return days;
}
export const isImage = (a: { contentType: string | null }) => !!a.contentType?.startsWith('image/');
export const fileExt = (name: string | null) => name?.match(/\.(\w{1,5})$/)?.[1]?.toUpperCase() ?? 'FILE';
export const fmtSize = (n: number | null) =>
	n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
// `fileTile` (type-tinted icon tile) stays in the page — it returns lucide
// `.svelte` icon components, which this pure-TS module must not import.

// --- Reply audience ---------------------------------------------------------
// Subaddress-normalize: you+tag@x and you@x are the same inbox.
export const baseAddr = (a: string) => a.toLowerCase().replace(/^([^@+]+)\+[^@]*@/, '$1@');
/** The viewer's own addresses (base-normalized) — pass to the audience helpers. */
export const selfSet = (identities: SendIdentity[]) => new Set(identities.map((i) => baseAddr(i.address)));

// Everyone who's appeared on the thread (from/to/cc across all messages).
export function threadParticipants(msgs: MessageDTO[]): Set<string> {
	const s = new Set<string>();
	for (const m of msgs) for (const a of [m.from, ...m.to, ...m.cc]) if (a) s.add(a.toLowerCase());
	return s;
}
// A message whose audience is a strict subset of the thread's participants is
// PRIVATE — a reply that dropped people. Returns who (besides you) can see it,
// or null when everyone on the thread is on the message.
export function msgPrivateTo(m: MessageDTO, parts: Set<string>, self: Set<string>): string[] | null {
	const aud = new Set<string>();
	for (const a of [m.from, ...m.to, ...m.cc]) if (a) aud.add(a.toLowerCase());
	if (aud.size >= parts.size) return null; // reaches everyone on the thread
	return [...aud].filter((a) => !self.has(baseAddr(a)));
}
// Reply-all only means something when the message reaches ≥2 people besides you.
export function msgCanReplyAll(m: MessageDTO, self: Set<string>): boolean {
	const all = new Set([m.from ?? '', ...m.to, ...m.cc].filter(Boolean).map(baseAddr));
	for (const s of self) all.delete(s);
	return all.size >= 2;
}

// Reply context. Audience is derived from ONE message — the explicitly chosen
// target, else the latest inbound (falling back to the newest). reply-one goes
// to the sender (inbound) or the person you wrote to (outbound); reply-all adds
// the rest of that message's To/Cc, minus your own identities.
export function replyCtx(
	msgs: MessageDTO[],
	target: { msgId: string; scope: 'reply' | 'reply_all' } | null,
	self: Set<string>
) {
	const chosen = target ? msgs.find((m) => m.id === target.msgId) : undefined;
	// A base must yield a reply address, or the whole reply bar vanishes —
	// e.g. a DSN/bounce with no From as the latest inbound. Skip those.
	const usable = (m: MessageDTO) => (m.outbound ? !!(m.to[0] ?? m.cc[0]) : !!(m.replyTo || m.from));
	const rev = [...msgs].reverse();
	const base = chosen ?? rev.find((m) => !m.outbound && usable(m)) ?? rev.find(usable) ?? msgs.at(-1);
	const notSelf = (a: string) => a && !self.has(baseAddr(a));
	const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean).map((x) => x.toLowerCase()))];
	let primary = base?.outbound ? (base.to[0] ?? base.cc[0] ?? '') : base?.replyTo || base?.from || '';
	// Audience: an explicit per-message Reply(-all) scopes to THAT message; the
	// default docked composer is thread-level, so its Reply-all reaches every
	// participant — else a private reply-to-one as the latest inbound would
	// hide the Reply/Reply-all switch even on a multi-party thread.
	const audMsgs = chosen ? [chosen] : msgs;
	const toAll = uniq([primary, ...audMsgs.flatMap((m) => [m.from ?? '', ...m.to])]).filter(notSelf);
	const ccAll = uniq(audMsgs.flatMap((m) => m.cc)).filter((a) => notSelf(a) && !toAll.includes(a));
	// Last resort (explicitly-targeted message without a From): reply to the
	// first non-self participant rather than hiding the composer.
	if (!primary) primary = toAll[0] ?? ccAll[0] ?? '';
	return {
		target: primary,
		toAll,
		ccAll,
		aliasId: base?.viaAliasId ?? null,
		parent: base,
		// Explicit target drives the composer's opening scope + auto-expand.
		scope: (chosen ? target!.scope : 'reply') as 'reply' | 'reply_all',
		autoOpen: !!chosen
	};
}

// --- Forward ----------------------------------------------------------------
export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function fwdBlock(m: MessageDTO): string {
	const orig = escHtml(m.bodyFull ?? m.bodyStripped ?? '').replace(/\r?\n/g, '<br>');
	const header = [
		`From: ${m.from ?? ''}`,
		m.sentAt ? `Date: ${new Date(m.sentAt).toLocaleString()}` : '',
		`Subject: ${m.subject ?? ''}`,
		m.to.length ? `To: ${m.to.join(', ')}` : ''
	]
		.filter(Boolean)
		.map((l) => `<p>${escHtml(l)}</p>`)
		.join('');
	return `${header}<blockquote>${orig}</blockquote>`;
}
