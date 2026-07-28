// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseWhen } from "$lib/utils/parse-when";

// Fixed anchor: Tue 28 Jul 2026, 10:30 local. Assertions use deltas from this,
// so they're timezone-independent.
const NOW = new Date(2026, 6, 28, 10, 30, 15);
const when = (s: string) => parseWhen(s, NOW);
const dayDelta = (d: Date) =>
  Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
    new Date(2026, 6, 28).getTime()) / 86_400_000);

describe("parseWhen — relative offsets", () => {
  it("in N units (existing)", () => {
    expect(when("in 2 hours")!.getTime()).toBe(new Date(2026, 6, 28, 12, 30, 0).getTime());
    expect(dayDelta(when("in 3 days")!)).toBe(3);
  });
  it("N units from now / later / bare", () => {
    expect(dayDelta(when("2 days from now")!)).toBe(2);
    expect(dayDelta(when("3 weeks later")!)).toBe(21);
    expect(dayDelta(when("2 days")!)).toBe(2);
    expect(when("2 days from now")!.getHours()).toBe(10); // time carried, not 9am
  });
});

describe("parseWhen — named days", () => {
  it("day after tomorrow → +2 at 9am (not +1)", () => {
    const d = when("day after tomorrow")!;
    expect(dayDelta(d)).toBe(2);
    expect(d.getHours()).toBe(9);
  });
  it("tomorrow still +1", () => {
    expect(dayDelta(when("tomorrow")!)).toBe(1);
  });
  it("next week → next Monday 9am", () => {
    const d = when("next week")!;
    expect(d.getDay()).toBe(1);
    expect(dayDelta(d)).toBeGreaterThan(0);
    expect(d.getHours()).toBe(9);
  });
  it("this weekend → coming Saturday 9am", () => {
    const d = when("this weekend")!;
    expect(d.getDay()).toBe(6);
    expect(d.getHours()).toBe(9);
  });
  it("tomorrow 5pm keeps the explicit time", () => {
    const d = when("tomorrow 5pm")!;
    expect(dayDelta(d)).toBe(1);
    expect(d.getHours()).toBe(17);
  });
  it("garbage → null", () => {
    expect(when("asdfjkl")).toBeNull();
    expect(when("")).toBeNull();
  });
});
