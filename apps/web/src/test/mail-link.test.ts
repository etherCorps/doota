// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyMailLink } from "$lib/utils/mail-link";

describe("classifyMailLink (Part D)", () => {
  it("drops non-web schemes, routes mailto to the composer", () => {
    expect(classifyMailLink("javascript:alert(1)")).toEqual({ action: "drop" });
    expect(classifyMailLink("data:text/html,x")).toEqual({ action: "drop" });
    expect(classifyMailLink("file:///etc/passwd")).toEqual({ action: "drop" });
    expect(classifyMailLink("not a url")).toEqual({ action: "drop" });
    expect(classifyMailLink("mailto:a@b.com")).toEqual({ action: "mailto", address: "a@b.com" });
  });

  it("opens http/https without a warning when text and host agree", () => {
    const d = classifyMailLink("https://example.com/x", "example.com");
    expect(d).toMatchObject({ action: "open", warn: null });
  });

  it("warns when the display text claims a different domain (phishing shape)", () => {
    const d = classifyMailLink("https://evil.example/login", "paypal.com");
    expect(d.action).toBe("open");
    if (d.action === "open") expect(d.warn).toMatch(/paypal\.com.*evil\.example/);
  });

  it("warns on an IDN/punycode host that can imitate a real domain", () => {
    // xn--pple-43d.com is Cyrillic-а "аpple.com"
    const d = classifyMailLink("https://xn--pple-43d.com/");
    expect(d.action).toBe("open");
    if (d.action === "open") expect(d.warn).toMatch(/internationalized/i);
  });
});

// The sandbox footgun: allow-scripts + allow-same-origin lets a framed doc strip
// its own sandbox and escape. This "lint" fails if they ever co-occur.
describe("sandbox footgun guard", () => {
  it("no sandbox combines allow-scripts with allow-same-origin", () => {
    const frame = readFileSync(
      fileURLToPath(new URL("../lib/components/mail/mail-frame.svelte", import.meta.url)),
      "utf8",
    );
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).not.toMatch(/sandbox="[^"]*allow-scripts[^"]*allow-same-origin/);
    expect(frame).not.toMatch(/sandbox="[^"]*allow-same-origin[^"]*allow-scripts/);
  });
});
