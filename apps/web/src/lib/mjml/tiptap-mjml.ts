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

/** Per-type typography defaults (the Theme panel). Applied to every block of
 * that role unless the block carries its own inline override. */
export type ThemeType = { color?: string; size?: number; weight?: number; lineHeight?: number };
export type Theme = { text?: ThemeType; title?: ThemeType; subtitle?: ThemeType; heading?: ThemeType };

export type PageSettings = {
  background?: string;
  width?: number;
  preview?: string;
  css?: string;
  theme?: Theme;
};

/** Serialize a ThemeType into mj-text attribute fragments. */
function typeAttrs(t: ThemeType | undefined): string[] {
  const p: string[] = [];
  if (!t) return p;
  if (t.color) p.push(`color="${attr(String(t.color))}"`);
  if (t.size) p.push(`font-size="${Number(t.size)}px"`);
  if (t.weight) p.push(`font-weight="${Number(t.weight)}"`);
  if (t.lineHeight) p.push(`line-height="${Number(t.lineHeight)}"`);
  return p;
}

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
    .map((node) => {
      if (node.type === "hardBreak") return "<br />";
      // Inline variable pill → the raw Jinja merge tag (not escaped).
      if (node.type === "variable") return `{{ ${String(node.attrs?.name ?? "")} }}`;
      if (node.type !== "text" || node.text == null) return "";
      let h = esc(node.text);
      for (const mark of node.marks ?? []) {
        switch (mark.type) {
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
            h = `<a href="${attr(String(mark.attrs?.href ?? "#"))}">${h}</a>`;
            break;
          case "textStyle": {
            const s: string[] = [];
            if (mark.attrs?.color) s.push(`color:${String(mark.attrs.color)}`);
            if (mark.attrs?.fontSize) s.push(`font-size:${String(mark.attrs.fontSize)}`);
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
    .filter((node) => node.type === "listItem")
    .map((listItem) => `<li>${(listItem.content ?? []).map((paragraph) => inline(paragraph.content)).join(" ")}</li>`)
    .join("");
}

/** Component-level MJML for a node (no section wrapper) — usable inside columns. */
function blockInner(node: TiptapNode, theme: Theme = {}): string {
  const a = node.attrs ?? {};
  const al = a.textAlign && a.textAlign !== "left" ? ` align="${attr(String(a.textAlign))}"` : "";
  switch (node.type) {
    case "paragraph": {
      const ta = typeAttrs(theme.text);
      return `<mj-text${ta.length ? " " + ta.join(" ") : ""}${al}>${inline(node.content) || "&nbsp;"}</mj-text>`;
    }
    case "heading": {
      const level = Number(a.level ?? 2);
      const th = level === 1 ? theme.title : level === 2 ? theme.subtitle : theme.heading;
      const size = th?.size ? `${Number(th.size)}px` : level === 1 ? "28px" : level === 3 ? "18px" : "22px";
      const weight = th?.weight ?? 700;
      const extra: string[] = [];
      if (th?.color) extra.push(`color="${attr(String(th.color))}"`);
      if (th?.lineHeight) extra.push(`line-height="${Number(th.lineHeight)}"`);
      return `<mj-text font-size="${size}" font-weight="${weight}"${extra.length ? " " + extra.join(" ") : ""}${al}>${inline(node.content)}</mj-text>`;
    }
    case "bulletList":
      return `<mj-text><ul style="margin:0;padding-left:20px;">${listItems(node.content)}</ul></mj-text>`;
    case "orderedList":
      return `<mj-text><ol style="margin:0;padding-left:20px;">${listItems(node.content)}</ol></mj-text>`;
    case "horizontalRule":
      return `<mj-divider />`;
    case "button": {
      const size = String(a.size ?? "md");
      const fs = size === "sm" ? "13px" : size === "lg" ? "16px" : "14px";
      const ip = size === "sm" ? "6px 12px" : size === "lg" ? "14px 26px" : "10px 18px";
      const bp = [
        `href="${attr(String(a.href ?? "#"))}"`,
        `align="${attr(String(a.align ?? "center"))}"`,
        `background-color="${attr(String(a.btnBg ?? "#2563eb"))}"`,
        `color="${attr(String(a.btnColor ?? "#ffffff"))}"`,
        `border-radius="${Number(a.btnRadius ?? 6)}px"`,
        `font-size="${fs}"`,
        `inner-padding="${ip}"`,
      ];
      if (a.fullWidth) bp.push(`width="100%"`);
      return `<mj-button ${bp.join(" ")}>${esc(String(a.text ?? "Button"))}</mj-button>`;
    }
    case "emImage": {
      if (!a.src) return "";
      const ip = [`src="${attr(String(a.src))}"`];
      if (a.alt) ip.push(`alt="${attr(String(a.alt))}"`);
      if (a.href) ip.push(`href="${attr(String(a.href))}"`);
      if (a.width) ip.push(`width="${Number(a.width)}px"`);
      if (a.align) ip.push(`align="${attr(String(a.align))}"`);
      return `<mj-image ${ip.join(" ")} />`;
    }
    case "footer": {
      const unsub = a.unsubscribeUrl
        ? ` · <a href="${attr(String(a.unsubscribeUrl))}" style="color:inherit;">${esc(String(a.unsubscribeLabel ?? "Unsubscribe"))}</a>`
        : "";
      return `<mj-text align="center" color="#94a3b8" font-size="12px" line-height="1.6">${esc(String(a.text ?? ""))}${unsub}</mj-text>`;
    }
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
function block(node: TiptapNode, theme: Theme = {}): string {
  const a = node.attrs ?? {};
  const ss = sectionStyle(a);
  if (node.type === "columns") {
    const cols = (node.content ?? [])
      .filter((child) => child.type === "column")
      .map((column) => `<mj-column>${(column.content ?? []).map((child) => blockInner(child, theme)).join("")}</mj-column>`)
      .join("");
    return `<mj-section${ss}>${cols}</mj-section>`;
  }
  if (node.type === "social") {
    const els = ((a.items as { network: string; href: string }[]) ?? [])
      .map((social) => `<mj-social-element name="${attr(social.network)}" href="${attr(social.href)}" />`)
      .join("");
    return `<mj-section${ss}><mj-column><mj-social mode="horizontal">${els}</mj-social></mj-column></mj-section>`;
  }
  if (node.type === "hero") {
    const color = attr(String(a.textColor ?? "#ffffff"));
    const height = Number(a.height ?? 300);
    const sub = a.text ? `<mj-text align="center" color="${color}" font-size="15px">${esc(String(a.text))}</mj-text>` : "";
    const btn = a.buttonText
      ? `<mj-button href="${attr(String(a.buttonHref ?? "#"))}">${esc(String(a.buttonText))}</mj-button>`
      : "";
    return `<mj-hero mode="fixed-height" height="${height}px" background-url="${attr(String(a.src ?? ""))}" background-color="#222831" background-position="center center" padding="60px 24px"><mj-text align="center" color="${color}" font-size="26px" font-weight="700">${esc(String(a.heading ?? ""))}</mj-text>${sub}${btn}</mj-hero>`;
  }
  const inner = blockInner(node, theme);
  return inner ? `<mj-section${ss}><mj-column>${inner}</mj-column></mj-section>` : "";
}

/** Blocks that own a section (special layout) — never merged with siblings. */
function isStructural(type: string): boolean {
  return type === "columns" || type === "hero" || type === "social";
}
/** A block carries its own container style → it must be its own section so the
 * bg/padding/border apply to it alone, not to grouped siblings. */
function hasSectionStyle(a: Record<string, unknown>): boolean {
  return !!(a.bg || (a.pad != null && a.pad !== "") || a.borderWidth || a.radius);
}

/** Serialize a Tiptap doc + page settings to an MJML string. */
export function tiptapToMjml(doc: TiptapDoc, settings: PageSettings = {}): string {
  const theme = settings.theme ?? {};
  // Group consecutive "flow" blocks (text/heading/list/button/image/…) into one
  // mj-section so they stack with only element padding — the Resend / idiomatic
  // MJML rhythm. A structural block (columns/hero/social) or a block with its own
  // background/border/padding breaks out into its own section.
  const out: string[] = [];
  let group: TiptapNode[] = [];
  const flush = () => {
    if (!group.length) return;
    const inner = group.map((node) => blockInner(node, theme)).filter(Boolean).join("");
    if (inner) out.push(`<mj-section><mj-column>${inner}</mj-column></mj-section>`);
    group = [];
  };
  for (const node of doc.content ?? []) {
    if (isStructural(node.type) || hasSectionStyle(node.attrs ?? {})) {
      flush();
      out.push(block(node, theme));
    } else {
      group.push(node);
    }
  }
  flush();
  const sections = out.join("");
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
    for (const match of s.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)/g)) found.add(match[1].split(".")[0]);
  };
  const scanAttrs = (a: Record<string, unknown> | undefined) => {
    for (const value of Object.values(a ?? {})) if (typeof value === "string") scan(value);
  };
  const walk = (node: TiptapNode) => {
    // A variable pill stores its bare name (not `{{ … }}`) — collect it directly.
    if (node.type === "variable" && typeof node.attrs?.name === "string") found.add(String(node.attrs.name).split(".")[0]);
    if (node.text) scan(node.text);
    for (const mark of node.marks ?? []) scanAttrs(mark.attrs);
    scanAttrs(node.attrs);
    (node.content ?? []).forEach(walk);
  };
  (doc.content ?? []).forEach(walk);
  scan(subject);
  return [...found];
}
