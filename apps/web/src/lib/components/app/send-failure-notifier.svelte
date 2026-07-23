<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { FAILED_SEND_STATUSES } from '@doota/mail-core/mail-thread-contract';
	import { failedSends, mailEvents } from '$lib/rpc/draft.remote.js';

	// Failed-send notifier: ticks in the thread view only show on open, so a send
	// that fails after the composer closed — or bounces hours later — would
	// otherwise fail silently. Reacts to live send-state events (MailEventHub
	// push); each failure toasts once per device. The catch-up read on mount
	// covers failures that happened while no client was connected.
	// ponytail: device-local seen-set; server-side ack if multi-device dupes bite.

	const SEEN_KEY = 'doota:failed-send-toasted';
	const FAILED = new Set<string>(FAILED_SEND_STATUSES);
	const live = mailEvents();

	function seen(): Set<string> {
		try {
			return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
		} catch {
			return new Set();
		}
	}

	async function toastUnseen() {
		try {
			const failures = await failedSends();
			if (!failures.length) return;
			const s = seen();
			let added = false;
			for (const f of failures) {
				if (s.has(f.submissionId)) continue;
				s.add(f.submissionId);
				added = true;
				const label = f.subject?.trim() || (f.to ? `to ${f.to}` : 'message');
				toast.error(`Send failed: ${label}`, {
					description: f.reason ?? 'Unknown error',
					duration: 10_000
				});
			}
			// Cap the remembered set so the key doesn't grow forever.
			if (added) localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-200)));
		} catch {
			// Offline / transient — the next event or reload retries.
		}
	}

	onMount(() => void toastUnseen());

	$effect(() => {
		const evt = live.current;
		if (evt?.type === 'send_state' && FAILED.has(evt.status)) void toastUnseen();
	});
</script>
