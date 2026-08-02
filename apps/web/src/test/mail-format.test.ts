// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import type { MessageDTO } from '@doota/mail-core/mail-thread-contract';
import {
	senderName,
	senderAddr,
	senderLabel,
	fmtDateTime,
	domainOf,
	senderProvider,
	fmtSize,
	fileExt,
	selfSet,
	msgCanReplyAll,
	replyCtx,
	threadParticipants,
	forwardableMessages
} from '$lib/mail/format';
import { isDmarcPass } from '@doota/mail-core/inbound-worker';

// Minimal message factory — only the fields the audience helpers read.
const msg = (p: Partial<MessageDTO>): MessageDTO =>
	({ id: 'm', from: null, to: [], cc: [], outbound: false, ...p }) as unknown as MessageDTO;

describe('sender formatting', () => {
	it('pulls the display name from a header, falls back to the local part', () => {
		expect(senderName('"Jane Doe" <j@x.com>')).toBe('Jane Doe');
		expect(senderName('Jane Doe <j@x.com>')).toBe('Jane Doe');
		expect(senderName('bob.smith@x.com')).toBe('Bob smith');
		expect(senderName(null)).toBe('Unknown');
	});
	it('senderAddr extracts the bare address', () => {
		expect(senderAddr('Jane <j@x.com>')).toBe('j@x.com');
		expect(senderAddr('j@x.com')).toBe('j@x.com');
	});
	it('senderLabel prefers fromName over the header parse', () => {
		expect(senderLabel({ fromName: 'Provider Name', from: 'x@y.com' })).toBe('Provider Name');
		expect(senderLabel({ fromName: null, from: 'Jane <j@x.com>' })).toBe('Jane');
	});
	it('domainOf lowercases and strips the local part', () => {
		expect(domainOf('Jane <J@Example.COM>')).toBe('example.com');
		expect(domainOf('bare@acme.io')).toBe('acme.io');
		expect(domainOf(null)).toBe('');
		expect(domainOf('no-at-sign')).toBe('');
	});
	it('senderProvider maps known consumer domains, null otherwise', () => {
		expect(senderProvider('x@gmail.com')).toBe('Gmail');
		expect(senderProvider('x@GOOGLEMAIL.COM')).toBe('Gmail');
		expect(senderProvider('x@hotmail.com')).toBe('Outlook');
		expect(senderProvider('x@acme.com')).toBeNull(); // custom domain → needs MX, not guessed
	});
});

describe('fmtDateTime (details panel)', () => {
	it('uses a month name (not a number) + year, and includes a time', () => {
		// Noon UTC won't cross a day boundary in any real runner TZ, so Aug holds.
		const s = fmtDateTime(Date.UTC(2026, 7, 2, 12, 0));
		expect(s).toMatch(/Aug/); // month NAME, not "8"
		expect(s).toContain('2026');
		expect(s).toMatch(/\d:\d/); // a time component
		expect(s).not.toMatch(/\b8\/2\/2026\b/); // not the numeric M/D/Y form
	});
	it('empty for null', () => {
		expect(fmtDateTime(null)).toBe('');
	});
});

describe('isDmarcPass (sender-verified shield)', () => {
	it('true only on an explicit dmarc=pass', () => {
		expect(isDmarcPass('mx.cf.net; dkim=pass header.d=x.com; spf=pass; dmarc=pass header.from=x.com')).toBe(true);
		expect(isDmarcPass('mx.cf.net; dkim=fail; spf=softfail; dmarc=fail header.from=x.com')).toBe(false);
		expect(isDmarcPass('mx.cf.net; dmarc=none')).toBe(false);
		expect(isDmarcPass(null)).toBe(false);
		expect(isDmarcPass('')).toBe(false);
	});
});

describe('file helpers', () => {
	it('fmtSize switches KB→MB and handles null', () => {
		expect(fmtSize(null)).toBe('');
		expect(fmtSize(2048)).toBe('2 KB');
		expect(fmtSize(2_000_000)).toBe('2.0 MB');
	});
	it('fileExt uppercases the extension, defaults to FILE', () => {
		expect(fileExt('report.pdf')).toBe('PDF');
		expect(fileExt('noext')).toBe('FILE');
		expect(fileExt(null)).toBe('FILE');
	});
});

describe('reply audience', () => {
	const self = selfSet([{ address: 'me@x.com' }] as never);

	it('reply-all only when the message reaches ≥2 besides you', () => {
		expect(msgCanReplyAll(msg({ from: 'a@x.com', to: ['me@x.com', 'b@x.com'] }), self)).toBe(true);
		expect(msgCanReplyAll(msg({ from: 'a@x.com', to: ['me@x.com'] }), self)).toBe(false);
	});

	it('replyCtx targets the latest inbound sender and excludes self', () => {
		const msgs = [msg({ id: '1', from: 'a@x.com', to: ['me@x.com', 'b@x.com'] })];
		const ctx = replyCtx(msgs, null, self);
		expect(ctx.target).toBe('a@x.com');
		expect(ctx.toAll).toContain('a@x.com');
		expect(ctx.toAll).toContain('b@x.com');
		expect(ctx.toAll).not.toContain('me@x.com');
		expect(ctx.scope).toBe('reply');
		expect(ctx.autoOpen).toBe(false);
	});

	it('an explicit target drives scope + autoOpen', () => {
		const msgs = [
			msg({ id: '1', from: 'a@x.com', to: ['me@x.com'] }),
			msg({ id: '2', from: 'c@x.com', to: ['me@x.com'] })
		];
		const ctx = replyCtx(msgs, { msgId: '1', scope: 'reply_all' }, self);
		expect(ctx.target).toBe('a@x.com');
		expect(ctx.scope).toBe('reply_all');
		expect(ctx.autoOpen).toBe(true);
	});
});

describe('forwardableMessages', () => {
	const self = selfSet([{ address: 'me@x.com' }] as never);

	it('keeps thread-wide messages and drops a private sub-reply the forwarder was not on', () => {
		const msgs = [
			// Public: reaches all four participants.
			msg({ id: '1', from: 'a@x.com', to: ['me@x.com', 'b@x.com', 'c@x.com'] }),
			// Private sub-reply between a and b only — forwarder (me) not on it.
			msg({ id: '2', from: 'a@x.com', to: ['b@x.com'] })
		];
		const parts = threadParticipants(msgs);
		const out = forwardableMessages(msgs, parts, self).map((m) => m.id);
		expect(out).toEqual(['1']);
	});

	it('keeps a private sub-reply when the forwarder was a party to it', () => {
		const msgs = [
			msg({ id: '1', from: 'a@x.com', to: ['me@x.com', 'b@x.com', 'c@x.com'] }),
			// Private between a and me — the forwarder was on it, so it's theirs to forward.
			msg({ id: '2', from: 'a@x.com', to: ['me@x.com'] })
		];
		const parts = threadParticipants(msgs);
		const out = forwardableMessages(msgs, parts, self).map((m) => m.id);
		expect(out).toEqual(['1', '2']);
	});
});

