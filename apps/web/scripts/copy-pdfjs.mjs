// SPDX-License-Identifier: Apache-2.0
// Self-host pdfjs for the sandboxed attachment viewer. The viewer doc loads
// pdf.min.mjs from OUR origin as a module (script-src ${origin}) — the sandbox
// has an opaque origin and makes no network calls, so it can't import from a CDN.
// Copies the pinned pdfjs-dist build into static/ at prepare time so a version
// bump refreshes it. The copy is also committed, so a fresh checkout works
// without an install step. Fails silently if the dep isn't present yet (CI order).
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../node_modules/pdfjs-dist/build/pdf.min.mjs");
const destDir = resolve(here, "../static/pdfjs");
const dest = resolve(destDir, "pdf.min.mjs");

if (!existsSync(src)) {
	console.warn("[copy-pdfjs] pdfjs-dist not installed yet; skipping (committed copy stays).");
	process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[copy-pdfjs] static/pdfjs/pdf.min.mjs refreshed.");
