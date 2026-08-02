<script lang="ts">
	/* Hallmark · component: notification-bell · pre-emit critique: P4 H5 E4 S5 R4 V4
	 * states: default · hover · focus · active · empty · unread · read · loading */
	// SPDX-License-Identifier: Apache-2.0
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { SvelteSet } from 'svelte/reactivity';
	import BellIcon from '@lucide/svelte/icons/bell';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MailIcon from '@lucide/svelte/icons/mail';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import CheckCheckIcon from '@lucide/svelte/icons/check-check';
	import { resolve } from '$app/paths';
	import { scheduledSends } from '$lib/rpc/draft.remote.js';
	import {
		myNotifications,
		unreadNotificationCount,
		markNotificationRead,
		markAllNotificationsRead
	} from '$lib/rpc/notification.remote.js';
	import { realtime } from '$lib/client/mail-events.svelte.js';
	import { relTime } from '$lib/utils/reltime';
	import { senderLabel } from '$lib/mail/format';

	// In-app notification bell — server-owned durable log (docs/notifications.md).
	// Unread-count model (GitHub/Linear): the badge is the caller's unread count,
	// cleared by reading a row or "Mark all read", not by opening. The count loads
	// on mount + refetches on events (cheap, partial-index); the full feed loads
	// only when the bell opens. Scheduled sends ride along as an info section.

	let open = $state(false);
	const notifsQ = myNotifications({ offset: 0 });
	const scheduledQ = scheduledSends();
	const unreadQ = unreadNotificationCount();

	const notifs = $derived(notifsQ.current ?? []);
	const scheduled = $derived(scheduledQ.current ?? []);
	// Optimistic read: de-bold the row instantly; the badge follows the server
	// count refetch. Cleared implicitly when a refetch brings back readAt.
	const readOverride = new SvelteSet<string>();
	const isUnread = (notification: (typeof notifs)[number]) =>
		!notification.readAt && !readOverride.has(notification.id);
	const unread = $derived(unreadQ.current ?? 0);
	const badge = $derived(unread > 9 ? '9+' : String(unread));

	function onOpenChange(isOpen: boolean) {
		open = isOpen;
		if (!isOpen) return;
		// Fresh feed on open (the only place the full list is fetched); count too, in
		// case reads happened on another device.
		void notifsQ.refresh();
		void unreadQ.refresh();
		void scheduledQ.refresh();
	}

	function onItemClick(id: string, alreadyRead: boolean) {
		open = false;
		if (alreadyRead) return;
		readOverride.add(id); // optimistic de-bold
		void markNotificationRead({ id }).then(() => unreadQ.refresh());
	}

	function markAll() {
		for (const notification of notifs) readOverride.add(notification.id);
		void markAllNotificationsRead().then(() => {
			void unreadQ.refresh();
			if (open) void notifsQ.refresh();
		});
	}

	// Live: refetch only the COUNT (not the feed — that waits for open). new_mail
	// rides `inbound`, send_failed rides a failed `send_state`, and assigned/note
	// get a dedicated `notification` ping — so every type now updates the badge live.
	const FAILED = new Set(['failed', 'bounced_hard', 'bounced_soft', 'complained']);
	$effect(() => {
		void realtime.seq;
		const evt = realtime.event;
		if (!evt) return;
		if (evt.type === 'inbound' || evt.type === 'notification') void unreadQ.refresh();
		else if (evt.type === 'send_state' && FAILED.has(evt.status)) void unreadQ.refresh();
		else void scheduledQ.refresh();
	});

	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	function hrefFor(notification: (typeof notifs)[number]): string {
		if (notification.mailboxId && notification.threadId)
			return `${resolve('/app')}?mailbox=${notification.mailboxId}&thread=${notification.threadId}`;
		if (notification.threadId) return `${resolve('/app')}?thread=${notification.threadId}`;
		return `${resolve('/app')}?folder=sent`;
	}
</script>

<Popover.Root {open} {onOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" class="text-muted-foreground relative" title="Notifications">
				<BellIcon class="size-4" />
				{#if unread > 0}
					<span
						class="bg-brand text-brand-foreground absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums"
					>{badge}</span>
				{/if}
				<span class="sr-only">Notifications{unread > 0 ? ` (${unread} unread)` : ''}</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-80 p-0">
		<div class="flex items-center justify-between border-b px-3 py-2">
			<span class="text-sm font-medium">Notifications</span>
			{#if unread > 0}
				<button
					type="button"
					onclick={markAll}
					class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2"
				>
					<CheckCheckIcon class="size-3.5" /> Mark all read
				</button>
			{/if}
		</div>
		<div class="max-h-96 overflow-y-auto">
			{#if notifs.length === 0 && scheduled.length === 0}
				<div class="text-muted-foreground flex flex-col items-center gap-2 px-3 py-8 text-center">
					<BellIcon class="text-faint size-6" />
					<p class="text-sm">You're all caught up.</p>
				</div>
			{/if}
			{#each notifs as notification (notification.id)}
				{@const uread = isUnread(notification)}
				<a
					href={hrefFor(notification)}
					class="hover:bg-muted/60 flex items-start gap-2 border-b px-3 py-2.5 transition-colors last:border-b-0 {uread ? 'bg-brand/[0.04]' : ''}"
					onclick={() => onItemClick(notification.id, !uread)}
				>
					<!-- Unread indicator: brand dot (transparent when read → no layout shift). -->
					<span class="mt-1.5 size-2 shrink-0 rounded-full {uread ? 'bg-brand' : 'bg-transparent'}"></span>
					{#if notification.type === 'new_mail'}
						<MailIcon class="text-brand mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {uread ? 'font-semibold' : 'font-medium'}">{senderLabel({ from: notification.from, fromName: notification.fromName })}</span>
							<span class="text-muted-foreground block truncate text-xs">New message</span>
						</span>
					{:else if notification.type === 'assigned'}
						<UserRoundIcon class="text-brand mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {uread ? 'font-semibold' : 'font-medium'}">Assigned to you</span>
							<span class="text-muted-foreground block truncate text-xs">{notification.actorName ? `${notification.actorName} assigned this thread` : 'A thread was assigned to you'}</span>
						</span>
					{:else if notification.type === 'note'}
						<StickyNoteIcon class="text-warn mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {uread ? 'font-semibold' : 'font-medium'}">New note</span>
							<span class="text-muted-foreground block truncate text-xs">{notification.actorName ? `${notification.actorName} left a note` : 'A teammate left a note'}</span>
						</span>
					{:else if notification.type === 'mention'}
						<AtSignIcon class="text-brand mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {uread ? 'font-semibold' : 'font-medium'}">You were mentioned</span>
							<span class="text-muted-foreground block truncate text-xs">{notification.actorName ? `${notification.actorName} mentioned you in a note` : 'A teammate mentioned you'}</span>
						</span>
					{:else}
						<AlertCircleIcon class="text-destructive mt-0.5 size-4 shrink-0" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm {uread ? 'font-semibold' : 'font-medium'}">Send failed</span>
							<span class="text-muted-foreground block truncate text-xs">Tap to view the thread</span>
						</span>
					{/if}
					<span class="text-faint shrink-0 text-[11px]" title={when(notification.createdAt)}>{relTime(notification.createdAt)}</span>
				</a>
			{/each}
			{#if scheduled.length}
				<p class="text-faint bg-muted/30 px-3 pt-2 pb-1 text-[11px] font-medium">Scheduled</p>
			{/if}
			{#each scheduled as scheduledSend (scheduledSend.submissionId)}
				<a
					href={`${resolve('/app')}?folder=scheduled`}
					class="hover:bg-muted/60 flex items-start gap-2 border-b px-3 py-2.5 transition-colors last:border-b-0"
					onclick={() => (open = false)}
				>
					<span class="mt-1.5 size-2 shrink-0"></span>
					<ClockIcon class="text-muted-foreground mt-0.5 size-4 shrink-0" />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm">Scheduled: {scheduledSend.subject?.trim() || (scheduledSend.to ? `to ${scheduledSend.to}` : 'message')}</span>
						<span class="text-faint block text-xs">sends {when(scheduledSend.sendAt)}</span>
					</span>
				</a>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
