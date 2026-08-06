// SPDX-License-Identifier: Apache-2.0
// Client-side attachment scan wrapper. Owns the singleton scan worker, correlates
// responses by id, caches per session, and best-effort persists the verdict so a
// teammate reuses it. The scan is advisory — a persist failure never changes the
// verdict the caller sees.
import type { ScanVerdict } from "@doota/mail-core/attachment-scan";
import { SCANNER_VERSION } from "@doota/mail-core/attachment-scan-rules";
import { recordScanVerdict } from "$lib/rpc/attachment.remote";

export type ScanOutcome = { verdict: ScanVerdict; rule: string | null; sha256: string };
type WorkerResponse = { id: number } & ScanOutcome;

const cache = new Map<string, Promise<ScanOutcome>>();
const pending = new Map<number, (outcome: ScanOutcome) => void>();
let worker: Worker | null = null;
let nextId = 0;

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const { id, ...outcome } = event.data;
			pending.get(id)?.(outcome);
			pending.delete(id);
		};
	}
	return worker;
}

export function scanAttachment(attachmentId: string): Promise<ScanOutcome> {
	// SSR guard — no worker on the server.
	if (typeof Worker === "undefined") {
		return Promise.resolve({ verdict: "error", rule: null, sha256: "" });
	}
	let outcome = cache.get(attachmentId);
	if (!outcome) {
		outcome = run(attachmentId);
		cache.set(attachmentId, outcome);
	}
	return outcome;
}

function run(attachmentId: string): Promise<ScanOutcome> {
	const id = nextId++;
	const done = new Promise<ScanOutcome>((resolve) => {
		pending.set(id, resolve);
		getWorker().postMessage({ id, attachmentId });
	});
	// Best-effort persist — never blocks or alters the returned verdict.
	void done.then((outcome) => {
		void recordScanVerdict({
			attachmentId,
			sha256: outcome.sha256 || undefined,
			verdict: outcome.verdict,
			rule: outcome.rule,
			scannerVersion: SCANNER_VERSION,
		}).catch(() => {});
	});
	return done;
}
