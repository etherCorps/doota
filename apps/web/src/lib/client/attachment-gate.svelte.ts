// SPDX-License-Identifier: Apache-2.0
// Click → scan → then act. The shared open/download gate for every attachment
// surface. On open we ensure a verdict (persisted first, else scan), stamp it on
// the tile, and: `clean` downloads straight through; `matched`/`skipped`/`error`
// fail OPEN behind an explicit confirm. The verdict is advisory — it shapes the
// label and the confirm copy, it NEVER blocks (nor authorizes) the download.
import type { ScanVerdict } from "@doota/mail-core/attachment-scan";
import { scanAttachment } from "$lib/client/scan-attachment";
import { attachmentScanState } from "$lib/rpc/attachment.remote";

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
 * Gate an attachment open/download. `download` performs the real action (an
 * anchor click, a lightbox). Returns after the action is taken or the confirm is
 * dismissed. Fail-open: a non-clean verdict asks first, then proceeds if allowed.
 */
export async function openAttachment(
	att: { id: string; filename: string | null },
	download: () => void,
): Promise<void> {
	const verdict = await ensureVerdict(att.id);
	if (verdict === "clean") {
		download();
		return;
	}
	confirm.filename = att.filename ?? "file";
	confirm.verdict = verdict;
	confirm.proceed = download;
	confirm.open = true;
}
