// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseSearchQuery, parseDate, snippetAround } from "$lib/utils/search-query";
import { highlightSegments } from "$lib/utils/highlight";

describe("parseSearchQuery", () => {
  it("pulls operators out and leaves free text", () => {
    const r = parseSearchQuery("from:bob has:attachment invoice due");
    expect(r.from).toBe("bob");
    expect(r.hasAttachment).toBe(true);
    expect(r.text).toBe("invoice due");
  });

  it("maps is: aliases and read/unread", () => {
    expect(parseSearchQuery("is:starred").starred).toBe(true);
    expect(parseSearchQuery("is:important").starred).toBe(true);
    expect(parseSearchQuery("is:unread").unread).toBe(true);
    expect(parseSearchQuery("is:read").unread).toBe(false);
    expect(parseSearchQuery("hello").unread).toBeUndefined();
  });

  it("drops a bare operator mid-typing so it isn't searched as text", () => {
    expect(parseSearchQuery("from: report").text).toBe("report");
    expect(parseSearchQuery("report to:").text).toBe("report");
  });

  it("parses after/before dates (iso, slash, relative)", () => {
    expect(parseSearchQuery("after:2026-01-01").after).toBe(Date.parse("2026-01-01"));
    expect(parseSearchQuery("before:2026/02/01").before).toBe(Date.parse("2026-02-01"));
    const r = parseSearchQuery("after:7d");
    expect(r.after).toBeGreaterThan(Date.now() - 7 * 86_400_000 - 5000);
    expect(r.after).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 5000);
  });

  it("ignores an unparseable date", () => {
    expect(parseDate("notadate")).toBeUndefined();
  });
});

describe("snippetAround", () => {
  it("centers on the first match, not the head", () => {
    const body = "aaaa ".repeat(60) + "TARGET here " + "bbbb ".repeat(60);
    const s = snippetAround(body, ["target"], 80)!;
    expect(s.toLowerCase()).toContain("target");
    expect(s.startsWith("…")).toBe(true); // trimmed on the left, match wasn't at the head
  });

  it("falls back to the head when nothing matches", () => {
    expect(snippetAround("short body", ["zzz"], 80)).toBe("short body");
  });
});

describe("highlightSegments", () => {
  it("splits matches into hit segments, case-insensitive", () => {
    const segs = highlightSegments("Invoice INVOICE done", ["invoice"]);
    expect(segs.filter((segment) => segment.hit).map((segment) => segment.text)).toEqual(["Invoice", "INVOICE"]);
    expect(segs.map((segment) => segment.text).join("")).toBe("Invoice INVOICE done");
  });

  it("does not treat term text as regex (no injection)", () => {
    // A term with regex metachars must match literally, not blow up.
    const segs = highlightSegments("a.b a+b", ["a.b"]);
    expect(segs.some((segment) => segment.hit && segment.text === "a.b")).toBe(true);
  });
});
