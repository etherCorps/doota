<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- The single subscriber to the mailEvents live stream, mounted once in the app
     layout so realtime works on EVERY route (not just the mail page, which was
     the old owner). Publishes each event to the shared bus for page-level
     consumers, and owns the cross-route reactions: OS-notify on new mail (any
     accessible mailbox, not just the active one) and refresh the unread badge
     when it's the active mailbox's inbox. -->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { mailEvents } from '$lib/rpc/draft.remote.js';
	import { unreadCount } from '$lib/rpc/thread.remote.js';
	import { publishMailEvent } from '$lib/client/mail-events.svelte.js';
	import { unread } from '$lib/client/unread.svelte.js';
	import { osNotify } from '$lib/client/os-notify.svelte.js';
	import { subscribeToPush } from '$lib/client/push.js';

	const live = mailEvents();

	// Re-register the push subscription on load for users who already granted
	// notifications — keeps it fresh (new device, rotated endpoint). Idempotent.
	onMount(() => {
		if (typeof Notification !== 'undefined' && Notification.permission === 'granted') void subscribeToPush();
	});

	async function refreshUnread(mailboxId: string) {
		try {
			unread.count = await unreadCount({ mailboxId });
		} catch {
			// transient — the next event retries
		}
	}

	$effect(() => {
		const evt = live.current;
		if (!evt) return;
		untrack(() => {
			publishMailEvent(evt);
			if (evt.type !== 'inbound') return;
			// Thin event (no subject) — tag by thread so a burst of replies collapses
			// into one notification. No-op when a tab is focused (chirp instead).
			osNotify('New mail', undefined, `inbound-${evt.threadId}`);
			// Badge tracks the active mailbox (single-mailbox switcher model).
			const active = page.url.searchParams.get('mailbox');
			if (active && evt.mailboxId === active) void refreshUnread(active);
		});
	});
</script>
