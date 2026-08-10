// SPDX-License-Identifier: Apache-2.0
// Pure query-string parsing + snippet shaping for mail search. Extracted from
// the remote module so it's unit-testable without the $app/server import.

export type ParsedSearch = {
	/** Free text left after operators are stripped — goes to blind-token FTS. */
	text: string;
	from?: string;
	to?: string;
	starred: boolean;
	hasAttachment: boolean;
	/** true = is:unread, false = is:read, undefined = no read filter. */
	unread?: boolean;
	after?: number;
	before?: number;
};

/** `after:`/`before:` value → epoch ms. YYYY-MM-DD, YYYY/MM/DD, or relative
 * `<n>d` (n days ago). Undefined when unparseable. */
export function parseDate(v: string): number | undefined {
	const rel = v.match(/^(\d+)d$/);
	if (rel) return Date.now() - Number(rel[1]) * 86_400_000;
	const t = Date.parse(v.replace(/\//g, "-"));
	return Number.isNaN(t) ? undefined : t;
}

/** Pull operators (`from:`/`to:`/`is:`/`has:`/`after:`/`before:`) out; whatever
 * remains is free-text FTS. A bare operator mid-typing ("from:") is dropped. */
export function parseSearchQuery(raw: string): ParsedSearch {
	let from: string | undefined;
	let to: string | undefined;
	let starred = false;
	let hasAttachment = false;
	let unread: boolean | undefined;
	let after: number | undefined;
	let before: number | undefined;
	const text = raw
		.replace(/(^|\s)(from|to|is|has|after|before):(\S+)/gi, (_m, pre: string, k: string, v: string) => {
			const val = v.toLowerCase();
			switch (k.toLowerCase()) {
				case "from": from = val; break;
				case "to": to = val; break;
				case "is":
					if (val === "starred" || val === "important" || val === "flagged") starred = true;
					else if (val === "unread") unread = true;
					else if (val === "read") unread = false;
					break;
				case "has":
					if (val === "attachment" || val === "attachments" || val === "file") hasAttachment = true;
					break;
				case "after": after = parseDate(val); break;
				case "before": before = parseDate(val); break;
			}
			return pre;
		})
		.replace(/(^|\s)(from|to|is|has|after|before):(?=\s|$)/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return { text, from, to, starred, hasAttachment, unread, after, before };
}

/** A snippet centered on the first query-term match in the body (Gmail/
 * Superhuman-style), not the body head, so a hit deep in a long mail still
 * shows relevant context. Falls back to the head when nothing matches (e.g.
 * the term was only in the subject). */
export function snippetAround(body: string | null, terms: string[], n = 160): string | null {
	if (!body) return null;
	const clean = body.replace(/\s+/g, " ").trim();
	if (!clean) return null;
	const head = () => (clean.length > n ? clean.slice(0, n) + "…" : clean);
	if (!terms.length) return head();
	const lower = clean.toLowerCase();
	let idx = -1;
	for (const t of terms) {
		const i = lower.indexOf(t);
		if (i !== -1 && (idx === -1 || i < idx)) idx = i;
	}
	if (idx === -1) return head();
	let end = Math.min(clean.length, idx + Math.ceil(n / 2));
	const start = Math.max(0, end - n);
	end = Math.min(clean.length, start + n);
	return (start > 0 ? "…" : "") + clean.slice(start, end).trim() + (end < clean.length ? "…" : "");
}
