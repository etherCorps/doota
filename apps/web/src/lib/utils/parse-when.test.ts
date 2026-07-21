import { describe, expect, it } from "vitest";
import { parseWhen } from "./parse-when";

// Anchor: Wednesday 2026-07-22, 18:00 local.
const NOW = new Date(2026, 6, 22, 18, 0, 0);
const at = (r: Date | null) =>
  r && `${r.getFullYear()}-${r.getMonth() + 1}-${r.getDate()} ${r.getHours()}:${String(r.getMinutes()).padStart(2, "0")}`;

describe("parseWhen", () => {
  it("returns null for junk / empty", () => {
    expect(parseWhen("", NOW)).toBeNull();
    expect(parseWhen("asdfgh", NOW)).toBeNull();
  });

  it("tomorrow defaults to 9am", () => {
    expect(at(parseWhen("tomorrow", NOW))).toBe("2026-7-23 9:00");
  });

  it("combines day + time", () => {
    expect(at(parseWhen("tomorrow 5pm", NOW))).toBe("2026-7-23 17:00");
    expect(at(parseWhen("fri 9:30am", NOW))).toBe("2026-7-24 9:30");
  });

  it("tonight = today 6pm", () => {
    expect(at(parseWhen("tonight", NOW))).toBe("2026-7-22 18:00");
  });

  it("bare past time rolls to tomorrow", () => {
    // 5pm already passed at 6pm → next day.
    expect(at(parseWhen("5pm", NOW))).toBe("2026-7-23 17:00");
  });

  it("weekday picks nearest future, next adds a week", () => {
    expect(at(parseWhen("monday 8am", NOW))).toBe("2026-7-27 8:00");
    expect(at(parseWhen("next monday 8am", NOW))).toBe("2026-8-3 8:00");
  });

  it("relative offsets", () => {
    expect(at(parseWhen("in 2 hours", NOW))).toBe("2026-7-22 20:00");
    expect(at(parseWhen("in 3 days", NOW))).toBe("2026-7-25 18:00");
  });
});
