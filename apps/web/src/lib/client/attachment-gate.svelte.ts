// SPDX-License-Identifier: Apache-2.0
// Click → scan → then act. The shared open/download gate for every attachment
// surface. On open we ensure a verdict (persisted first, else scan), stamp it on
// the tile, and: `clean` downloads straight through; `matched`/`skipped`/`error`
// fail OPEN behind an explicit confirm. The verdict is advisory — it shapes the
// label and the confirm copy, it NEVER blocks (nor authorizes) the download.
import { SvelteMap } from "svelte/reactivity";
import type { ScanVerdict } from "@doota/mail-core/attachment-scan";
import { SCANNER_VERSION } from "@doota/mail-core/attachment-scan-rules";
import { scanAttachment } from "$lib/client/scan-attachment";
import { attachmentScanState } from "$lib/rpc/attachment.remote";
import { isViewable } from "$lib/client/attachment-viewable";
import { sanitizeFilename } from "$lib/utils/filename";

export type TileVerdict = "checking" | ScanVerdict | null;

// Per-session verdict cache the tiles read to paint their indicator, and the
// gate reuses so a re-open never rescans. Keyed by attachment id. SvelteMap,
// NOT $state(new Map()) — $state doesn't proxy Map mutations, so .set() would
// never repaint the tiles (found live: badges stayed blank while the gate ran).
const verdicts = new SvelteMap<string, TileVerdict>();

export function tileVerdict(attachmentId: string): TileVerdict {
	return verdicts.get(attachmentId) ?? null;
}

// The one confirm dialog, rendered once by <AttachmentGate/>. When `open`, the
// footer's Download runs `proceed`.
export const confirm = $state({
	open: false,
	filename: "",
	verdict: "error" as ScanVerdict,
	// The dialog's verb must match what proceed() actually does: open the
	// sandboxed preview, or download. Lying "Download anyway" over a preview
	// action would misstate the very consent being asked for.
	willView: false,
	proceed: () => {},
});

// The one sandboxed viewer, rendered once by <AttachmentGate/>. Only ever opened
// from inside the gate AFTER a verdict (see openAttachment) — there is no code
// path that reaches it without a scan having run.
export const viewer = $state({
	open: false,
	id: "",
	filename: "",
	contentType: "",
});

function openViewer(att: { id: string; filename: string | null; contentType: string | null }) {
	viewer.id = att.id;
	viewer.filename = sanitizeFilename(att.filename); // strip bidi-override spoofing
	viewer.contentType = att.contentType ?? "";
	viewer.open = true;
}

const CONFIRM_COPY: Record<Exclude<ScanVerdict, "clean">, string> = {
	matched: "A threat was found in this file.",
	skipped: "This file couldn't be checked against known threat patterns.",
	error: "This file couldn't be checked against known threat patterns.",
};

export function confirmMessage(verdict: ScanVerdict, willView: boolean): string {
	if (verdict === "clean") return "";
	return `${CONFIRM_COPY[verdict]} ${willView ? "Preview" : "Download"} anyway?`;
}

// One in-flight check per attachment: a second click while scanning awaits the
// SAME promise instead of kicking off a duplicate fetch + rescan (the old
// `known === "checking"` early state fell through and rescanned).
const inflight = new Map<string, Promise<ScanVerdict>>();

function ensureVerdict(attachmentId: string): Promise<ScanVerdict> {
	const known = verdicts.get(attachmentId);
	if (known && known !== "checking") return Promise.resolve(known);
	const pending = inflight.get(attachmentId);
	if (pending) return pending;

	verdicts.set(attachmentId, "checking");
	const run = (async () => {
		// A persisted verdict (ours or a teammate's) wins — no rescan. But only
		// from the CURRENT ruleset: a rules bump (e.g. the /OpenAction
		// false-positive fix) must invalidate stale verdicts, else a bad verdict
		// is cached forever.
		const persisted = await attachmentScanState({ attachmentId }).catch(() => null);
		if (persisted?.verdict && persisted.scannerVersion === SCANNER_VERSION) {
			verdicts.set(attachmentId, persisted.verdict);
			return persisted.verdict;
		}
		const { verdict } = await scanAttachment(attachmentId);
		verdicts.set(attachmentId, verdict);
		return verdict;
	})().finally(() => inflight.delete(attachmentId));
	inflight.set(attachmentId, run);
	return run;
}

/**
 * Eagerly start the check the moment an attachment becomes visible (thread
 * open), so the verdict is usually ready before the user clicks. Fire-and-
 * forget; dedupes with any in-flight or persisted check. Never throws.
 */
export function prefetchVerdict(attachmentId: string): void {
	void ensureVerdict(attachmentId).catch(() => {
		// Prefetch failure is not an outcome — the click path retries and the
		// tile shows "couldn't check" only from a real scan result.
		verdicts.delete(attachmentId);
	});
}

/**
 * Gate an attachment open/download. Scans first (persisted verdict wins), then
 * acts. For a VIEWABLE type (image/text/pdf/svg — see isViewable) the action is
 * to OPEN THE SANDBOXED VIEWER; otherwise it downloads via `download`. Either way
 * the act happens only AFTER a verdict: a `clean` verdict proceeds straight
 * through; a non-clean verdict fails OPEN behind the confirm. The viewer is
 * unreachable without a verdict — that is the security invariant.
 *
 * `att.contentType` decides viewable-vs-download. Callers that pass no
 * contentType (or a non-viewable one) get the download-after-gate behavior, so
 * existing download-only call sites are unchanged.
 */
// Clicks already inside the gate for an attachment are swallowed — the tile
// shows "checking" and the FIRST click's action fires once the verdict lands.
// Without this, a dead-feeling wait invites double-clicks → double downloads.
const gating = new Set<string>();

export async function openAttachment(
	att: { id: string; filename: string | null; contentType?: string | null },
	download: () => void,
): Promise<void> {
	if (gating.has(att.id)) return;
	gating.add(att.id);
	try {
		const willView = isViewable(att.contentType, att.filename);
		const act = willView
			? () => openViewer({ id: att.id, filename: att.filename, contentType: att.contentType ?? null })
			: download;
		const verdict = await ensureVerdict(att.id);
		if (verdict === "clean") {
			act();
			return;
		}
		confirm.filename = sanitizeFilename(att.filename); // strip bidi-override spoofing
		confirm.verdict = verdict;
		confirm.willView = willView;
		confirm.proceed = act;
		confirm.open = true;
	} finally {
		gating.delete(att.id);
	}
}

/**
 * Gate a DOWNLOAD explicitly — same scan-then-act flow, but never routes to the
 * viewer (openAttachment view-routes by type/extension, which silently turned
 * the lightbox's own Download button back into "open the viewer"; found live).
 */
export async function downloadAttachment(
	att: { id: string; filename: string | null },
	trigger: () => void,
): Promise<void> {
	if (gating.has(att.id)) return;
	gating.add(att.id);
	try {
		const verdict = await ensureVerdict(att.id);
		if (verdict === "clean") {
			trigger();
			return;
		}
		confirm.filename = sanitizeFilename(att.filename);
		confirm.verdict = verdict;
		confirm.willView = false;
		confirm.proceed = trigger;
		confirm.open = true;
	} finally {
		gating.delete(att.id);
	}
}
