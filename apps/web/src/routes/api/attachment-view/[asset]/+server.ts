// SPDX-License-Identifier: Apache-2.0
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";

/**
 * CORS shim for the sandboxed viewer's pdfjs imports. The viewer frame runs in
 * an OPAQUE origin (sandbox without allow-same-origin), so its dynamic
 * `import()`s are CORS module fetches with `Origin: null` — the bare static
 * assets (/pdfjs/*) carry no ACAO header and the browser blocks them (found
 * live). This route re-serves the same self-hosted, public, data-free bundles
 * with ACAO. Two files: the pdfjs API, and the worker bundle pdfjs "fake
 * worker" mode dynamic-imports on the main thread (CSP worker-src 'none'
 * blocks a real Worker — intentionally). No auth: the opaque frame can't send
 * cookies, and the payload is a vendored library, not user data.
 */
const ASSETS: Record<string, string> = {
  pdfjs: "/pdfjs/pdf.min.mjs",
  "pdfjs-worker": "/pdfjs/pdf.worker.min.mjs",
};

export const GET: RequestHandler = async ({ url, params, fetch, platform }) => {
  const path = ASSETS[params.asset ?? ""];
  if (!path) error(404, "Not found");
  // The ASSETS binding serves the static dir directly. (SvelteKit's server
  // fetch does NOT reach static assets here — assets are served by the edge
  // BEFORE the worker, so a same-origin server-side fetch 404s. Found live.)
  const assets = (platform?.env as { ASSETS?: { fetch: typeof fetch } } | undefined)?.ASSETS;
  const target = new URL(path, url.origin);
  const upstream = await (assets ? assets.fetch(new Request(target)) : fetch(target));
  if (!upstream.ok) return new Response("pdfjs asset missing", { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      // Immutable vendored bundles — cache hard, bust by redeploy.
      "Cache-Control": "public, max-age=86400",
    },
  });
};
