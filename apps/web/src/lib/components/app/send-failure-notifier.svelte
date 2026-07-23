<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { failedSends } from '$lib/rpc/draft.remote.js';

	// Failed-send notifier: ticks in the thread view only show on open, so a send
	// that fails after the composer closed would otherwise fail silently. The
	// server streams recent failures (query.live); each is toasted once per
	// device — the localStorage dedupe also absorbs reconnect re-yields.
	// ponytail: device-local seen-set. Move to server-side ack when event
	// subscriptions land and bounces flow through here too.

	const SEEN_KEY = 'doota:failed-send-toasted';
	const live = failedSends();

	function seen(): Set<string> {
		try {
			return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
		} catch {
			return new Set();
		}
	}

	$effect(() => {
		const failures = live.current;
		if (!failures?.length) return;
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
	});
</script>
