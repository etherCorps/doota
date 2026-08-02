// SPDX-License-Identifier: Apache-2.0
// Split text into hit/non-hit segments for search-match bolding. Segment render
// (no {@html}) so a query term can never inject markup.

export type HlSegment = { text: string; hit: boolean };

export function highlightSegments(text: string | null | undefined, terms: string[]): HlSegment[] {
	if (!text) return [];
	const esc = terms.filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (!esc.length) return [{ text, hit: false }];
	const re = new RegExp(`(${esc.join("|")})`, "gi");
	const out: HlSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(re)) {
		if (match.index > last) out.push({ text: text.slice(last, match.index), hit: false });
		out.push({ text: match[0], hit: true });
		last = match.index + match[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last), hit: false });
	return out;
}
