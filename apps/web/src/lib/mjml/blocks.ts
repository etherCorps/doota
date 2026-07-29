// SPDX-License-Identifier: Apache-2.0
/**
 * Template builder block model + MJML serializer (docs/service-accounts.md
 * § Builder). Pure + framework-free so it runs in the browser (the builder
 * compiles to HTML client-side via mrml/web) and in tests. The "learn from
 * GrapesJS, don't ship its stack" core — MRML compilation lives at the call
 * site, not here. Jinja `{{ }}` merge tags are written into block text and
 * survive compilation, then render at send with un-jinja.
 *
 * Each block serializes to a full `<mj-section>` so multi-column blocks can own
 * their section layout.
 */

export type SocialItem = { network: string; href: string };

/** Fields on every block: stable id + optional per-element custom CSS. */
export type BlockBase = { id: string; css?: string };

/** Block set — MJML core primitives + a couple of composite layouts. */
export type Block = BlockBase &
  (
    | { type: "heading"; text: string; level?: 1 | 2 | 3; align?: Align }
    | { type: "text"; text: string; align?: Align }
    | { type: "button"; text: string; href: string; align?: Align }
    | { type: "image"; src: string; alt?: string; href?: string }
    | { type: "divider" }
    | { type: "spacer"; height?: number }
    | { type: "list"; items: string[]; ordered?: boolean }
    | { type: "quote"; text: string }
    | { type: "columns"; left: string; right: string }
    | { type: "social"; items: SocialItem[] }
    | { type: "hero"; src: string; heading: string; text?: string; buttonText?: string; buttonHref?: string }
    | { type: "html"; html: string }
  );

export type Align = "left" | "center" | "right";
/** Template-wide settings — body background + a custom-CSS escape hatch. */
export type TemplateSettings = { bodyBackground?: string; css?: string };
export type BlockDoc = { blocks: Block[]; settings?: TemplateSettings };

/** Escape HTML specials but leave `{{ merge }}` tags intact (they carry none). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a double-quoted attribute value. */
function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** align="…" attribute, or empty. */
function alignAttr(a: Align | undefined): string {
  return a ? ` align="${a}"` : "";
}

/** A stacked single-column block's inner MJML component(s). */
function component(b: Block): string {
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? "28px" : b.level === 3 ? "18px" : "22px";
      return `<mj-text font-size="${size}" font-weight="700"${alignAttr(b.align)}>${esc(b.text)}</mj-text>`;
    }
    case "text":
      return `<mj-text${alignAttr(b.align)}>${esc(b.text)}</mj-text>`;
    case "button":
      return `<mj-button href="${attr(b.href)}"${alignAttr(b.align)}>${esc(b.text)}</mj-button>`;
    case "image":
      return `<mj-image src="${attr(b.src)}"${b.alt ? ` alt="${attr(b.alt)}"` : ""}${b.href ? ` href="${attr(b.href)}"` : ""} />`;
    case "divider":
      return `<mj-divider />`;
    case "spacer":
      return `<mj-spacer height="${b.height ?? 20}px" />`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = b.items.map((i) => `<li>${esc(i)}</li>`).join("");
      return `<mj-text><${tag} style="margin:0;padding-left:20px;">${items}</${tag}></mj-text>`;
    }
    case "quote":
      return `<mj-text><blockquote style="margin:0;border-left:3px solid #d0d0d0;padding:4px 0 4px 14px;color:#555;">${esc(b.text)}</blockquote></mj-text>`;
    case "html":
      // Author-supplied raw HTML block — wrapped in mj-raw so MRML passes it through.
      return `<mj-raw>${b.html}</mj-raw>`;
    // Composite blocks own their section (below) — never reach here.
    case "columns":
    case "social":
    case "hero":
      return "";
  }
}

/** A block's per-element CSS class (its own custom-CSS rule targets this). */
function classFor(b: Block): string {
  return `b${b.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
/** ` css-class="…"` when the block has custom CSS, else empty. */
function cssClassAttr(b: Block): string {
  return b.css?.trim() ? ` css-class="${classFor(b)}"` : "";
}

/** Serialize one block to a full body-level MJML chunk (section or hero). */
function blockToSection(b: Block): string {
  const cc = cssClassAttr(b);
  if (b.type === "columns") {
    return `<mj-section${cc}><mj-column><mj-text>${esc(b.left)}</mj-text></mj-column><mj-column><mj-text>${esc(b.right)}</mj-text></mj-column></mj-section>`;
  }
  if (b.type === "social") {
    const els = b.items
      .map((s) => `<mj-social-element name="${attr(s.network)}" href="${attr(s.href)}" />`)
      .join("");
    return `<mj-section${cc}><mj-column><mj-social mode="horizontal">${els}</mj-social></mj-column></mj-section>`;
  }
  if (b.type === "hero") {
    const sub = b.text ? `<mj-text align="center" color="#ffffff" font-size="15px">${esc(b.text)}</mj-text>` : "";
    const btn = b.buttonText
      ? `<mj-button href="${attr(b.buttonHref ?? "#")}">${esc(b.buttonText)}</mj-button>`
      : "";
    return `<mj-hero${cc} mode="fixed-height" height="300px" background-url="${attr(b.src)}" background-color="#222831" background-position="center center" padding="60px 24px"><mj-text align="center" color="#ffffff" font-size="26px" font-weight="700">${esc(b.heading)}</mj-text>${sub}${btn}</mj-hero>`;
  }
  return `<mj-section${cc}><mj-column>${component(b)}</mj-column></mj-section>`;
}

/** Strip any `</style>` breakout from author CSS. */
function safeCss(css: string): string {
  return css.trim().replaceAll(/<\/style>/gi, "");
}

/**
 * Head `mj-style` combining per-block CSS rules (`.bID { … }`) and the template's
 * global custom CSS. Empty when there's nothing to emit.
 */
function head(doc: BlockDoc): string {
  const perBlock = doc.blocks
    .filter((b) => b.css?.trim())
    .map((b) => `.${classFor(b)}{${safeCss(b.css!)}}`)
    .join("");
  const global = safeCss(doc.settings?.css ?? "");
  const style = perBlock + global;
  return style ? `<mj-head><mj-style>${style}</mj-style></mj-head>` : "";
}

/** Serialize a block document to an MJML string. */
export function blocksToMjml(doc: BlockDoc): string {
  const bg = doc.settings?.bodyBackground
    ? ` background-color="${attr(doc.settings.bodyBackground)}"`
    : "";
  return `<mjml>${head(doc)}<mj-body${bg}>${doc.blocks.map(blockToSection).join("")}</mj-body></mjml>`;
}

/** Pull the distinct `{{ var }}` merge-tag names from every text field + subject. */
export function extractVariables(doc: BlockDoc, subject = ""): string[] {
  const hay = [subject, ...doc.blocks.flatMap(textFields)].join("\n");
  const found = new Set<string>();
  for (const m of hay.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)/g)) {
    found.add(m[1].split(".")[0]);
  }
  return [...found];
}

function textFields(b: Block): string[] {
  switch (b.type) {
    case "heading":
    case "text":
    case "quote":
      return [b.text];
    case "button":
      return [b.text, b.href];
    case "image":
      return [b.src, b.alt ?? "", b.href ?? ""];
    case "list":
      return b.items;
    case "columns":
      return [b.left, b.right];
    case "social":
      return b.items.map((s) => s.href);
    case "hero":
      return [b.src, b.heading, b.text ?? "", b.buttonText ?? "", b.buttonHref ?? ""];
    case "html":
      return [b.html];
    default:
      return [];
  }
}

/** Build the variablesSchema JSON from names + a caller-supplied sensitive set. */
export function variablesSchemaJson(names: string[], sensitive: string[] = []): string {
  const set = new Set(sensitive);
  const schema: Record<string, { sensitive?: boolean }> = {};
  for (const n of names) schema[n] = set.has(n) ? { sensitive: true } : {};
  return JSON.stringify(schema);
}
