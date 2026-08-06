// SPDX-License-Identifier: Apache-2.0
// Which attachment content types the in-house SANDBOXED viewer can render
// (images incl. svg, text/code, pdf). Everything else downloads after the gate.
// Standalone (no Svelte/remote deps) so it's cheap to import + unit-test. Keep in
// sync with the viewer glue's render switch (static/attachment-viewer/viewer.js):
// a type allowed here that the viewer can't draw just shows "can't preview".
export function isViewable(contentType: string | null | undefined): boolean {
	const type = (contentType ?? "").toLowerCase().split(";")[0].trim();
	return (
		type === "application/pdf" ||
		type === "image/svg+xml" ||
		type.startsWith("image/") ||
		type.startsWith("text/") ||
		type === "application/json" ||
		type === "application/xml"
	);
}
