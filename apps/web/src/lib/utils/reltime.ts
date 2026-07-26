// SPDX-License-Identifier: Apache-2.0
// Conversation-list timestamp, Gmail/Superhuman style: recent → minutes, rest of
// today → clock time, then Yesterday, then weekday within a week, then a date
// (with year only when it differs). `now` is injectable for deterministic tests.

export function relTime(ms: number | null, now: number = Date.now()): string {
	if (!ms) return "";
	const diff = now - ms;
	if (diff >= 0 && diff < 60_000) return "now";
	if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;

	const d = new Date(ms);
	const n = new Date(now);
	if (d.toDateString() === n.toDateString()) {
		return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}
	const yesterday = new Date(n);
	yesterday.setDate(n.getDate() - 1);
	if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

	if (diff >= 0 && diff < 7 * 86_400_000) {
		return d.toLocaleDateString(undefined, { weekday: "short" });
	}
	const sameYear = d.getFullYear() === n.getFullYear();
	return d.toLocaleDateString(
		undefined,
		sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
	);
}
