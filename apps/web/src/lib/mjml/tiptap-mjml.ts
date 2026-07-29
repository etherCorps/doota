// SPDX-License-Identifier: Apache-2.0
/**
 * Serialize a Tiptap (ProseMirror) document → MJML, for the WYSIWYG template
 * editor (Resend-style). Pure + framework-free (runs in the browser + tests).
 * The MJML compiles to responsive HTML via MRML; Jinja `{{ }}` merge tags in the
 * text survive and render with un-jinja at send.
 *
 * Phase 1 nodes: paragraph, heading, bullet/ordered lists, horizontalRule, and
 * inline marks (bold, italic, strike, code, link). Custom email nodes (button,
 * image, columns, hero, social, html) land in later phases.
 */

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};
export type TiptapDoc = { type: "doc"; content?: TiptapNode[] };

export type PageSettings = {
  background?: string;
  width?: number;
  preview?: string;
  css?: string;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** Inline content (text + marks, hard breaks) → an HTML fragment for mj-text. */
function inline(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "<br />";
      // Inline variable pill → the raw Jinja merge tag (not escaped).
      if (n.type === "variable") return `{{ ${String(n.attrs?.name ?? "")} }}`;
      if (n.type !== "text" || n.text == null) return "";
      let h = esc(n.text);
      for (const m of n.marks ?? []) {
        switch (m.type) {
          case "bold":
            h = `<strong>${h}</strong>`;
            break;
          case "italic":
            h = `<em>${h}</em>`;
            break;
          case "strike":
            h = `<s>${h}</s>`;
            break;
          case "code":
            h = `<code>${h}</code>`;
            break;
          case "link":
            h = `<a href="${attr(String(m.attrs?.href ?? "#"))}">${h}</a>`;
            break;
          case "textStyle": {
            const s: string[] = [];
            if (m.attrs?.color) s.push(`color:${String(m.attrs.color)}`);
            if (m.attrs?.fontSize) s.push(`font-size:${String(m.attrs.fontSize)}`);
            if (s.length) h = `<span style="${attr(s.join(";"))}">${h}</span>`;
            break;
          }
        }
      }
      return h;
    })
    .join("");
}

/** List items → <li> markup (each item's paragraphs joined). */
function listItems(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .filter((n) => n.type === "listItem")
    .map((li) => `<li>${(li.content ?? []).map((p) => inline(p.content)).join(" ")}</li>`)
    .join("");
}

/** Component-level MJML for a node (no section wrapper) — usable inside columns. */
function blockInner(node: TiptapNode): string {
  const a = node.attrs ?? {};
  const al = a.textAlign && a.textAlign !== "left" ? ` align="${attr(String(a.textAlign))}"` : "";
  switch (node.type) {
    case "paragraph":
      return `<mj-text${al}>${inline(node.content) || "&nbsp;"}</mj-text>`;
    case "heading": {
      const level = Number(a.level ?? 2);
      const size = level === 1 ? "28px" : level === 3 ? "18px" : "22px";
      return `<mj-text font-size="${size}" font-weight="700"${al}>${inline(node.content)}</mj-text>`;
    }
    case "bulletList":
      return `<mj-text><ul style="margin:0;padding-left:20px;">${listItems(node.content)}</ul></mj-text>`;
    case "orderedList":
      return `<mj-text><ol style="margin:0;padding-left:20px;">${listItems(node.content)}</ol></mj-text>`;
    case "horizontalRule":
      return `<mj-divider />`;
    case "button":
      return `<mj-button href="${attr(String(a.href ?? "#"))}" align="${attr(String(a.align ?? "center"))}">${esc(String(a.text ?? "Button"))}</mj-button>`;
    case "emImage":
      return a.src ? `<mj-image src="${attr(String(a.src))}"${a.alt ? ` alt="${attr(String(a.alt))}"` : ""}${a.href ? ` href="${attr(String(a.href))}"` : ""} />` : "";
    case "spacer":
      return `<mj-spacer height="${Number(a.height ?? 24)}px" />`;
    case "htmlBlock":
      return `<mj-raw>${String(a.html ?? "")}</mj-raw>`;
    default:
      return "";
  }
}

/** Container-style attributes (bg / padding / border / radius) → mj-section attrs. */
function sectionStyle(a: Record<string, unknown>): string {
  const p: string[] = [];
  if (a.bg) p.push(`background-color="${attr(String(a.bg))}"`);
  if (a.pad != null && a.pad !== "") p.push(`padding="${Number(a.pad)}px"`);
  if (a.borderWidth) p.push(`border="${Number(a.borderWidth)}px solid ${attr(String(a.borderColor ?? "#000000"))}"`);
  if (a.radius) p.push(`border-radius="${Number(a.radius)}px"`);
  return p.length ? " " + p.join(" ") : "";
}

/** One top-level node → a full body-level MJML chunk (section, hero, or empty). */
function block(node: TiptapNode): string {
  const a = node.attrs ?? {};
  const ss = sectionStyle(a);
  if (node.type === "columns") {
    const cols = (node.content ?? [])
      .filter((c) => c.type === "column")
      .map((c) => `<mj-column>${(c.content ?? []).map(blockInner).join("")}</mj-column>`)
      .join("");
    return `<mj-section${ss}>${cols}</mj-section>`;
  }
  if (node.type === "social") {
    const els = ((a.items as { network: string; href: string }[]) ?? [])
      .map((s) => `<mj-social-element name="${attr(s.network)}" href="${attr(s.href)}" />`)
      .join("");
    return `<mj-section${ss}><mj-column><mj-social mode="horizontal">${els}</mj-social></mj-column></mj-section>`;
  }
  if (node.type === "hero") {
    const sub = a.text ? `<mj-text align="center" color="#ffffff" font-size="15px">${esc(String(a.text))}</mj-text>` : "";
    const btn = a.buttonText
      ? `<mj-button href="${attr(String(a.buttonHref ?? "#"))}">${esc(String(a.buttonText))}</mj-button>`
      : "";
    return `<mj-hero mode="fixed-height" height="300px" background-url="${attr(String(a.src ?? ""))}" background-color="#222831" background-position="center center" padding="60px 24px"><mj-text align="center" color="#ffffff" font-size="26px" font-weight="700">${esc(String(a.heading ?? ""))}</mj-text>${sub}${btn}</mj-hero>`;
  }
  const inner = blockInner(node);
  return inner ? `<mj-section${ss}><mj-column>${inner}</mj-column></mj-section>` : "";
}

/** Serialize a Tiptap doc + page settings to an MJML string. */
export function tiptapToMjml(doc: TiptapDoc, settings: PageSettings = {}): string {
  const sections = (doc.content ?? []).map(block).join("");
  const headParts: string[] = [];
  if (settings.preview) headParts.push(`<mj-preview>${esc(settings.preview)}</mj-preview>`);
  const css = settings.css?.trim().replaceAll(/<\/style>/gi, "");
  if (css) headParts.push(`<mj-style>${css}</mj-style>`);
  const head = headParts.length ? `<mj-head>${headParts.join("")}</mj-head>` : "";

  const bodyAttrs = [
    settings.background ? `background-color="${attr(settings.background)}"` : "",
    settings.width ? `width="${settings.width}px"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<mjml>${head}<mj-body${bodyAttrs ? " " + bodyAttrs : ""}>${sections}</mj-body></mjml>`;
}

/** Extract distinct `{{ var }}` names from a Tiptap doc + subject. */
export function tiptapVariables(doc: TiptapDoc, subject = ""): string[] {
  const found = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)/g)) found.add(m[1].split(".")[0]);
  };
  const scanAttrs = (a: Record<string, unknown> | undefined) => {
    for (const v of Object.values(a ?? {})) if (typeof v === "string") scan(v);
  };
  const walk = (n: TiptapNode) => {
    // A variable pill stores its bare name (not `{{ … }}`) — collect it directly.
    if (n.type === "variable" && typeof n.attrs?.name === "string") found.add(String(n.attrs.name).split(".")[0]);
    if (n.text) scan(n.text);
    for (const m of n.marks ?? []) scanAttrs(m.attrs);
    scanAttrs(n.attrs);
    (n.content ?? []).forEach(walk);
  };
  (doc.content ?? []).forEach(walk);
  scan(subject);
  return [...found];
}
