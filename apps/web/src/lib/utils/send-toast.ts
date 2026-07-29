// SPDX-License-Identifier: Apache-2.0
import { toast } from 'svelte-sonner';

type Action = { label: string; onClick: () => void };

/**
 * One toast that morphs through the send lifecycle on a single id — updating in
 * place (no dismiss/re-add flash) so "Sending… → Queued… → Sent" reads as one
 * continuous acknowledgement, and sonner tweens the content swap for us. Shared
 * by the reply composer and compose panel so wording + timing stay in lockstep.
 */
export function sendToast(initial = 'Sending…') {
	const id = toast.loading(initial);
	return {
		id,
		/** Draft persisted, delivery request in flight. */
		queued: () => toast.loading('Queued — delivering…', { id }),
		/** Terminal: delivered, with an Undo window. */
		sent: (message: string, action: Action, duration: number) =>
			toast.success(message, { id, duration, action }),
		/** Terminal: neutral note (e.g. scheduled), optional action. */
		note: (message: string, action?: Action) => toast(message, { id, action }),
		/** Terminal: failure. */
		fail: (message: string) => toast.error(message, { id }),
		dismiss: () => toast.dismiss(id)
	};
}
