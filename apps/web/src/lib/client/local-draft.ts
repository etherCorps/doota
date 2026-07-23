// Crash buffer for composer text. Written synchronously on every edit, cleared
// the moment the server acks an autosave — so a mirror's presence means
// "content the server hasn't seen yet". Survives tab kill / crash / offline,
// the exact gaps the 800ms debounced autosave leaves open. The server draft
// remains the durable, cross-device copy.
// ponytail: localStorage on purpose — synchronous write beats IndexedDB/OPFS
// at tab-kill for KB-sized text; swap here if a PWA offline store ever lands.

const PREFIX = 'doota:draft:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type LocalDraft = {
	at: number;
	body?: string;
	subject?: string;
	to?: string[];
	cc?: string[];
	bcc?: string[];
};

export function mirrorDraft(key: string, data: Omit<LocalDraft, 'at'>) {
	try {
		localStorage.setItem(PREFIX + key, JSON.stringify({ ...data, at: Date.now() }));
	} catch {
		// quota / private mode — the debounced server autosave still covers
	}
}

export function readMirror(key: string): LocalDraft | null {
	try {
		const raw = localStorage.getItem(PREFIX + key);
		if (!raw) return null;
		const d = JSON.parse(raw) as LocalDraft;
		return Date.now() - d.at < MAX_AGE_MS ? d : null;
	} catch {
		return null;
	}
}

export function clearMirror(key: string) {
	try {
		localStorage.removeItem(PREFIX + key);
	} catch {
		// nothing to do
	}
}

// Drop abandoned mirrors so the prefix doesn't accumulate forever.
let swept = false;
export function sweepMirrors() {
	if (swept) return;
	swept = true;
	try {
		const dead: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (!k?.startsWith(PREFIX)) continue;
			try {
				const d = JSON.parse(localStorage.getItem(k) ?? '') as LocalDraft;
				if (Date.now() - d.at >= MAX_AGE_MS) dead.push(k);
			} catch {
				dead.push(k);
			}
		}
		for (const k of dead) localStorage.removeItem(k);
	} catch {
		// storage unavailable — nothing to sweep
	}
}
