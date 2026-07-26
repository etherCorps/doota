// SPDX-License-Identifier: Apache-2.0
// Split text into hit/non-hit segments for search-match bolding. Segment render
// (no {@html}) so a query term can never inject markup.

export type HlSegment = { text: string; hit: boolean };

export function highlightSegments(text: string | null | undefined, terms: string[]): HlSegment[] {
	if (!text) return [];
	const esc = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (!esc.length) return [{ text, hit: false }];
	const re = new RegExp(`(${esc.join("|")})`, "gi");
	const out: HlSegment[] = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
		out.push({ text: m[0], hit: true });
		last = m.index + m[0].length;
	}
	if (last < text.length) out.push({ text: text.slice(last), hit: false });
	return out;
}
