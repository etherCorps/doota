// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { relTime } from "$lib/utils/reltime";

// Fixed reference: 2026-06-15 12:00 local.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("relTime", () => {
	it("blank for null", () => {
		expect(relTime(null, NOW)).toBe("");
	});
	it("'now' under a minute", () => {
		expect(relTime(NOW - 30_000, NOW)).toBe("now");
	});
	it("minutes under an hour", () => {
		expect(relTime(NOW - 5 * MIN, NOW)).toBe("5m");
		expect(relTime(NOW - 59 * MIN, NOW)).toBe("59m");
	});
	it("clock time later the same day (not 'now'/minutes)", () => {
		const s = relTime(NOW - 3 * HOUR, NOW);
		expect(s).not.toBe("now");
		expect(s).not.toMatch(/^\d+m$/);
		expect(s).not.toBe("Yesterday");
	});
	it("'Yesterday' for the previous calendar day", () => {
		expect(relTime(new Date(2026, 5, 14, 9, 0, 0).getTime(), NOW)).toBe("Yesterday");
	});
	it("weekday within the past week", () => {
		// 3 days back — not today/yesterday, not a full month/day date.
		const s = relTime(NOW - 3 * DAY, NOW);
		expect(s).not.toBe("Yesterday");
		expect(s.length).toBeLessThanOrEqual(4); // "Wed" etc.
	});
	it("dated for older; includes year across years", () => {
		expect(relTime(new Date(2026, 0, 1, 9, 0, 0).getTime(), NOW)).not.toBe("Yesterday");
		expect(relTime(new Date(2024, 0, 1).getTime(), NOW)).toMatch(/2024/);
	});
});
