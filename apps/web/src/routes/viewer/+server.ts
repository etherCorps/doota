// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "@sveltejs/kit";

/**
 * The file-viewer attachment shell: same-origin, session-gated (no public
 * endpoint, no extra domain: a required second hostname per deployment is an
 * ops burden this self-hosted product avoids). Renders rich formats only
 * (Office, archives, epub, …); pdf/images/text keep the opaque hard-isolated
 * viewer (/api/attachment-view), so the classic exploit vectors stay contained.
 *
 * Same-origin isolation is layered, not absolute:
 *  - the frame is sandboxed (allow-scripts allow-same-origin, required for
 *    file-viewer's Workers/WASM) and only ever opened after the scan gate;
 *  - CSP pins scripts to 'self' (only our vendored tree can execute) and
 *    connect-src to the /file-viewer/ asset path, so a compromised renderer on
 *    the main thread cannot fetch /api/* even though it shares the origin;
 *  - the session cookie is HttpOnly, so script can never read it;
 *  - residual risk: dedicated Workers don't inherit this document CSP, so a
 *    renderer exploit running in a worker could make authenticated same-origin
 *    fetches. Accepted trade for zero extra domains; the scan gate and pinned
 *    script sources are the layers in front of it.
 *
 * The shell carries no data: the app parent fetches the already-scanned bytes
 * and posts them in (same protocol as the opaque viewer).
 */
export const GET: RequestHandler = ({ url, locals }) => {
  // Session-gated like every app route: the shell is not a public endpoint.
  if (!locals.user) return new Response("Not authenticated", { status: 401 });

  const directives = [
    "default-src 'none'",
    // 'wasm-unsafe-eval' permits WebAssembly compilation only (not JS eval).
    // The archive pipeline instantiates libarchive wasm on the document's main
    // thread and hard-fails without it (found live). Scripts stay 'self'-only.
    "script-src 'self' 'wasm-unsafe-eval'", // shell glue + runtime IIFE + lazy renderer chunks
    "worker-src 'self' blob:", // renderer pipelines (docx/xlsx/pptx) run in Workers
    // Path-scoped to renderer asset/wasm fetches only. /api/* is unreachable
    // from this document even though it's the same origin.
    `connect-src ${url.origin}/file-viewer/`,
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "media-src blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // 'self' + blob: the pdf-family pipelines embed their vendored viewer
    // document in a child iframe.
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
  ];
  const csp = directives.join("; ");

  const doc =
    "<!doctype html><html><head><meta charset=utf-8>" +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    // Hardcoded hex values are a deliberate deviation from the app's token
    // discipline: this shell is a static document with no access to the token
    // pipeline (theme-matched values arrive via the render message).
    "<style>" +
    // color-scheme both: a scheme-mismatched embedded doc gets an opaque white
    // canvas behind its transparent background (the pre-surfaceBackground light
    // flash came from exactly this).
    "html{color-scheme:light dark}" +
    "html,body{margin:0;padding:0;height:100%;background:transparent;" +
    "font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-text-size-adjust:100%}" +
    // Fixed viewport, not grow-to-content: file-viewer lays out like an app
    // (toolbar + internally-scrolled, virtualized content). A height-growing
    // frame left the pdf pipeline's virtualized pages unpainted (found live).
    "#root{box-sizing:border-box;height:100vh;overflow:hidden}" +
    ".msg{padding:24px 12px;text-align:center;color:#8a8f98}" + // readable on both papers
    "</style></head><body>" +
    '<div id="root"><div class="msg">Loading preview…</div></div>' +
    '<script src="/file-viewer-runtime.iife.js" defer></script>' +
    '<script src="/attachment-viewer/file-viewer-shell.js" defer></script>' +
    "</body></html>";

  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
};
