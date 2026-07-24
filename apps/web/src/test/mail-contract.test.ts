// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  normalizeSubject,
  parseReferences,
  threadingHeaders,
  stripQuotesText,
  stripQuotesHtml,
  stripHtmlTags,
  deriveContentKind,
} from "@doota/mail-core/mail-thread-contract";
import { importKey, encryptContent, decryptContent } from "@doota/mail-core/crypto";
import { tokensFor } from "@doota/mail-core/search";
import { deriveRole, baseAddress } from "@doota/mail-core/queue-consumer";

const KEY_B64 = btoa("0123456789abcdef0123456789abcdef"); // 32 bytes

describe("threading helpers", () => {
  it("strips Re/Fwd prefixes and lowercases", () => {
    expect(normalizeSubject("Re: Fwd: Hello There")).toBe("hello there");
    expect(normalizeSubject("RE: RE: ping")).toBe("ping");
    expect(normalizeSubject(null)).toBe("");
  });

  it("parses and de-dupes references", () => {
    expect(parseReferences("<a@x> <b@x> <a@x>")).toEqual(["<a@x>", "<b@x>"]);
    expect(parseReferences(null)).toEqual([]);
  });

  it("builds In-Reply-To + References from the parent chain", () => {
    const h = threadingHeaders({ messageIdHeader: "<p@x>", references: "<r1@x> <r2@x>" });
    expect(h["In-Reply-To"]).toBe("<p@x>");
    expect(h.References).toBe("<r1@x> <r2@x> <p@x>");
    expect(threadingHeaders(null)).toEqual({});
  });

  it("caps References under the provider's 2KB header limit, keeping root + tail", () => {
    const refs = Array.from({ length: 80 }, (_, i) => `<ancestor-${i}-padpadpadpadpadpad@x>`).join(" ");
    const h = threadingHeaders({ messageIdHeader: "<p@x>", references: refs });
    expect(h.References!.length).toBeLessThanOrEqual(1900);
    expect(h.References!.startsWith("<ancestor-0-")).toBe(true); // root kept
    expect(h.References!.endsWith("<p@x>")).toBe(true); // parent kept
  });
});

describe("quote stripping", () => {
  it("cuts at attribution / quote marker", () => {
    const body = "My reply here.\n\nOn Mon, X wrote:\n> old stuff\n> more";
    expect(stripQuotesText(body)).toBe("My reply here.");
  });
  it("keeps body when nothing to strip", () => {
    expect(stripQuotesText("just a line")).toBe("just a line");
  });
  it("drops blockquotes and quote containers in html", () => {
    expect(stripQuotesHtml("<p>hi</p><blockquote>old</blockquote>")).toBe("<p>hi</p>");
  });
  it("strips tags to plain text", () => {
    expect(stripHtmlTags("<p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
  });
});

describe("content kind", () => {
  it("short text with no attachments = bubble", () => {
    expect(deriveContentKind({ strippedText: "hey there", hasAttachments: false, htmlLength: 0 })).toBe("bubble");
  });
  it("attachments force a card", () => {
    expect(deriveContentKind({ strippedText: "hi", hasAttachments: true, htmlLength: 0 })).toBe("card");
  });
  it("long / rich html = card", () => {
    expect(deriveContentKind({ strippedText: "x".repeat(900), hasAttachments: false, htmlLength: 0 })).toBe("card");
    expect(deriveContentKind({ strippedText: "hi", hasAttachments: false, htmlLength: 5000 })).toBe("card");
  });
});

describe("content encryption (crypto.ts)", () => {
  it("round-trips subject/body and returns null for empty", async () => {
    const ck = await importKey(KEY_B64);
    const env = await encryptContent(ck, "secret subject");
    expect(env).toMatch(/^v1\.0\./);
    expect(await decryptContent(ck, env)).toBe("secret subject");
    expect(await encryptContent(ck, "")).toBeNull();
    expect(await decryptContent(ck, null)).toBeNull();
  });
  it("rejects a tampered envelope", async () => {
    const ck = await importKey(KEY_B64);
    const env = (await encryptContent(ck, "hi"))!;
    const tampered = env.slice(0, -2) + (env.endsWith("AA") ? "BB" : "AA");
    await expect(decryptContent(ck, tampered)).rejects.toBeTruthy();
  });
});

describe("blind search tokens", () => {
  it("are deterministic and hide the plaintext", async () => {
    const a = await tokensFor(KEY_B64, ["Hello world"]);
    const b = await tokensFor(KEY_B64, ["hello WORLD"]);
    expect(a.sort()).toEqual(b.sort()); // case-insensitive, same tokens
    expect(a.join(" ")).not.toContain("hello"); // opaque
    expect(a.every((t) => /^[0-9a-f]{16}$/.test(t))).toBe(true);
  });
});

describe("recipient role derivation", () => {
  const parsed = { to: [{ address: "a@acme.com" }], cc: [{ address: "b@acme.com" }] };
  it("classifies to/cc, and envelope-only recipient as bcc", () => {
    expect(deriveRole(parsed, "a@acme.com")).toBe("to");
    expect(deriveRole(parsed, "b@acme.com")).toBe("cc");
    expect(deriveRole(parsed, "hidden@acme.com")).toBe("bcc");
  });
  it("strips +tag to match header addresses", () => {
    expect(baseAddress("a+sales@acme.com", "sales")).toBe("a@acme.com");
    expect(baseAddress("a@acme.com", null)).toBe("a@acme.com");
  });
});
