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
const buildDir = resolve(here, "../node_modules/pdfjs-dist/build");
const destDir = resolve(here, "../static/pdfjs");
// pdf.worker.min.mjs too: pdfjs ≥5 REQUIRES workerSrc; with CSP worker-src
// 'none' it falls back to a main-thread "fake worker" that dynamic-imports this
// same file — so it must be self-hosted alongside the main bundle.
const files = ["pdf.min.mjs", "pdf.worker.min.mjs"];

if (!existsSync(resolve(buildDir, files[0]))) {
	console.warn("[copy-pdfjs] pdfjs-dist not installed yet; skipping (committed copy stays).");
	process.exit(0);
}
mkdirSync(destDir, { recursive: true });
for (const file of files) copyFileSync(resolve(buildDir, file), resolve(destDir, file));
console.log("[copy-pdfjs] static/pdfjs refreshed:", files.join(", "));
