// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from "@sveltejs/kit";

/**
 * The in-house sandboxed attachment viewer document. This is the security
 * boundary for rendering ATTACKER-CONTROLLED documents (PDF, images, SVG, text)
 * without a third-party viewer.
 *
 * It mirrors /api/messages/[id]/body: a hand-built HTML doc, loaded inside an
 * iframe with sandbox="allow-scripts" and NO allow-same-origin, so it runs in an
 * OPAQUE origin — isolated from the app's cookies/DOM/storage. Combined with the
 * CSP below the frame can:
 *   - load ONLY our own glue module + pdfjs (script-src ${url.origin}),
 *   - render only blob:/data: images (img-src),
 *   - NOTHING else — connect-src/worker-src/object-src/frame-src all 'none'.
 *
 * The document carries NO attachment data. The parent (session-authorized,
 * same-origin) fetches the already-SCANNED bytes and posts them in; the viewer
 * NEVER fetches. So connect-src 'none' is correct and load-bearing.
 *
 * NEVER add allow-same-origin to the frame that loads this — with allow-scripts
 * it lets the doc strip its own sandbox and escape into the app origin.
 */
export const GET: RequestHandler = ({ url, locals }) => {
	// Session-gated like every app route (defence in depth; the doc holds no data,
	// but an unauth'd user has no business loading the shell).
	if (!locals.user) return new Response("Not authenticated", { status: 401 });

	// We list the EXPLICIT origin, not 'self': the frame is sandboxed without
	// allow-same-origin, so its origin is opaque — and Safari treats 'self' as
	// "the opaque origin", which matches nothing and would block our own module.
	// (Same reasoning as the body route's img-src comment.)
	const directives = [
		"default-src 'none'",
		`script-src ${url.origin}`, // our glue module + self-hosted pdfjs, nothing else
		"connect-src 'none'", // never fetches — bytes arrive via postMessage
		"worker-src 'none'", // blocks a real Worker → pdfjs falls back to its main-thread fake worker
		"img-src blob: data:", // rendered images/SVG only
		"style-src 'unsafe-inline'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"manifest-src 'none'",
		"frame-ancestors 'self'",
	];
	// The `sandbox` token here MUST match the iframe's sandbox attribute
	// (ATTACHMENT_VIEWER_SANDBOX = "allow-scripts"): the browser applies the
	// INTERSECTION, so a mismatch silently strips capabilities. allow-scripts
	// only — NO allow-same-origin (opaque origin), no forms/popups/nav.
	const csp = `${directives.join("; ")}; sandbox allow-scripts`;

	// Hand-built shell. It contains NO attacker data — the glue module fills #root
	// from postMessage'd bytes using textContent/blob <img>/canvas only.
	const doc =
		"<!doctype html><html><head><meta charset=utf-8>" +
		'<meta name=viewport content="width=device-width,initial-scale=1">' +
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		// Hardcoded hex values are a deliberate deviation from the app's token
		// discipline: this shell is a static document with no access to the token
		// pipeline. Theme comes with the render message — the glue stamps
		// data-theme on <html> so text previews stay readable in dark mode
		// (unconditional #111 ink on the parent's dark bg-card was unreadable).
		"<style>" +
		// color-scheme MUST cover both: an embedded doc whose scheme mismatches
		// the embedder's gets an OPAQUE WHITE canvas behind its "transparent"
		// background (spec behavior; found live — it's why dark ink used to be
		// readable by accident, on a white canvas the app never asked for).
		"html{color-scheme:light dark}" +
		"html,body{margin:0;padding:0;background:transparent;color:#111;" +
		"font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-text-size-adjust:100%}" +
		'[data-theme="dark"] body{color:#dfe3ea}' +
		"#root{padding:8px;box-sizing:border-box}" +
		".media{max-width:100%;height:auto;display:block;margin:0 auto}" +
		".page{max-width:100%;height:auto;display:block;margin:0 auto 8px;box-shadow:0 1px 4px rgba(0,0,0,.15)}" +
		".text{margin:0;white-space:pre-wrap;word-break:break-word;" +
		"font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
		".msg{padding:24px 12px;text-align:center;color:#8a8f98}" +
		"</style></head><body>" +
		'<div id="root"><div class="msg">Loading preview…</div></div>' +
		// CLASSIC script, not type=module: module scripts are CORS-fetched, and
		// this doc's origin is opaque ('null') — the bare asset has no ACAO header
		// so the browser would block our own glue (found live). Classic scripts
		// load no-cors; CSP script-src still pins it to our origin. The glue's one
		// module need (pdfjs) goes through the ACAO shim at /api/attachment-view/pdfjs.
		'<script src="/attachment-viewer/viewer.js" defer></script>' +
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
