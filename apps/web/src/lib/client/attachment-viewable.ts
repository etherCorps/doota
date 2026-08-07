// SPDX-License-Identifier: Apache-2.0
// Which attachment types the viewers can render, in two tiers:
//  - BASE: the OPAQUE hard-isolated viewer (/api/attachment-view) — images
//    incl. svg, text/code, pdf. The classic exploit vectors (pdf!) stay here,
//    in the strongest sandbox we have.
//  - RICH: the file-viewer shell (/viewer — same-origin, session-gated) adds
//    Office, archives, markdown, epub. Weaker isolation (see that route's CSP
//    notes), so ONLY formats the opaque viewer can't draw route there.
// Standalone (no Svelte/remote deps) so it's cheap to import + unit-test.

// Extensions the file-viewer shell handles beyond the base set. Conservative
// mail-relevant subset of its 208 — obscure formats still download fine.
const RICH_EXTENSIONS = new Set([
	"doc", "docx", "rtf", "odt",
	"xls", "xlsx", "ods", "csv",
	"ppt", "pptx", "odp",
	"md", "markdown",
	"zip", "tar", "gz", "7z", "rar",
	"epub",
]);

const RICH_MIME = new Set([
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/rtf",
	"application/zip",
	"application/x-zip-compressed",
	"application/x-7z-compressed",
	"application/x-rar-compressed",
	"application/x-tar",
	"application/gzip",
	"application/epub+zip",
]);

const normalize = (contentType: string | null | undefined) =>
	(contentType ?? "").toLowerCase().split(";")[0].trim();

/** Renderable by the opaque hard-isolated viewer. */
export function isBaseViewable(contentType: string | null | undefined): boolean {
	const type = normalize(contentType);
	return (
		type === "application/pdf" ||
		type === "image/svg+xml" ||
		type.startsWith("image/") ||
		type.startsWith("text/") ||
		type === "application/json" ||
		type === "application/xml"
	);
}

/** Renderable by either viewer (the gate's "preview instead of download"). */
export function isViewable(
	contentType: string | null | undefined,
	filename?: string | null,
): boolean {
	if (isBaseViewable(contentType)) return true;
	if (RICH_MIME.has(normalize(contentType))) return true;
	const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
	return RICH_EXTENSIONS.has(ext);
}
