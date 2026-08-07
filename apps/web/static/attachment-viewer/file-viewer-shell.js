// SPDX-License-Identifier: Apache-2.0
// Glue for the file-viewer attachment shell. Runs on the ISOLATED viewer origin
// (VIEWER_ORIGIN — real origin so file-viewer's Workers/WASM run; no cookies, no
// app DOM, frame-ancestors pins embedding to the app). Same postMessage protocol
// as the opaque-iframe fallback (attachment-viewer/viewer.js):
//
//   shell → parent:  { __attview: 1, type: "viewer-ready" }
//                    { __attview: 1, type: "height", value }
//   parent → shell:  { type: "render", bytes, mime, name }
//
// The shell NEVER fetches mail — the parent fetched the already-SCANNED bytes
// on the app origin (session cookie there, none here) and hands them over.
const root = document.getElementById("root");

function showMessage(text) {
	while (root.firstChild) root.removeChild(root.firstChild);
	const box = document.createElement("div");
	box.className = "msg";
	box.textContent = text;
	root.appendChild(box);
}

function reportHeight() {
	const height = Math.ceil(document.documentElement.scrollHeight);
	parent.postMessage({ __attview: 1, type: "height", value: height }, "*");
}

function render(bytes, mime, name, theme) {
	const runtime = globalThis.FlyfishFileViewerWebFull;
	if (!runtime) {
		showMessage("This document couldn't be displayed.");
		reportHeight();
		return;
	}
	while (root.firstChild) root.removeChild(root.firstChild);
	try {
		// All renderer chunks/workers/wasm/fonts come from OUR vendored tree.
		// ABSOLUTE url — a path-relative base throws "Invalid base URL" inside
		// the runtime's own new URL(chunk, base) resolution (found live).
		runtime.setDefaultFullAssetBaseUrl(new URL("/file-viewer/", location.href).href);
		// Route by filename EXTENSION: passing a MIME `type` makes the runtime
		// treat the raw MIME string as the format id and reject e.g. docx with
		// "cannot be previewed online" (found live). Only fall back to the MIME
		// when the filename carries no extension.
		const filename = name || "file";
		runtime.mountViewer(root, {
			buffer: bytes,
			filename,
			type: filename.includes(".") ? undefined : mime || undefined,
			options: {
				// Match the app's light/dark mode (posted by the parent) — no
				// surprise theme flip inside the preview.
				theme: theme === "dark" ? "dark" : "light",
				// Stable, THEME-MATCHED workspace: each renderer otherwise repaints
				// its own light/dark default when swapping documents (light flicker
				// on archive entry switches), and some inner containers (docx
				// fit-viewer) ignore a transparent surface and left a white band in
				// dark mode (found live). One fixed color, no repaint, no band.
				ui: { surfaceBackground: theme === "dark" ? "#161b22" : "#f6f7f9" },
				// Documents open at a readable width, not a tiny first-screen fit.
				fit: "width",
				// One chrome bar owns download (the app's, gate-consistent). The
				// runtime keeps zoom/search/pagination; its own download/print/
				// export/theme buttons are redundant chrome — off.
				toolbar: {
					download: false,
					print: false,
					exportHtml: false,
					theme: false,
				},
				hooks: { onLoadComplete: () => reportHeight() },
			},
			onStateChange: (state) => {
				if (state && state.error) {
					console.error("[file-viewer-shell] render error:", state.error);
					showMessage("This document couldn't be displayed.");
				}
				reportHeight();
			},
		});
	} catch (err) {
		console.error("[file-viewer-shell] mount failed:", err);
		showMessage("This document couldn't be displayed.");
	}
	reportHeight();
}

window.addEventListener("message", (event) => {
	// frame-ancestors already restricts who can embed us; accept the render
	// handoff only from that embedder.
	if (event.source !== window.parent) return;
	const data = event.data;
	if (!data || data.type !== "render") return;
	render(data.bytes, data.mime, data.name, data.theme);
});

// Esc must close the lightbox even when focus lives INSIDE this frame (the
// parent dialog never sees iframe keydowns). Skip when a renderer already
// handled it (e.g. closing its own search box).
window.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.defaultPrevented) return;
	parent.postMessage({ __attview: 1, type: "close-request" }, "*");
});

// Re-measure on late layout shifts (worker renders paint asynchronously).
try {
	new ResizeObserver(reportHeight).observe(document.documentElement);
} catch (_) {
	/* ResizeObserver unsupported — height still reported after render */
}

parent.postMessage({ __attview: 1, type: "viewer-ready" }, "*");
