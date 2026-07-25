// SPDX-License-Identifier: Apache-2.0
/**
 * Sätteri mdast plugin: turn ```mermaid fenced code blocks into a raw
 * `<pre class="mermaid">` element so Shiki never tokenizes them and the
 * client-side mermaid runtime (BaseLayout) can render them to SVG.
 *
 * Runs at the mdast stage (before Shiki), which is why the diagram source
 * survives intact. Escapes HTML so the graph text is preserved verbatim as the
 * element's textContent (mermaid reads that back, entities decoded).
 */
import type { MdastPluginDefinition } from "satteri";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mermaidBlocks(): MdastPluginDefinition {
  return {
    name: "doota:mermaid",
    code(node) {
      if (node.lang !== "mermaid") return;
      return { rawHtml: `<pre class="mermaid">${escapeHtml(node.value)}</pre>` };
    },
  };
}
