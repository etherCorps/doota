// SPDX-License-Identifier: Apache-2.0
// One optimistic-mutation helper. Every optimistic server write routes through
// this so rollback is consistent: snapshot → apply locally → call server →
// restore the snapshot EXACTLY on failure (never a whole-list refetch, which
// loses scroll position and discards other pending optimistic state).
//
// Success does nothing further. Refetch-on-success is a deliberate exception,
// not a habit — only when the server writes state the client cannot predict (a
// server-assigned id/timestamp, an audit-trail entry, a re-sorted list). Do
// that at the call site and comment why; don't bake it in here.
//
// Toasts stay orthogonal: this owns state discipline, not UI. Compose with the
// existing toast helpers at the call site (e.g. surface errors via `onError`).

export interface Optimistic<S> {
	/** Capture exactly what `apply` will change — enough to restore it (R2/R3:
	 *  e.g. the row + its index, or the previous boolean). */
	snapshot: () => S;
	/** Mutate local state IN PLACE so the UI updates immediately. */
	apply: () => void;
	/** The server call. Resolves on success, throws on failure. */
	commit: () => Promise<unknown>;
	/** Put local state back EXACTLY as `snapshot` captured it. */
	rollback: (snap: S) => void;
	/** Surface the failure (toast) — state is already restored when this runs. */
	onError?: (err: unknown) => void;
}

/** Returns true if the server write succeeded, false if it failed (and was
 *  rolled back). Never throws — callers branch on the boolean. */
export async function optimistic<S>(o: Optimistic<S>): Promise<boolean> {
	const snap = o.snapshot();
	o.apply();
	try {
		await o.commit();
		return true;
	} catch (err) {
		o.rollback(snap);
		o.onError?.(err);
		return false;
	}
}
