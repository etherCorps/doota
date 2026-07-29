// SPDX-License-Identifier: Apache-2.0
/**
 * Template builder toolchain (docs/service-accounts.md § Builder). Our own block
 * schema + serializer — the "learn from GrapesJS, don't ship its stack" part —
 * compiled to responsive cross-client HTML by MRML (Rust→WASM, the `mjml` node
 * lib doesn't run on Workers). Jinja `{{ }}` merge tags are written into block
 * text and SURVIVE compilation, then render at send with un-jinja.
 *
 * Compile runs at template SAVE (rare), not on the hot send path. Blocks are the
 * source of truth (editorJson); compiledHtml is the derived, sendable artifact.
 */
import { Engine } from "mrml";

/** MVP block set — MJML core primitives (no nested columns yet). */
export type Block =
  | { id: string; type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { id: string; type: "text"; text: string }
  | { id: string; type: "button"; text: string; href: string }
  | { id: string; type: "image"; src: string; alt?: string; href?: string }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; height?: number }
  | { id: string; type: "html"; html: string };

export type BlockDoc = { blocks: Block[] };

/** Escape HTML specials but leave `{{ merge }}` tags intact (they carry none). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a double-quoted attribute value. */
function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function blockToMjml(b: Block): string {
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? "28px" : b.level === 3 ? "18px" : "22px";
      return `<mj-text font-size="${size}" font-weight="700">${esc(b.text)}</mj-text>`;
    }
    case "text":
      return `<mj-text>${esc(b.text)}</mj-text>`;
    case "button":
      return `<mj-button href="${attr(b.href)}">${esc(b.text)}</mj-button>`;
    case "image":
      return `<mj-image src="${attr(b.src)}"${b.alt ? ` alt="${attr(b.alt)}"` : ""}${b.href ? ` href="${attr(b.href)}"` : ""} />`;
    case "divider":
      return `<mj-divider />`;
    case "spacer":
      return `<mj-spacer height="${b.height ?? 20}px" />`;
    case "html":
      // Author-supplied raw HTML block — wrapped in mj-raw so MRML passes it through.
      return `<mj-raw>${b.html}</mj-raw>`;
  }
}

/** Serialize a block document to an MJML string (each block its own section). */
export function blocksToMjml(doc: BlockDoc): string {
  const body = doc.blocks
    .map((b) => `<mj-section><mj-column>${blockToMjml(b)}</mj-column></mj-section>`)
    .join("");
  return `<mjml><mj-body>${body}</mj-body></mjml>`;
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
      return [b.text];
    case "button":
      return [b.text, b.href];
    case "image":
      return [b.src, b.alt ?? "", b.href ?? ""];
    case "html":
      return [b.html];
    default:
      return [];
  }
}

const engine = new Engine();

export type CompileResult = { html: string; mjml: string; variables: string[]; warnings: string[] };

/**
 * Serialize + compile a block document to sendable HTML (merge tags preserved).
 * Throws on an MRML parse error. `subject` is only scanned for variable names.
 */
export function compileTemplate(doc: BlockDoc, subject = ""): CompileResult {
  const mjml = blocksToMjml(doc);
  const out = engine.toHtml(mjml) as {
    type: string;
    content?: string;
    message?: string;
    warnings?: { message: string }[];
  };
  if (out.type !== "success" || !out.content) {
    throw new Error(`MJML compile failed: ${out.message ?? "unknown error"}`);
  }
  return {
    html: out.content,
    mjml,
    variables: extractVariables(doc, subject),
    warnings: (out.warnings ?? []).map((w) => w.message),
  };
}

/** Build the variablesSchema JSON from names + a caller-supplied sensitive set. */
export function variablesSchemaJson(names: string[], sensitive: string[] = []): string {
  const set = new Set(sensitive);
  const schema: Record<string, { sensitive?: boolean }> = {};
  for (const n of names) schema[n] = set.has(n) ? { sensitive: true } : {};
  return JSON.stringify(schema);
}
