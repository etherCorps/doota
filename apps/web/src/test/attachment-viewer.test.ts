// SPDX-License-Identifier: Apache-2.0
// The sandbox attribute is the load-bearing security control for the attachment
// viewer: it must grant allow-scripts (so our glue runs) but MUST NOT grant
// allow-same-origin (which, combined with allow-scripts, defeats the sandbox and
// lets an attacker-controlled document escape into the app origin). Assert it in
// a test, not by review — this is exactly the constraint that gets regressed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ATTACHMENT_VIEWER_SANDBOX } from "$lib/client/attachment-viewer-sandbox";
import { isViewable } from "$lib/client/attachment-viewable";

describe("attachment viewer sandbox", () => {
	it("grants allow-scripts", () => {
		expect(ATTACHMENT_VIEWER_SANDBOX).toContain("allow-scripts");
	});

	it("does NOT grant allow-same-origin (would defeat the sandbox)", () => {
		expect(ATTACHMENT_VIEWER_SANDBOX).not.toContain("allow-same-origin");
	});

	it("is applied to the iframe via the shared constant, not an inline string", () => {
		// The component must APPLY the constant (whose value the two tests above
		// pin) rather than an inline attribute that could drift out of sync. Pin
		// the exact binding on the iframe element (ignore the doc comment, which
		// legitimately names allow-same-origin when explaining why it's excluded).
		const componentPath = fileURLToPath(
			new URL("../lib/components/mail/attachment-viewer.svelte", import.meta.url),
		);
		const source = readFileSync(componentPath, "utf8");
		expect(source).toContain("sandbox={ATTACHMENT_VIEWER_SANDBOX}");
	});
});

describe("isViewable", () => {
	it("routes images, svg, text, and pdf to the viewer", () => {
		for (const type of [
			"image/png",
			"image/jpeg",
			"image/svg+xml",
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
		for (const type of [
			"application/zip",
			"application/octet-stream",
			"application/msword",
			"video/mp4",
			"audio/mpeg",
			null,
			undefined,
			"",
		]) {
			expect(isViewable(type), String(type)).toBe(false);
		}
	});
});
