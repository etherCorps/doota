// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { withSignature, swapSignature, splitSignatureHtml, SIG_DELIMITER_HTML } from "$lib/mail/signature";
import { signatureSuffix, splitAtSigDelimiter, extractContactFields } from "@doota/mail-core/signature-detect";

const D = SIG_DELIMITER_HTML;

describe("withSignature", () => {
  const sig = "<p>Alice — Acme</p>";
  it("appends to a non-empty body with a spacer AND the -- delimiter", () => {
    expect(withSignature("<p>Hi there</p>", sig)).toBe(`<p>Hi there</p><p></p>${D}${sig}`);
  });
  it("puts a blank line above the signature for an empty body (caret sits on top)", () => {
    expect(withSignature("", sig)).toBe(`<p></p>${D}${sig}`);
    expect(withSignature("   ", sig)).toBe(`<p></p>${D}${sig}`);
  });
  it("no signature → body unchanged", () => {
    expect(withSignature("<p>Hi</p>", "")).toBe("<p>Hi</p>");
    expect(withSignature("<p>Hi</p>", "   ")).toBe("<p>Hi</p>");
  });
});

describe("swapSignature", () => {
  const a = "<p>Alice — Acme</p>";
  const b = "<p>Bob — Beta</p>";

  it("swaps the trailing signature, keeping the user's text", () => {
    expect(swapSignature(`<p>Hi</p><p></p>${D}${a}`, a, b)).toBe(`<p>Hi</p><p></p>${D}${b}`);
  });
  it("swaps on an empty-body compose (blank line + signature)", () => {
    expect(swapSignature(`<p></p>${D}${a}`, a, b)).toBe(`<p></p>${D}${b}`);
  });
  it("switching to a mailbox with no signature removes it", () => {
    expect(swapSignature(`<p>Hi</p><p></p>${D}${a}`, a, "")).toBe("<p>Hi</p>");
  });
  it("switching from no-signature appends the new one", () => {
    expect(swapSignature("<p>Hi</p>", "", b)).toBe(`<p>Hi</p><p></p>${D}${b}`);
  });
  it("identical signature is a no-op (alias change on the same mailbox)", () => {
    expect(swapSignature(`<p>Hi</p><p></p>${D}${a}`, a, a)).toBe(`<p>Hi</p><p></p>${D}${a}`);
  });
  it("returns null when the applied signature was edited away (don't corrupt)", () => {
    expect(swapSignature("<p>Hi</p><p></p><p>edited sig</p>", a, b)).toBeNull();
  });
});

describe("splitSignatureHtml — render collapse boundary", () => {
  it("splits at our own delimiter paragraph", () => {
    const html = `<p>Hi</p><p></p>${D}<p>Alice — Acme</p>`;
    const split = splitSignatureHtml(html)!;
    expect(split.main).toBe("<p>Hi</p><p></p>");
    expect(split.signature).toContain("Alice — Acme");
  });
  it("splits at another client's `-- <br>` delimiter, using the LAST occurrence", () => {
    const html = `<div>quoting someone who wrote -- <br>their sig</div><div>-- <br>My Name<br>555-0100</div>`;
    const split = splitSignatureHtml(html)!;
    expect(split.signature).toContain("My Name");
  });
  it("no delimiter → null (body rendered as-is)", () => {
    expect(splitSignatureHtml("<p>Hi there</p>")).toBeNull();
  });
  it("delimiter with nothing after it → null", () => {
    expect(splitSignatureHtml(`<p>Hi</p>${D}`)).toBeNull();
  });
});

describe("signatureSuffix — longest common suffix across messages", () => {
  const sig = "Priya Sharma\nAcme Support\n+1 555 0100\nhttps://acme.com";
  it("finds the repeated trailing block after 3 messages", () => {
    const texts = [
      `Hello, your ticket is resolved.\n\n${sig}`,
      `Following up on the invoice.\n\nBest,\n${sig}`,
      `One more thing about the renewal date.\n${sig}`,
    ];
    const block = signatureSuffix(texts)!;
    expect(block.join("\n")).toContain("Priya Sharma");
    expect(block.join("\n")).toContain("+1 555 0100");
    // The varying body lines are NOT part of the suffix.
    expect(block.join("\n")).not.toContain("ticket");
  });
  it("needs 3+ samples", () => {
    expect(signatureSuffix([`a\n${sig}`, `b\n${sig}`])).toBeNull();
  });
  it("no repeated tail → null", () => {
    expect(signatureSuffix(["one\ntwo", "three\nfour", "five\nsix"])).toBeNull();
  });
});

describe("splitAtSigDelimiter (text)", () => {
  it("splits at `-- ` on its own line", () => {
    const split = splitAtSigDelimiter("body text\n-- \nAlice\n555-0100")!;
    expect(split.body).toBe("body text");
    expect(split.signature).toBe("Alice\n555-0100");
  });
  it("returns null without a delimiter", () => {
    expect(splitAtSigDelimiter("no delimiter here")).toBeNull();
  });
});

describe("extractContactFields — high-precision only", () => {
  it("extracts phone, url, email, handle; skips title/company", () => {
    const fields = extractContactFields([
      "Priya Sharma",
      "Head of Support, Acme Corp", // deliberately NOT extracted
      "+1 (555) 010-0199",
      "priya@acme.com · https://acme.com/support",
      "@priyasharma",
    ]);
    expect(fields.phones).toEqual(["+1 (555) 010-0199"]);
    expect(fields.emails).toEqual(["priya@acme.com"]);
    expect(fields.urls).toEqual(["https://acme.com/support"]);
    expect(fields.handles).toEqual(["@priyasharma"]);
  });
  it("kills date-like and short digit runs", () => {
    const fields = extractContactFields(["Sent 2026-08-04", "ref 12345"]);
    expect(fields.phones).toEqual([]);
  });
});
