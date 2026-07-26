// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "$lib/utils/filename";

const RLO = "‮"; // right-to-left override

describe("sanitizeFilename", () => {
  it("neutralizes a U+202E bidi-override spoof", () => {
    const spoof = `evil${RLO}gpj.exe`; // renders as "evilexe.jpg"
    const out = sanitizeFilename(spoof);
    expect(out).not.toContain(RLO);
    expect(out).toBe("evilgpj.exe"); // the override is gone, real name shows
  });

  it("strips path separators / traversal to a bare basename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a\\b\\c.pdf")).toBe("c.pdf");
    expect(sanitizeFilename("....//x")).toBe("x");
  });

  it("strips control chars and falls back when empty", () => {
    expect(sanitizeFilename("a\r\nb.txt")).toBe("ab.txt");
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename(null)).toBe("attachment");
    expect(sanitizeFilename("...")).toBe("attachment");
  });
});
