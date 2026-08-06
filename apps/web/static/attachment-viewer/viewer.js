// SPDX-License-Identifier: Apache-2.0
// Glue for the sandboxed attachment viewer. Runs INSIDE an opaque-origin iframe
// (sandbox="allow-scripts", NO allow-same-origin). It renders ATTACKER-CONTROLLED
// bytes, so every line here is defensive:
//
//  - NEVER fetches the attachment. The parent (session-authorized, same-origin)
//    fetched the already-SCANNED bytes and hands them over via postMessage. CSP
//    is connect-src 'none' — this frame can't phone home.
//  - NEVER uses innerHTML on attacker data. Images/SVG load as non-scriptable
//    <img src="blob:">, text goes in via textContent, PDF paints to <canvas>.
//  - PDF is parsed on the MAIN THREAD (disableWorker) inside THIS isolated frame,
//    with font-face/CMap/standard-font network fetches disabled so pdfjs makes
//    NO requests (CSP worker-src 'none', connect-src 'none' would block them).
//
// The parent's origin is opaque here too (we can't know it), so we postMessage
// with targetOrigin '*'; the parent validates by event.source, and we accept
// only the single 'render' message from our own opener (window.parent).

const root = document.getElementById("root");

function clear() {
	while (root.firstChild) root.removeChild(root.firstChild);
}

function showMessage(text) {
	clear();
	const box = document.createElement("div");
	box.className = "msg";
	box.textContent = text;
	root.appendChild(box);
}

function reportHeight() {
	const height = Math.ceil(document.documentElement.scrollHeight);
	parent.postMessage({ __attview: 1, type: "height", value: height }, "*");
}

function renderImage(blob) {
	clear();
	const url = URL.createObjectURL(blob);
	const img = document.createElement("img");
	img.className = "media";
	img.alt = "";
	// An SVG loaded as an <img> src cannot run its own scripts — this is why SVG
	// is safe here and must NEVER be injected as markup.
	img.onload = reportHeight;
	img.onerror = () => showMessage("This image couldn't be displayed.");
	img.src = url;
	root.appendChild(img);
}

function renderText(text) {
	clear();
	const pre = document.createElement("pre");
	pre.className = "text";
	pre.textContent = text; // never innerHTML — attacker bytes stay inert
	root.appendChild(pre);
	reportHeight();
}

async function renderPdf(data) {
	clear();
	const pdfjs = await import("/pdfjs/pdf.min.mjs");
	const task = pdfjs.getDocument({
		data,
		// No worker: parse on THIS thread, inside the isolated frame. A slow/hostile
		// PDF hangs only the sandbox, and CSP worker-src 'none' would block a worker.
		disableWorker: true,
		isEvalSupported: false,
		// Keep it fully offline — no CMap/standard-font/font-face network fetches
		// (connect-src 'none' would block them, and we never want the sandbox to
		// make requests). Embedded fonts still render; a missing font falls back.
		disableFontFace: true,
		cMapUrl: null,
		standardFontDataUrl: null,
	});
	const doc = await task.promise;
	try {
		for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
			const page = await doc.getPage(pageNo);
			const base = page.getViewport({ scale: 1 });
			const width = Math.min(root.clientWidth || 800, 1400) || 800;
			const viewport = page.getViewport({ scale: width / base.width });
			const canvas = document.createElement("canvas");
			canvas.className = "page";
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			root.appendChild(canvas);
			await page.render({ canvasContext: canvas.getContext("2d"), canvas, viewport }).promise;
			reportHeight();
		}
	} finally {
		void task.destroy();
	}
}

async function render(bytes, mime, name) {
	const type = (mime || "").toLowerCase().split(";")[0].trim();
	try {
		if (type === "application/pdf") {
			await renderPdf(new Uint8Array(bytes));
		} else if (type.startsWith("image/")) {
			// covers image/svg+xml too — as a non-scriptable <img>
			renderImage(new Blob([bytes], { type: type || "application/octet-stream" }));
		} else if (
			type.startsWith("text/") ||
			type === "application/json" ||
			type === "application/xml"
		) {
			renderText(new TextDecoder().decode(bytes));
		} else {
			showMessage("This file type can't be previewed. Download it to open.");
		}
	} catch (err) {
		showMessage("This document couldn't be displayed.");
	}
	reportHeight();
}

window.addEventListener("message", (event) => {
	// Only accept the render handoff from our own parent (the app frame). Origin
	// is 'null' (opaque), so we can't check it; source identity is the guard.
	if (event.source !== window.parent) return;
	const data = event.data;
	if (!data || data.type !== "render") return;
	render(data.bytes, data.mime, data.name);
});

// Re-measure on late layout shifts (image decode, font paint).
try {
	new ResizeObserver(reportHeight).observe(document.documentElement);
} catch (_) {
	/* ResizeObserver unsupported — height still reported after each render */
}

// Tell the parent we're live so it fetches + hands over the bytes.
parent.postMessage({ __attview: 1, type: "viewer-ready" }, "*");
