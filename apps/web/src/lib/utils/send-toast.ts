// SPDX-License-Identifier: Apache-2.0
import { toast } from 'svelte-sonner';

type Action = { label: string; onClick: () => void };
type Terminal = { kind: 'success' | 'error' | 'note'; message: string; action?: Action; duration?: number };

/**
 * One toast that carries a whole multi-step operation: a mutable loading line
 * ("Sending… → In queue…") that settles into exactly one terminal state — on
 * the SAME toast, never a second one.
 *
 * Built on toast.promise over an internal deferred, because that's the only
 * sonner mode whose loading toast lives until the work settles. A plain
 * toast.loading expires on the default duration, after which a terminal
 * update with the same id finds nothing and ADDS a fresh toast — the
 * "second toast on sent" bug. The promise's own terminal only carries a
 * message, so action/duration ride a same-type follow-up update (pure
 * in-place merge, no remount).
 */
export function progressToast(initial: string) {
	let settle!: (terminal: Terminal) => void;
	let abort!: (terminal: Terminal) => void;
	const lifecycle = new Promise<Terminal>((resolve, reject) => {
		settle = resolve;
		abort = reject;
	});
	const id = toast.promise(lifecycle, {
		loading: initial,
		success: (terminal) => terminal.message,
		error: (terminal) => (terminal as Terminal).message
	}) as string | number;

	let done = false;
	const finish = (terminal: Terminal) => {
		if (done) return;
		done = true;
		// 'note' settles as success (sonner's promise API knows only
		// success/error); the follow-up below flips it to a neutral toast.
		if (terminal.kind === 'error') abort(terminal);
		else settle(terminal);
		// Runs after sonner's own .then (registered earlier ⇒ runs first), so
		// this merges INTO the terminal toast instead of racing it.
		queueMicrotask(() => {
			const options = { id, action: terminal.action, duration: terminal.duration };
			if (terminal.kind === 'success') toast.success(terminal.message, options);
			else if (terminal.kind === 'error') toast.error(terminal.message, options);
			else toast(terminal.message, options);
		});
	};

	return {
		id,
		/** Swap the loading line in place — call as often as the work has phases.
		 * The huge finite duration defuses a svelte-sonner bug: its `updated`
		 * effect unconditionally re-arms the auto-close timer on ANY in-place
		 * update — even on promise-loading toasts — with the 4s default, which
		 * hid the loading toast mid-flight and let the terminal re-add a second
		 * one. (Not Infinity: browsers coerce setTimeout(…, Infinity) to 0.)
		 * Terminal updates then re-arm the timer with their own real duration. */
		update: (message: string) => {
			if (!done) toast.loading(message, { id, duration: 600_000 });
		},
		success: (message: string, options?: { action?: Action; duration?: number }) =>
			finish({ kind: 'success', message, ...options }),
		/** Neutral terminal (e.g. "Scheduled for …"). */
		note: (message: string, action?: Action, duration?: number) =>
			finish({ kind: 'note', message, action, duration }),
		error: (message: string) => finish({ kind: 'error', message }),
		/** Drop the toast without a terminal. The deferred stays unsettled on
		 * purpose — settling after dismiss would resurrect the toast. */
		dismiss: () => {
			done = true;
			toast.dismiss(id);
		}
	};
}

/** Send-mail preset over progressToast — shared by the reply composer and
 * compose panel so wording + timing stay in lockstep. */
export function sendToast(initial = 'Sending…') {
	const progress = progressToast(initial);
	return {
		id: progress.id,
		/** Draft persisted, delivery request in flight. */
		queued: () => progress.update('In queue — delivering…'),
		/** Terminal: delivered, with an Undo window. */
		sent: (message: string, action: Action, duration: number) =>
			progress.success(message, { action, duration }),
		/** Terminal: neutral note (e.g. scheduled), optional action. */
		note: progress.note,
		/** Terminal: failure. */
		fail: progress.error,
		dismiss: progress.dismiss
	};
}

export type ProgressToast = ReturnType<typeof progressToast>;
