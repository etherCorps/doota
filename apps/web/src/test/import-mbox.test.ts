// SPDX-License-Identifier: Apache-2.0
// mbox parsing is where import goes quietly wrong: a missed separator merges
// two messages, an over-eager one splits a body mid-attachment, and a botched
// unescape corrupts every line that happens to start with "From ". These are
// byte-level and cheap to test, so they are tested.
import { describe, it, expect } from "vitest";
import { nextSeparator, unescapeMboxBody, PART_PLAINTEXT_BYTES } from "@doota/mail-core/import";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (view: Uint8Array) => new TextDecoder().decode(view);

describe("mbox separators", () => {
  it("finds a separator only at a line start", () => {
    const mbox = bytes("From a@b Mon\r\nSubject: one\r\n\r\nbody\nFrom c@d Tue\r\nSubject: two\r\n");
    // The second message begins right after the newline that ends "body".
    const at = nextSeparator(mbox, 1);
    expect(at).toBeGreaterThan(0);
    expect(text(mbox.subarray(at)).startsWith("From c@d")).toBe(true);
  });

  it("does not split on 'From ' mid-line", () => {
    // A body mentioning "…mail From someone" must not look like a separator.
    const mbox = bytes("From a@b Mon\r\n\r\nforwarded From someone else\r\n");
    expect(nextSeparator(mbox, 1)).toBe(-1);
  });

  it("does not split on an escaped body line", () => {
    // ">From " is the escaped form — it is body text, not a new message.
    const mbox = bytes("From a@b Mon\r\n\r\n>From the desk of\r\n");
    expect(nextSeparator(mbox, 1)).toBe(-1);
  });

  it("returns -1 for a single message", () => {
    expect(nextSeparator(bytes("From a@b\r\nSubject: only\r\n"), 1)).toBe(-1);
  });
});

describe("mbox body unescaping", () => {
  it("drops exactly one '>' from an escaped From line", () => {
    expect(text(unescapeMboxBody(bytes("hi\n>From the desk\n")))).toBe("hi\nFrom the desk\n");
  });

  it("preserves the nesting depth of a quoted quote", () => {
    // ">>From " came from a real ">From " in the original — one level comes off.
    expect(text(unescapeMboxBody(bytes("hi\n>>From x\n")))).toBe("hi\n>From x\n");
  });

  it("leaves ordinary quoted lines alone", () => {
    const original = "hi\n> quoted reply\n>> deeper\n";
    expect(text(unescapeMboxBody(bytes(original)))).toBe(original);
  });

  it("leaves a bare 'From ' body line alone", () => {
    // Unescaped in the source, so there is nothing to strip.
    const original = "hi\nFrom here on\n";
    expect(text(unescapeMboxBody(bytes(original)))).toBe(original);
  });

  it("is byte-exact on content with no escaping", () => {
    // Attachments ride through this path; a stray mutation corrupts them.
    const payload = "MIME-Version: 1.0\r\n\r\nAAECAwQFBgcICQ==\r\n";
    expect(text(unescapeMboxBody(bytes(payload)))).toBe(payload);
  });
});

describe("cursor arithmetic", () => {
  it("maps a byte offset to a part index by division", () => {
    // The whole reason parts are fixed-size *plaintext*: the resumable cursor
    // stays a plain integer instead of needing a part/offset pair.
    expect(Math.floor(0 / PART_PLAINTEXT_BYTES)).toBe(0);
    expect(Math.floor((PART_PLAINTEXT_BYTES - 1) / PART_PLAINTEXT_BYTES)).toBe(0);
    expect(Math.floor(PART_PLAINTEXT_BYTES / PART_PLAINTEXT_BYTES)).toBe(1);
    expect(Math.floor((PART_PLAINTEXT_BYTES * 3 + 17) / PART_PLAINTEXT_BYTES)).toBe(3);
  });
});
