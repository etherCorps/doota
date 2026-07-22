import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { svgProblem } from "$lib/server/bimi/validate";

/** The upload validator is a security boundary (we serve the SVG from our origin). */

const OK = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" baseProfile="tiny-ps" version="1.2" viewBox="0 0 64 64">
  <title>Acme</title>
  <circle cx="32" cy="32" r="30" fill="#0e7ae6"/>
</svg>`;

describe("BIMI svgProblem", () => {
  it("accepts a minimal Tiny-PS logo (xmlns http URL is fine)", () => {
    expect(svgProblem(OK)).toBeNull();
  });

  it("accepts the shipped Doota BIMI asset", () => {
    const svg = readFileSync(new URL("../../../landing/static/bimi.svg", import.meta.url), "utf8");
    expect(svgProblem(svg)).toBeNull();
    expect(svg.length).toBeLessThan(32 * 1024);
  });

  it("rejects non-SVG, missing tiny-ps profile, missing title", () => {
    expect(svgProblem("hello")).toMatch(/Not an SVG/);
    expect(svgProblem(OK.replace(' baseProfile="tiny-ps"', ""))).toMatch(/tiny-ps/);
    expect(svgProblem(OK.replace("<title>Acme</title>", ""))).toMatch(/<title>/);
  });

  it("rejects active/external content", () => {
    const inject = (s: string) => OK.replace("</svg>", `${s}</svg>`);
    expect(svgProblem(inject("<script>alert(1)</script>"))).toMatch(/Scripts/);
    expect(svgProblem(inject('<a href="https://evil.example">x</a>'))).toMatch(/External/);
    expect(svgProblem(inject('<rect style="fill:url(https://evil.example/f)"/>'))).toMatch(/External/);
    expect(svgProblem(inject('<image href="#x"/>'))).toMatch(/images/);
    expect(svgProblem(inject("<foreignObject/>"))).toMatch(/foreignObject/);
    expect(svgProblem(OK.replace("<circle", '<circle onload="alert(1)"'))).toMatch(/Event handler/);
    expect(svgProblem(OK.replace("<circle", '<circle href="javascript:x"'))).toMatch(/javascript:|External/);
  });
});
