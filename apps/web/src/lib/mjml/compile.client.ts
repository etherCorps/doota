// SPDX-License-Identifier: Apache-2.0
/**
 * Client-side MJML→HTML compile via MRML (Rust/WASM, `web` target). Dynamic
 * import so SSR never loads the wasm; the send path stays wasm-free (un-jinja
 * renders the stored HTML at send). Shared by the template editor.
 * NOTE: `mrml` is excluded from Vite optimizeDeps (see vite.config.ts) so the
 * wasm resolves from node_modules in dev.
 */
let engineP: Promise<{ toHtml(s: string): { type: string; content?: string } }> | null = null;

function getEngine() {
  if (!engineP) {
    engineP = (async () => {
      const mod = await import('mrml/web/mrml_wasm.js');
      const wasmUrl = (await import('mrml/web/mrml_wasm_bg.wasm?url')).default;
      await mod.default(wasmUrl);
      return new mod.Engine();
    })();
  }
  return engineP;
}

/** MJML string → responsive HTML (merge tags preserved). Throws on parse error. */
export async function compileMjml(mjml: string): Promise<string> {
  const engine = await getEngine();
  const out = engine.toHtml(mjml);
  if (out.type !== 'success' || !out.content) throw new Error('Could not compile the template.');
  return out.content;
}
