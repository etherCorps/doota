// SPDX-License-Identifier: Apache-2.0
// Attachment scan worker. Runs the yara-x WASM engine off the main thread — a
// 25 MB scan would otherwise lock the tab. Fetches the attachment same-origin
// (session cookie rides along), hashes it, runs the pure engine, posts a verdict.
//
// FAIL-CLOSED on the label: any fetch/init/scan failure posts `error` — NEVER
// `clean`. (The caller may still fail OPEN on the action, behind a confirm.)
import init, { Compiler } from '@virustotal/yara-x';
// Vendored + self-hosted (guide: no CDN, pin + vendor the build). The package's
// exports map doesn't expose the .wasm, so we ship our own copy; Vite emits it
// as a hashed asset the worker fetches once and the browser HTTP-caches.
import wasmUrl from './vendor/yara_x_js_bg.wasm?url';
import { inflateSync } from 'fflate';
import { scanBuffer, type YaraScanner, type ScanResult } from '@doota/mail-core/attachment-scan';
import { DEFAULT_YARA_RULES } from '@doota/mail-core/attachment-scan-rules';

type Request = { id: number; attachmentId: string };
type ScanResponse = { id: number; sha256: string } & ScanResult;

// The zip engine hands us already-declared method + size; method 0 is STORED
// (no compression), everything else is DEFLATE — fflate inflates it.
const inflate = (compressed: Uint8Array, method: number) =>
	method === 0 ? compressed : inflateSync(compressed);

// Compile the ruleset exactly once, lazily, on the first scan. A compile failure
// is remembered so every subsequent scan fails closed without retrying.
let scannerPromise: Promise<YaraScanner> | null = null;
function getScanner(): Promise<YaraScanner> {
	if (!scannerPromise) {
		scannerPromise = (async () => {
			await init(wasmUrl);
			// addSource returns void (not chainable); build the Rules separately.
			const compiler = new Compiler();
			compiler.addSource(DEFAULT_YARA_RULES);
			const rules = compiler.build();
			return {
				scan: (bytes) => {
					const matches: { identifier: string }[] = rules.scan(bytes).matches ?? [];
					return matches.map((match) => match.identifier);
				},
			};
		})();
	}
	return scannerPromise;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (event: MessageEvent<Request>) => {
	const { id, attachmentId } = event.data;
	let sha256 = '';
	try {
		const scanner = await getScanner();
		const res = await fetch(`/api/attachments/${attachmentId}`);
		if (!res.ok) throw new Error(`attachment fetch ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		sha256 = await sha256Hex(bytes);
		const result = scanBuffer(scanner, inflate, bytes, '');
		const response: ScanResponse = { id, sha256, ...result };
		self.postMessage(response);
	} catch {
		// Never `clean` on failure — that is the worst outcome available.
		const response: ScanResponse = { id, sha256, verdict: 'error', rule: null };
		self.postMessage(response);
	}
};
