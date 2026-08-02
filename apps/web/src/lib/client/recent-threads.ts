// SPDX-License-Identifier: Apache-2.0
// Device-local "recently opened threads" for the command palette's empty state.
// Deliberately localStorage (not server): it's a navigation convenience, and
// per-device recency is actually what you want on shared accounts.

const KEY = 'doota:recent-threads';
const CAP = 8;

export type RecentThread = {
	threadId: string;
	mailboxId: string;
	subject: string | null;
	from: string | null;
	at: number;
};

export function recentThreads(): RecentThread[] {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? '[]') as RecentThread[];
	} catch {
		return [];
	}
}

export function pushRecentThread(t: Omit<RecentThread, 'at'>): void {
	try {
		const list = [{ ...t, at: Date.now() }, ...recentThreads().filter((thread) => thread.threadId !== t.threadId)];
		localStorage.setItem(KEY, JSON.stringify(list.slice(0, CAP)));
	} catch {
		// storage unavailable — feature silently absent
	}
}
