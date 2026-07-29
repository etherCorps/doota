// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  blocksToMjml,
  compileTemplate,
  extractVariables,
  variablesSchemaJson,
  type BlockDoc,
} from "$lib/server/mjml.js";

const doc: BlockDoc = {
  blocks: [
    { id: "1", type: "heading", text: "Hi {{ name }}", level: 1 },
    { id: "2", type: "text", text: "Your code is {{ code }}." },
    { id: "3", type: "button", text: "Open", href: "https://x/{{ token }}" },
    { id: "4", type: "divider" },
    { id: "5", type: "spacer", height: 24 },
  ],
};

describe("mjml serializer + MRML compile", () => {
  it("serializes blocks to MJML (one section per block)", () => {
    const mjml = blocksToMjml(doc);
    expect(mjml.startsWith("<mjml><mj-body>")).toBe(true);
    expect(mjml).toContain("<mj-text");
    expect(mjml).toContain("<mj-button");
    expect(mjml).toContain("<mj-divider />");
    expect((mjml.match(/<mj-section>/g) ?? []).length).toBe(5);
  });

  it("compiles to responsive HTML and preserves merge tags", () => {
    const out = compileTemplate(doc, "Hello {{ name }}");
    expect(out.html).toContain("<!doctype html>");
    expect(out.html).toContain("Open"); // button label rendered
    expect(out.html).toContain("{{ name }}"); // merge tag survives compile
    expect(out.html).toContain("{{ code }}");
    expect(out.html).toContain("{{ token }}");
  });

  it("escapes HTML in text blocks but keeps merge braces", () => {
    const evil: BlockDoc = { blocks: [{ id: "1", type: "text", text: "<script>alert(1)</script> {{ ok }}" }] };
    const mjml = blocksToMjml(evil);
    expect(mjml).not.toContain("<script>");
    expect(mjml).toContain("&lt;script&gt;");
    expect(mjml).toContain("{{ ok }}");
  });

  it("extracts distinct variable names across fields + subject", () => {
    const vars = extractVariables(doc, "Hello {{ name }} {{ order.id }}");
    expect(vars.sort()).toEqual(["code", "name", "order", "token"]);
  });

  it("builds a variables schema flagging sensitive vars", () => {
    const json = JSON.parse(variablesSchemaJson(["name", "otp"], ["otp"]));
    expect(json.name).toEqual({});
    expect(json.otp).toEqual({ sensitive: true });
  });

  it("passes raw-HTML blocks through mj-raw", () => {
    const out = compileTemplate({ blocks: [{ id: "1", type: "html", html: "<b>bold</b>" }] });
    expect(out.html).toContain("<b>bold</b>");
  });
});
