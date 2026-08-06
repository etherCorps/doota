// SPDX-License-Identifier: Apache-2.0
// Click → scan → then act. The shared open/download gate for every attachment
// surface. On open we ensure a verdict (persisted first, else scan), stamp it on
// the tile, and: `clean` downloads straight through; `matched`/`skipped`/`error`
// fail OPEN behind an explicit confirm. The verdict is advisory — it shapes the
// label and the confirm copy, it NEVER blocks (nor authorizes) the download.
import type { ScanVerdict } from "@doota/mail-core/attachment-scan";
import { scanAttachment } from "$lib/client/scan-attachment";
import { attachmentScanState } from "$lib/rpc/attachment.remote";
import { isViewable } from "$lib/client/attachment-viewable";

export type TileVerdict = "checking" | ScanVerdict | null;

// Per-session verdict cache the tiles read to paint their indicator, and the
// gate reuses so a re-open never rescans. Keyed by attachment id.
const verdicts = $state(new Map<string, TileVerdict>());

export function tileVerdict(attachmentId: string): TileVerdict {
	return verdicts.get(attachmentId) ?? null;
}

// The one confirm dialog, rendered once by <AttachmentGate/>. When `open`, the
// footer's Download runs `proceed`.
export const confirm = $state({
	open: false,
	filename: "",
	verdict: "error" as ScanVerdict,
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
	viewer.filename = att.filename ?? "file";
	viewer.contentType = att.contentType ?? "";
	viewer.open = true;
}

const CONFIRM_COPY: Record<Exclude<ScanVerdict, "clean">, string> = {
	matched: "This file matched a known threat pattern.",
	skipped: "This file couldn't be checked against known threat patterns.",
	error: "This file couldn't be checked against known threat patterns.",
};

export function confirmMessage(verdict: ScanVerdict): string {
	return verdict === "clean" ? "" : `${CONFIRM_COPY[verdict]} Download anyway?`;
}

async function ensureVerdict(attachmentId: string): Promise<ScanVerdict> {
	const known = verdicts.get(attachmentId);
	if (known && known !== "checking") return known;

	verdicts.set(attachmentId, "checking");
	// A persisted verdict (ours or a teammate's) wins — no rescan.
	const persisted = await attachmentScanState({ attachmentId }).catch(() => null);
	if (persisted?.verdict) {
		verdicts.set(attachmentId, persisted.verdict);
		return persisted.verdict;
	}
	const { verdict } = await scanAttachment(attachmentId);
	verdicts.set(attachmentId, verdict);
	return verdict;
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
export async function openAttachment(
	att: { id: string; filename: string | null; contentType?: string | null },
	download: () => void,
): Promise<void> {
	const act = isViewable(att.contentType)
		? () => openViewer({ id: att.id, filename: att.filename, contentType: att.contentType ?? null })
		: download;
	const verdict = await ensureVerdict(att.id);
	if (verdict === "clean") {
		act();
		return;
	}
	confirm.filename = att.filename ?? "file";
	confirm.verdict = verdict;
	confirm.proceed = act;
	confirm.open = true;
}
