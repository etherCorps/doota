// SPDX-License-Identifier: Apache-2.0
// The sandbox attribute is the load-bearing security control for the attachment
// viewer: it must grant allow-scripts (so our glue runs) but MUST NOT grant
// allow-same-origin (which, combined with allow-scripts, defeats the sandbox and
// lets an attacker-controlled document escape into the app origin). Assert it in
// a test, not by review — this is exactly the constraint that gets regressed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ATTACHMENT_VIEWER_SANDBOX, RICH_VIEWER_SANDBOX } from "$lib/client/attachment-viewer-sandbox";
import { isViewable, isBaseViewable, viewerFor } from "$lib/client/attachment-viewable";

describe("attachment viewer sandbox", () => {
	it("grants allow-scripts", () => {
		expect(ATTACHMENT_VIEWER_SANDBOX).toContain("allow-scripts");
	});

	it("does NOT grant allow-same-origin (would defeat the sandbox)", () => {
		expect(ATTACHMENT_VIEWER_SANDBOX).not.toContain("allow-same-origin");
	});

	it("is applied to the iframe via the shared constants, not an inline string", () => {
		// The component must APPLY the constants (whose values the tests here pin)
		// rather than inline attributes that could drift out of sync.
		const componentPath = fileURLToPath(
			new URL("../lib/components/mail/attachment-viewer.svelte", import.meta.url),
		);
		const source = readFileSync(componentPath, "utf8");
		expect(source).toContain("sandbox={frameSandbox}");
		// RICH (allow-same-origin, weaker) may pair ONLY with rich-only formats;
		// base types (pdf/images/text) MUST keep the opaque sandbox + route.
		expect(source).toContain("rich ? RICH_VIEWER_SANDBOX : ATTACHMENT_VIEWER_SANDBOX");
		expect(source).toContain("rich ? '/viewer' : '/api/attachment-view'");
		// Shell decided by the single source of truth (viewerFor), not an ad-hoc
		// inline check — so markdown-to-rich stays consistent with the gate.
		expect(source).toContain("viewerFor(viewer.contentType, viewer.filename) === 'rich'");
	});

	it("rich sandbox grants allow-same-origin (compensated by /viewer's CSP)", () => {
		expect(RICH_VIEWER_SANDBOX).toContain("allow-scripts");
		expect(RICH_VIEWER_SANDBOX).toContain("allow-same-origin");
	});
});

describe("isViewable", () => {
	it("routes images, svg, text, pdf, and media to the viewer", () => {
		for (const type of [
			"image/png",
			"image/jpeg",
			"image/svg+xml",
			"video/mp4",
			"audio/mpeg",
			"text/plain",
			"text/csv",
			"application/pdf",
			"application/json",
			"APPLICATION/PDF", // case-insensitive
			"text/plain; charset=utf-8", // parameter-tolerant
		]) {
			expect(isViewable(type), type).toBe(true);
		}
	});

	it("leaves non-viewable types to download", () => {
		for (const type of ["application/octet-stream", null, undefined, ""]) {
			expect(isViewable(type), String(type)).toBe(false);
		}
	});
});

describe("isViewable — rich formats (same-origin file-viewer shell)", () => {
	it("adds office/archive types on top of the base set", () => {
		for (const [type, name] of [
			["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "r.docx"],
			["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "s.xlsx"],
			["application/zip", "z.zip"],
			["application/octet-stream", "notes.md"], // extension fallback
		] as const) {
			expect(isViewable(type, name), name).toBe(true);
			// ...but they are NOT base-viewable: they must ride the rich shell.
			expect(isBaseViewable(type), name).toBe(false);
		}
		// Unknown binaries still download.
		expect(isViewable("application/octet-stream", "blob.bin")).toBe(false);
	});

	it("base types stay base-viewable (opaque hard-isolated viewer)", () => {
		for (const type of [
			"application/pdf",
			"image/png",
			"text/plain",
			"image/svg+xml",
			"video/mp4",
			"audio/mpeg",
		]) {
			expect(isBaseViewable(type), type).toBe(true);
		}
	});

	it("markdown routes to the RICH shell, not base text — by MIME or extension", () => {
		// text/markdown MIME.
		expect(viewerFor("text/markdown", "notes.md")).toBe("rich");
		// text/plain MIME with a .md name (common) — must beat the base text branch.
		expect(viewerFor("text/plain", "notes.md")).toBe("rich");
		expect(viewerFor("application/octet-stream", "README.markdown")).toBe("rich");
		expect(isBaseViewable("text/markdown", "notes.md")).toBe(false);
		// A plain .txt still renders as flat text in the base viewer.
		expect(viewerFor("text/plain", "notes.txt")).toBe("base");
	});
});
