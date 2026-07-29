// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { Engine } from "mrml";
import { tiptapToMjml, tiptapVariables, type TiptapDoc, type TiptapNode } from "$lib/mjml/tiptap-mjml.js";

const engine = new Engine();
function compile(mjml: string) {
  const out = engine.toHtml(mjml) as { type: string; content?: string };
  if (out.type !== "success" || !out.content) throw new Error("compile failed");
  return out.content;
}

const doc: TiptapDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hi {{ name }}" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "bold" }] },
        { type: "text", text: " " },
        { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x/{{ t }}" } }] },
      ],
    },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ],
    },
    { type: "horizontalRule" },
  ],
};

describe("tiptap → mjml", () => {
  it("serializes headings, marks, lists, rules into MJML that compiles", () => {
    const mjml = tiptapToMjml(doc);
    expect(mjml).toContain("<mj-divider />");
    expect(mjml).toContain("<strong>world</strong>");
    expect(mjml).toContain('<a href="https://x/{{ t }}">link</a>');
    const html = compile(mjml);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Hi {{ name }}"); // merge tag survives
    expect(html).toContain("world");
    expect(html).toContain("one");
    expect(html).toContain("two");
  });

  it("serializes text color + font-size (textStyle mark) as an inline span", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "big red", marks: [{ type: "textStyle", attrs: { color: "#ff0000", fontSize: "24px" } }] }],
        },
      ],
    };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain("color:#ff0000");
    expect(mjml).toContain("font-size:24px");
    expect(compile(mjml)).toContain("big red");
  });

  it("escapes HTML in text but keeps merge braces", () => {
    const evil: TiptapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<script> {{ ok }}" }] }] };
    const mjml = tiptapToMjml(evil);
    expect(mjml).not.toContain("<script>");
    expect(mjml).toContain("&lt;script&gt;");
    expect(mjml).toContain("{{ ok }}");
  });

  it("applies page settings (bg, width, preview)", () => {
    const mjml = tiptapToMjml({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }, { background: "#f4f4f4", width: 640, preview: "peek" });
    expect(mjml).toContain('background-color="#f4f4f4"');
    expect(mjml).toContain('width="640px"');
    expect(mjml).toContain("<mj-preview>peek</mj-preview>");
  });

  it("serializes container styles (bg, padding, border, radius) onto mj-section", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [
        { type: "button", attrs: { text: "Go", href: "https://x", align: "center", bg: "#eef2ff", pad: 32, borderWidth: 2, borderColor: "#4338ca", radius: 12 } },
      ],
    };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain('background-color="#eef2ff"');
    expect(mjml).toContain('padding="32px"');
    expect(mjml).toContain('border="2px solid #4338ca"');
    expect(mjml).toContain('border-radius="12px"');
    expect(compile(mjml)).toContain("Go");
  });

  it("extracts merge variables from the doc + subject", () => {
    expect(tiptapVariables(doc, "Re: {{ order.id }}").sort()).toEqual(["name", "order", "t"]);
  });

  it("serializes custom nodes (button, image, spacer, html, hero, social)", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [
        { type: "button", attrs: { text: "Go", href: "https://x/{{ t }}", align: "center" } },
        { type: "emImage", attrs: { src: "https://img/a.png", alt: "pic" } },
        { type: "spacer", attrs: { height: 40 } },
        { type: "htmlBlock", attrs: { html: "<b>raw</b>" } },
        { type: "hero", attrs: { src: "https://img/bg.jpg", heading: "Welcome", buttonText: "Join", buttonHref: "https://j" } },
        { type: "social", attrs: { items: [{ network: "github", href: "https://gh" }] } },
      ],
    };
    const html = compile(tiptapToMjml(d));
    expect(html).toContain("Go");
    expect(html).toContain("{{ t }}"); // button href merge tag survives
    expect(html).toContain("https://img/a.png");
    expect(html).toContain("<b>raw</b>");
    expect(html).toContain("Welcome");
    expect(html).toContain("Join");
  });

  it("serializes button styling (fill, size, radius, full-width) as mj-button attrs", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [{ type: "button", attrs: { text: "Go", href: "https://x", btnBg: "#16a34a", btnColor: "#f0fdf4", size: "lg", btnRadius: 20, fullWidth: true } }],
    };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain('background-color="#16a34a"');
    expect(mjml).toContain('color="#f0fdf4"');
    expect(mjml).toContain('border-radius="20px"');
    expect(mjml).toContain('font-size="16px"'); // lg
    expect(mjml).toContain('width="100%"'); // full-width
    expect(compile(mjml)).toContain("Go");
  });

  it("serializes image width + alignment onto mj-image", () => {
    const d: TiptapDoc = { type: "doc", content: [{ type: "emImage", attrs: { src: "https://img/a.png", width: 240, align: "left" } }] };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain('width="240px"');
    expect(mjml).toContain('align="left"');
    expect(compile(mjml)).toContain("https://img/a.png");
  });

  it("serializes a three-column layout", () => {
    const col = (t: string): TiptapNode => ({ type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
    const d: TiptapDoc = { type: "doc", content: [{ type: "columns", content: [col("A"), col("B"), col("C")] }] };
    const mjml = tiptapToMjml(d);
    expect((mjml.match(/<mj-column>/g) ?? []).length).toBe(3);
    const html = compile(mjml);
    for (const t of ["A", "B", "C"]) expect(html).toContain(t);
  });

  it("serializes a footer with an unsubscribe link + surviving merge tags", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [{ type: "footer", attrs: { text: "© {{ year }} Acme", unsubscribeLabel: "Opt out", unsubscribeUrl: "{{ unsubscribe_url }}" } }],
    };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain('<a href="{{ unsubscribe_url }}"');
    expect(mjml).toContain("Opt out");
    const html = compile(mjml);
    expect(html).toContain("{{ year }}");
    expect(html).toContain("{{ unsubscribe_url }}");
  });

  it("applies theme typography defaults to paragraph + heading", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] },
        { type: "paragraph", content: [{ type: "text", text: "body" }] },
      ],
    };
    const mjml = tiptapToMjml(d, {
      theme: { text: { color: "#334155", size: 16, lineHeight: 1.7 }, title: { color: "#0f172a", size: 34, weight: 800 } },
    });
    // paragraph picks up theme.text
    expect(mjml).toContain('color="#334155"');
    expect(mjml).toContain('font-size="16px"');
    expect(mjml).toContain('line-height="1.7"');
    // h1 picks up theme.title (overrides default 28px/700)
    expect(mjml).toContain('font-size="34px"');
    expect(mjml).toContain('font-weight="800"');
    expect(mjml).toContain('color="#0f172a"');
    expect(compile(mjml)).toContain("body");
  });

  it("serializes hero text color + height", () => {
    const d: TiptapDoc = { type: "doc", content: [{ type: "hero", attrs: { heading: "Hi", textColor: "#111827", height: 420 } }] };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain('height="420px"');
    expect(mjml).toContain('color="#111827"');
    expect(compile(mjml)).toContain("Hi");
  });

  it("serializes a variable pill inline + a two-column layout", () => {
    const d: TiptapDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "variable", attrs: { name: "name" } }] },
        {
          type: "columns",
          content: [
            { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "Left" }] }] },
            { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "Right" }] }] },
          ],
        },
      ],
    };
    const mjml = tiptapToMjml(d);
    expect(mjml).toContain("{{ name }}"); // variable pill → merge tag
    // The columns node emits two adjacent mj-columns in one section.
    expect(mjml).toContain(
      "<mj-column><mj-text>Left</mj-text></mj-column><mj-column><mj-text>Right</mj-text></mj-column>",
    );
    const html = compile(mjml);
    expect(html).toContain("Left");
    expect(html).toContain("Right");
    expect(tiptapVariables(d).sort()).toEqual(["name"]);
  });
});
