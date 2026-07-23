import { beforeEach, describe, expect, it } from "vitest";
import { mirrorDraft, readMirror, clearMirror } from "$lib/client/local-draft";

// Minimal localStorage for node — the module only uses these four members.
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("local draft mirror", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeStorage();
  });

  it("round-trips and clears", () => {
    mirrorDraft("reply:t1", { body: "<p>hi</p>" });
    expect(readMirror("reply:t1")?.body).toBe("<p>hi</p>");
    clearMirror("reply:t1");
    expect(readMirror("reply:t1")).toBeNull();
  });

  it("expires old mirrors on read", () => {
    mirrorDraft("new", { body: "old" });
    const raw = JSON.parse(localStorage.getItem("doota:draft:new")!);
    raw.at = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem("doota:draft:new", JSON.stringify(raw));
    expect(readMirror("new")).toBeNull();
  });

  it("survives corrupt entries", () => {
    localStorage.setItem("doota:draft:bad", "{nope");
    expect(readMirror("bad")).toBeNull();
  });
});
