// SPDX-License-Identifier: Apache-2.0
// Self-host the file-viewer runtime + renderer assets (no-CDN guard: everything
// serves from OUR origin). Runs at prepare time; output is GITIGNORED (159 MB of
// vendor workers/wasm — derived from node_modules, never committed).
//
//  - static/file-viewer/               ← file-viewer-copy-assets tree (workers,
//                                        wasm, fonts, vendor bundles)
//  - static/file-viewer-runtime.iife.js ← the @file-viewer/web-full IIFE the
//                                        viewer shell loads as a classic script
//
// Cloudflare Workers static assets cap a single file at 25 MiB — anything over
// is dropped (currently only the typst wasm compiler; typst preview falls back
// to download). Fails soft when deps aren't installed yet (CI order).
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// The file-viewer packages live in the STANDALONE tools/file-viewer-assets
// package (own lockfile, outside the workspace): inside apps/web their data
// renderer's sql.js/pg peers forked drizzle-orm into two type-incompatible
// instances (1000+ type errors). See that package.json's note.
const toolDir = resolve(here, "../../../tools/file-viewer-assets");
const distDir = resolve(toolDir, "node_modules/@file-viewer/web-full/dist");
const iife = resolve(distDir, "flyfish-file-viewer-web-full.iife.js");
const assetsDir = resolve(here, "../static/file-viewer");
const runtimeDest = resolve(here, "../static/file-viewer-runtime.iife.js");

if (!existsSync(iife)) {
	// Standalone package → root `pnpm install` doesn't populate it; do it here.
	try {
		execFileSync("pnpm", ["install", "--dir", toolDir, "--ignore-workspace"], {
			stdio: "inherit",
		});
	} catch {
		console.warn("[copy-file-viewer] tools/file-viewer-assets install failed; skipping.");
		process.exit(0);
	}
}
if (!existsSync(iife)) {
	console.warn("[copy-file-viewer] file-viewer deps unavailable; skipping.");
	process.exit(0);
}

// Copy the web-full dist tree DIRECTLY — the file-viewer-copy-assets CLI's
// bundled tree ships only vendor/ + wasm/ and MISSES the lazy renderer chunks
// (renderers/*.iife.js, assets/*) the IIFE loads at render time; the live
// symptom was "Failed to load Word renderer from .../renderers/word.iife.js".
rmSync(assetsDir, { recursive: true, force: true });
mkdirSync(assetsDir, { recursive: true });
for (const dir of ["assets", "renderers", "vendor", "wasm"]) {
	cpSync(resolve(distDir, dir), resolve(assetsDir, dir), { recursive: true });
}
copyFileSync(iife, runtimeDest);

// Drop anything over the Workers per-asset cap (25 MiB, keep headroom).
const MAX_ASSET_BYTES = 24 * 1024 * 1024;
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path);
		else if (statSync(path).size > MAX_ASSET_BYTES) {
			console.warn(`[copy-file-viewer] dropping oversize asset (>24MB): ${entry.name}`);
			rmSync(path);
		}
	}
};
walk(assetsDir);
console.log("[copy-file-viewer] static/file-viewer + runtime IIFE refreshed.");
