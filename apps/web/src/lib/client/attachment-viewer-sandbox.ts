// SPDX-License-Identifier: Apache-2.0
// The iframe sandbox tokens for the attachment viewer, in ONE place so the
// component attribute, the CSP `sandbox` header, and the test all agree.
//
// allow-scripts WITHOUT allow-same-origin: the two together defeat the sandbox
// (the doc could reach into its own origin and strip the sandbox to escape).
// Without allow-same-origin the framed doc gets an OPAQUE origin — no access to
// the app's cookies, DOM, or storage. This viewer renders ATTACKER-CONTROLLED
// documents; the isolation is load-bearing. Do NOT add allow-same-origin.
//
// No allow-forms / allow-popups / allow-top-navigation either — the viewer only
// renders; it never navigates or submits. Bytes arrive via postMessage and the
// CSP is connect-src 'none', so it can't phone home.
export const ATTACHMENT_VIEWER_SANDBOX = "allow-scripts";

// The RICH viewer (file-viewer shell, /viewer) frame ADDS allow-same-origin —
// required for its renderer Workers/WASM, which an opaque origin cannot load.
// This is DELIBERATELY weaker isolation than the opaque viewer: the compensating
// controls live in the /viewer route's CSP (scripts pinned to 'self', connect-src
// path-scoped to the asset tree so /api/* is unreachable) and the scan gate in
// front of it. Only rich-only formats (Office/archives/…) ride this frame; pdf/
// images/text stay on ATTACHMENT_VIEWER_SANDBOX.
// allow-downloads: the archive entry preview has its own per-entry "Download
// file" (blob anchor inside the frame) — without the token the click is
// silently swallowed (found live).
export const RICH_VIEWER_SANDBOX = "allow-scripts allow-same-origin allow-downloads";
