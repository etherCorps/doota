// SPDX-License-Identifier: Apache-2.0
// Plain-text linkify: split a text body into text/link/email segments so both
// the in-app bubbles (Svelte render, no {@html}) and the sandboxed-iframe text
// fallback (server-built anchors) share ONE URL grammar.

export type LinkSegment =
	| { type: 'text'; value: string }
	| { type: 'link'; value: string; href: string }
	| { type: 'email'; value: string; address: string };

// URLs (http/https or bare www.) and email addresses, one alternation pass.
const TOKEN_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;

/** Trim trailing punctuation that's prose, not URL — keep a ')' only when the
 * match contains a matching '('. */
function trimTrailing(m: string): string {
	let out = m.replace(/[.,;:!?]+$/, '');
	while (out.endsWith(')') && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) {
		out = out.slice(0, -1);
	}
	return out;
}

export function linkifySegments(text: string): LinkSegment[] {
	const segs: LinkSegment[] = [];
	let last = 0;
	for (const m of text.matchAll(TOKEN_RE)) {
		const raw = trimTrailing(m[0]);
		if (!raw) continue;
		if (m.index > last) segs.push({ type: 'text', value: text.slice(last, m.index) });
		if (raw.includes('@') && !/^https?:\/\//i.test(raw)) {
			segs.push({ type: 'email', value: raw, address: raw });
		} else {
			segs.push({ type: 'link', value: raw, href: /^www\./i.test(raw) ? `https://${raw}` : raw });
		}
		last = m.index + raw.length;
	}
	if (last < text.length) segs.push({ type: 'text', value: text.slice(last) });
	return segs;
}
