// SPDX-License-Identifier: Apache-2.0
// Which viewer renders which attachment type. Two shells:
//  - 'base': the opaque hard-isolated viewer (/api/attachment-view): images
//    incl. svg, media, text/code, pdf. The classic exploit vectors (pdf!) stay
//    here, in the strongest sandbox we have.
//  - 'rich': the file-viewer shell (/viewer, same-origin, session-gated):
//    Office, archives, markdown, epub. Weaker isolation (see that route's CSP
//    notes), so only formats the opaque viewer can't render nicely route there.
// Standalone (no Svelte/remote deps) so it's cheap to import + unit-test.

type Shell = "base" | "rich";

// Extensions the file-viewer shell handles beyond the base set. Conservative
// mail-relevant subset of its 208; obscure formats still download fine.
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
	"text/markdown",
]);

// Markdown arrives as text/markdown or (often) text/plain with a .md name. It
// matches text/* so it would route base as flat text, but the rich shell
// renders it formatted, so it must win over the base text branch. Checked first.
function isMarkdown(type: string, ext: string): boolean {
	return type === "text/markdown" || ext === "md" || ext === "markdown";
}

const normalize = (contentType: string | null | undefined) =>
	(contentType ?? "").toLowerCase().split(";")[0].trim();
const extOf = (filename: string | null | undefined) =>
	(filename ?? "").toLowerCase().split(".").pop() ?? "";

/** The shell that renders this attachment, or null to download it. Single
 * source of truth for both the gate (viewable?) and the viewer (which frame?). */
export function viewerFor(
	contentType: string | null | undefined,
	filename?: string | null,
): Shell | null {
	const type = normalize(contentType);
	const ext = extOf(filename);
	// Markdown → rich, ahead of the base text branch below.
	if (isMarkdown(type, ext)) return "rich";
	if (
		type === "application/pdf" ||
		type === "image/svg+xml" ||
		type.startsWith("image/") ||
		type.startsWith("video/") ||
		type.startsWith("audio/") ||
		type.startsWith("text/") ||
		type === "application/json" ||
		type === "application/xml"
	) {
		return "base";
	}
	if (RICH_MIME.has(type) || RICH_EXTENSIONS.has(ext)) return "rich";
	return null;
}

/** True when the opaque viewer renders it (media bytes are inert: the browser
 * decodes them, no script runs, so audio/video are safe here). */
export function isBaseViewable(
	contentType: string | null | undefined,
	filename?: string | null,
): boolean {
	return viewerFor(contentType, filename) === "base";
}

/** Renderable by either viewer (the gate's "preview instead of download"). */
export function isViewable(
	contentType: string | null | undefined,
	filename?: string | null,
): boolean {
	return viewerFor(contentType, filename) !== null;
}
