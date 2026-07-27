<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import BellIcon from '@lucide/svelte/icons/bell';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MailIcon from '@lucide/svelte/icons/mail';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import { resolve } from '$app/paths';
	import { scheduledSends } from '$lib/rpc/draft.remote.js';
	import {
		myNotifications,
		markNotificationsSeen,
		markNotificationRead
	} from '$lib/rpc/notification.remote.js';
	import { realtime } from '$lib/client/mail-events.svelte.js';
	import { relTime } from '$lib/utils/reltime';
	import { senderLabel } from '$lib/mail/format';

	// In-app notification bell — server-owned durable log (docs/notifications.md).
	// Read state is cross-device: seenAt (bell opened → dot clears) vs readAt
	// (clicked → bold clears). Scheduled sends ride along as an info section (not a
	// notification type). Live: refetch on the same bus events the feed derives from.

	let open = $state(false);
	const notifsQ = myNotifications({ offset: 0 });
	const scheduledQ = scheduledSends();

	const notifs = $derived(notifsQ.current ?? []);
	const scheduled = $derived(scheduledQ.current ?? []);
	// Dot = something unseen since the bell was last opened; red if a failure is in
	// that set (act on it), else brand.
	const unseen = $derived(notifs.filter((n) => !n.seenAt));
	const dot = $derived(
		unseen.length === 0 ? null : unseen.some((n) => n.type === 'send_failed') ? 'bg-destructive' : 'bg-brand'
	);

	// Opening acknowledges (server-side seen) and re-reads — catches reads done on
	// another device while the bell was closed.
	function onOpenChange(v: boolean) {
		open = v;
		if (!v) return;
		void scheduledQ.refresh();
		// Mark seen first, THEN refetch, so the refreshed feed carries seenAt and the
		// dot clears. No unseen → just refetch (catches reads done on another device).
		if (unseen.length) void markNotificationsSeen().then(() => notifsQ.refresh());
		else void notifsQ.refresh();
	}

	// A click marks the one notification read (optimistic; the href navigates).
	function onItemClick(id: string) {
		open = false;
		void markNotificationRead({ id });
	}

	// Live push (shared bus): inbound ⇒ new_mail, a failed send_state ⇒ send_failed.
	// Assigned has no user-stream event, so it lands on the next open/refresh.
	const FAILED = new Set(['failed', 'bounced_hard', 'bounced_soft', 'complained']);
	$effect(() => {
		void realtime.seq;
		const evt = realtime.event;
		if (!evt) return;
		if (evt.type === 'inbound') {
			void notifsQ.refresh();
		} else if (FAILED.has(evt.status)) {
			void notifsQ.refresh();
		} else {
			void scheduledQ.refresh();
		}
	});

	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	// Link target for a notification row.
	function hrefFor(n: (typeof notifs)[number]): string {
		if (n.mailboxId && n.threadId) return `${resolve('/app')}?mailbox=${n.mailboxId}&thread=${n.threadId}`;
		if (n.threadId) return `${resolve('/app')}?thread=${n.threadId}`;
		return `${resolve('/app')}?folder=sent`;
	}
</script>

<Popover.Root {open} {onOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" class="text-muted-foreground relative" title="Notifications">
				<BellIcon class="size-4" />
				{#if dot}
					<span class="absolute top-1.5 right-1.5 size-2 rounded-full {dot}"></span>
				{/if}
				<span class="sr-only">Notifications</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-80 p-0">
		<div class="border-b px-3 py-2 text-sm font-medium">Notifications</div>
		<div class="max-h-96 overflow-y-auto">
			{#if notifs.length === 0 && scheduled.length === 0}
				<p class="text-muted-foreground px-3 py-6 text-center text-sm">You're all caught up.</p>
			{/if}
			{#each notifs as n (n.id)}
				<a
					href={hrefFor(n)}
					class="hover:bg-muted/60 flex gap-2.5 border-b px-3 py-2.5 last:border-b-0 {n.readAt ? '' : 'bg-brand/[0.03]'}"
					onclick={() => onItemClick(n.id)}
				>
					{#if n.type === 'new_mail'}
						<MailIcon class="text-brand mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {n.readAt ? 'font-medium' : 'font-semibold'}">{senderLabel({ from: n.from, fromName: n.fromName })}</span>
							<span class="text-muted-foreground block truncate text-xs">New message</span>
						</span>
					{:else if n.type === 'assigned'}
						<UserRoundIcon class="text-brand mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {n.readAt ? 'font-medium' : 'font-semibold'}">Assigned to you</span>
							<span class="text-muted-foreground block truncate text-xs">{n.actorName ? `${n.actorName} assigned this thread` : 'A thread was assigned to you'}</span>
						</span>
					{:else if n.type === 'note'}
						<StickyNoteIcon class="text-warn mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {n.readAt ? 'font-medium' : 'font-semibold'}">New note</span>
							<span class="text-muted-foreground block truncate text-xs">{n.actorName ? `${n.actorName} left a note` : 'A teammate left a note'}</span>
						</span>
					{:else}
						<AlertCircleIcon class="text-destructive mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {n.readAt ? 'font-medium' : 'font-semibold'}">Send failed</span>
							<span class="text-muted-foreground block truncate text-xs">Tap to view the thread</span>
						</span>
					{/if}
					<span class="text-faint shrink-0 text-[11px]" title={when(n.createdAt)}>{relTime(n.createdAt)}</span>
				</a>
			{/each}
			{#each scheduled as s (s.submissionId)}
				<a
					href={`${resolve('/app')}?folder=scheduled`}
					class="hover:bg-muted/60 flex gap-2.5 border-b px-3 py-2.5 last:border-b-0"
					onclick={() => (open = false)}
				>
					<ClockIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
					<span class="min-w-0">
						<span class="block truncate text-sm">Scheduled: {s.subject?.trim() || (s.to ? `to ${s.to}` : 'message')}</span>
						<span class="text-faint block text-xs">sends {when(s.sendAt)}</span>
					</span>
				</a>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
