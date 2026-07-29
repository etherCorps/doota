// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { Engine } from "mrml";
import {
  blocksToMjml,
  extractVariables,
  variablesSchemaJson,
  type BlockDoc,
} from "$lib/mjml/blocks.js";

// The builder compiles in the browser (mrml/web); here we drive the same MRML
// core via its nodejs build to prove the serializer emits valid, tag-preserving
// MJML — the compile step itself is engine-identical across targets.
const engine = new Engine();
function compile(doc: BlockDoc) {
  const out = engine.toHtml(blocksToMjml(doc)) as { type: string; content?: string };
  if (out.type !== "success" || !out.content) throw new Error("compile failed");
  return out.content;
}

const doc: BlockDoc = {
  blocks: [
    { id: "1", type: "heading", text: "Hi {{ name }}", level: 1 },
    { id: "2", type: "text", text: "Your code is {{ code }}." },
    { id: "3", type: "button", text: "Open", href: "https://x/{{ token }}" },
    { id: "4", type: "divider" },
    { id: "5", type: "spacer", height: 24 },
  ],
};

describe("mjml serializer (+ MRML compile)", () => {
  it("serializes blocks to MJML (one section per block)", () => {
    const mjml = blocksToMjml(doc);
    expect(mjml.startsWith("<mjml><mj-body>")).toBe(true);
    expect(mjml).toContain("<mj-button");
    expect(mjml).toContain("<mj-divider />");
    expect((mjml.match(/<mj-section>/g) ?? []).length).toBe(5);
  });

  it("compiles to responsive HTML and preserves merge tags", () => {
    const html = compile(doc);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Open"); // button label
    expect(html).toContain("{{ name }}"); // merge tags survive compile
    expect(html).toContain("{{ code }}");
    expect(html).toContain("{{ token }}");
  });

  it("escapes HTML in text blocks but keeps merge braces", () => {
    const evil: BlockDoc = { blocks: [{ id: "1", type: "text", text: "<script>alert(1)</script> {{ ok }}" }] };
    const mjml = blocksToMjml(evil);
    expect(mjml).not.toContain("<script>");
    expect(mjml).toContain("&lt;script&gt;");
    expect(mjml).toContain("{{ ok }}");
  });

  it("extracts distinct variable names across fields + subject", () => {
    expect(extractVariables(doc, "Hello {{ name }} {{ order.id }}").sort()).toEqual([
      "code",
      "name",
      "order",
      "token",
    ]);
  });

  it("builds a variables schema flagging sensitive vars", () => {
    const json = JSON.parse(variablesSchemaJson(["name", "otp"], ["otp"]));
    expect(json.name).toEqual({});
    expect(json.otp).toEqual({ sensitive: true });
  });

  it("passes raw-HTML blocks through mj-raw", () => {
    expect(compile({ blocks: [{ id: "1", type: "html", html: "<b>bold</b>" }] })).toContain("<b>bold</b>");
  });

  it("compiles a two-column block into two columns", () => {
    const mjml = blocksToMjml({ blocks: [{ id: "1", type: "columns", left: "L {{ a }}", right: "R {{ b }}" }] });
    expect((mjml.match(/<mj-column>/g) ?? []).length).toBe(2);
    const html = compile({ blocks: [{ id: "1", type: "columns", left: "Left", right: "Right" }] });
    expect(html).toContain("Left");
    expect(html).toContain("Right");
  });

  it("compiles list, quote and social blocks", () => {
    const list = compile({ blocks: [{ id: "1", type: "list", items: ["one", "two"], ordered: false }] });
    expect(list).toContain("one");
    expect(list).toContain("two");

    const quote = compile({ blocks: [{ id: "1", type: "quote", text: "Wise {{ w }}" }] });
    expect(quote).toContain("blockquote");
    expect(quote).toContain("{{ w }}");

    const social = compile({
      blocks: [{ id: "1", type: "social", items: [{ network: "github", href: "https://gh/{{ u }}" }] }],
    });
    expect(social).toContain("{{ u }}"); // merge tag in href survives
  });

  it("compiles a hero block with background image + button", () => {
    const mjml = blocksToMjml({
      blocks: [{ id: "1", type: "hero", src: "https://img/bg.jpg", heading: "Big {{ h }}", text: "sub", buttonText: "Go", buttonHref: "https://x" }],
    });
    expect(mjml).toContain("mj-hero");
    expect(mjml).toContain('background-url="https://img/bg.jpg"');
    const html = compile({
      blocks: [{ id: "1", type: "hero", src: "https://img/bg.jpg", heading: "Welcome", buttonText: "Go", buttonHref: "https://x" }],
    });
    expect(html).toContain("Welcome");
    expect(html).toContain("Go");
  });

  it("emits per-element custom CSS as a class rule + css-class attribute", () => {
    const mjml = blocksToMjml({
      blocks: [
        { id: "abc-1", type: "text", text: "hi", css: "color: red;" },
        { id: "no-css", type: "text", text: "plain" },
      ],
    });
    expect(mjml).toContain('css-class="babc-1"');
    expect(mjml).toContain(".babc-1{color: red;}");
    // block without css gets no class
    expect(mjml).not.toContain('css-class="bno-css"');
  });

  it("applies body background + custom CSS from settings", () => {
    const mjml = blocksToMjml({
      blocks: [{ id: "1", type: "text", text: "hi" }],
      settings: { bodyBackground: "#f4f4f4", css: ".x{color:red}" },
    });
    expect(mjml).toContain('<mj-body background-color="#f4f4f4">');
    expect(mjml).toContain("<mj-style>.x{color:red}</mj-style>");
    // </style> breakout is stripped
    const mjml2 = blocksToMjml({ blocks: [{ id: "1", type: "text", text: "hi" }], settings: { css: "a{}</style><b>" } });
    expect(mjml2).not.toContain("</style><b>");
  });

  it("extracts variables from composite block fields", () => {
    const vars = extractVariables({
      blocks: [
        { id: "1", type: "columns", left: "{{ a }}", right: "{{ b }}" },
        { id: "2", type: "list", items: ["{{ c }}", "plain"] },
        { id: "3", type: "social", items: [{ network: "x", href: "https://x/{{ d }}" }] },
      ],
    });
    expect(vars.sort()).toEqual(["a", "b", "c", "d"]);
  });
});
