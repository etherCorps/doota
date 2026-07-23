<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { failedSends } from '$lib/rpc/draft.remote.js';

	// Failed-send notifier: ticks in the thread view only show on open, so a send
	// that fails after the composer closed would otherwise fail silently. Polls the
	// user's recent failed submissions and toasts each once per device.
	// ponytail: localStorage dedupe + 90s polling. Move to server-side ack + push
	// (event subscriptions) when live tick updates land.

	const SEEN_KEY = 'doota:failed-send-toasted';
	const POLL_MS = 90_000;

	function seen(): Set<string> {
		try {
			return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
		} catch {
			return new Set();
		}
	}

	async function check() {
		if (document.hidden) return;
		try {
			const failures = await failedSends();
			if (!failures.length) return;
			const s = seen();
			for (const f of failures) {
				if (s.has(f.submissionId)) continue;
				s.add(f.submissionId);
				const label = f.subject?.trim() || (f.to ? `to ${f.to}` : 'message');
				toast.error(`Send failed: ${label}`, {
					description: f.reason ?? 'Unknown error',
					duration: 10_000
				});
			}
			// Cap the remembered set so the key doesn't grow forever.
			localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-200)));
		} catch {
			// Offline / transient — next poll retries.
		}
	}

	onMount(() => {
		void check();
		const id = setInterval(() => void check(), POLL_MS);
		return () => clearInterval(id);
	});
</script>
