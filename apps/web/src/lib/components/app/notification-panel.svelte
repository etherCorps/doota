<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import BellIcon from '@lucide/svelte/icons/bell';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { resolve } from '$app/paths';
	import { failedSends, scheduledSends } from '$lib/rpc/draft.remote.js';
	import { recentUnreadMail } from '$lib/rpc/thread.remote.js';
	import { realtime } from '$lib/client/mail-events.svelte.js';
	import { relTime } from '$lib/utils/reltime';
	import { FAILED_SEND_STATUSES } from '@doota/mail-core/mail-thread-contract';

	// In-app notification panel — derived, not stored. Failures + scheduled sends
	// come from the same queries that feed toasts and the Scheduled folder; new
	// mail is the recent-unread inbox set, refreshed live on inbound events over
	// the realtime bus. Nothing is written server-side.
	// ponytail: device-local seen-set; add a notification table when cross-device
	// read-state matters.

	const SEEN_KEY = 'doota:notif-seen';
	const FAILED = new Set<string>(FAILED_SEND_STATUSES);

	let open = $state(false);
	let seenIds = $state<Set<string>>(new Set());
	const failuresQ = failedSends();
	const scheduledQ = scheduledSends();
	const newsQ = recentUnreadMail();

	const senderLabel = (from: string | null, fromName: string | null): string => {
		if (fromName?.trim()) return fromName.trim();
		if (!from) return 'Unknown';
		const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
		return named?.[1]?.trim() || from.split('@')[0] || from;
	};

	onMount(() => {
		try {
			seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
		} catch {
			// corrupt key — treat all as unseen
		}
	});

	const failures = $derived(failuresQ.current ?? []);
	const scheduled = $derived(scheduledQ.current ?? []);
	const news = $derived(newsQ.current ?? []);
	const unseen = $derived(failures.filter((f) => !seenIds.has(f.submissionId)).length);
	// Bell dot: red for a failure to act on, else brand for new mail.
	const dot = $derived(unseen > 0 ? 'bg-destructive' : news.length > 0 ? 'bg-brand' : null);

	// Opening the panel acknowledges failures + re-reads new mail (catches reads
	// done elsewhere while it was closed).
	function onOpenChange(v: boolean) {
		open = v;
		if (!v) return;
		void newsQ.refresh();
		if (!failures.length) return;
		seenIds = new Set([...seenIds, ...failures.map((f) => f.submissionId)]);
		localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds].slice(-200)));
	}

	// Live push (shared bus): a send_state refreshes failures/scheduled; an
	// inbound event refreshes new mail.
	$effect(() => {
		void realtime.seq;
		const evt = realtime.event;
		if (!evt) return;
		if (evt.type === 'inbound') {
			void newsQ.refresh();
		} else if (FAILED.has(evt.status)) {
			void failuresQ.refresh();
		} else {
			void scheduledQ.refresh();
		}
	});

	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
</script>

<Popover.Root {open} {onOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				class="text-muted-foreground relative"
				title="Notifications"
			>
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
			{#if failures.length === 0 && scheduled.length === 0 && news.length === 0}
				<p class="text-muted-foreground px-3 py-6 text-center text-sm">You're all caught up.</p>
			{/if}
			{#each news as n (n.threadId)}
				<a
					href={`${resolve('/app')}?mailbox=${n.mailboxId}&thread=${n.threadId}`}
					class="hover:bg-muted/60 flex gap-2.5 border-b px-3 py-2.5 last:border-b-0"
					onclick={() => (open = false)}
				>
					<MailIcon class="text-brand mt-0.5 size-4 shrink-0" />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{senderLabel(n.from, n.fromName)}</span>
						<span class="text-muted-foreground block truncate text-xs">{n.subject?.trim() || '(no subject)'}</span>
					</span>
					{#if n.at}<span class="text-faint shrink-0 text-[11px]">{relTime(n.at)}</span>{/if}
				</a>
			{/each}
			{#each failures as f (f.submissionId)}
				<a
					href={f.threadId ? `${resolve('/app')}?folder=sent&thread=${f.threadId}` : `${resolve('/app')}?folder=sent`}
					class="hover:bg-muted/60 flex gap-2.5 border-b px-3 py-2.5 last:border-b-0"
					onclick={() => (open = false)}
				>
					<AlertCircleIcon class="text-destructive mt-0.5 size-4 shrink-0" />
					<span class="min-w-0">
						<span class="block truncate text-sm font-medium">
							Send failed: {f.subject?.trim() || (f.to ? `to ${f.to}` : 'message')}
						</span>
						{#if f.reason}
							<span class="text-muted-foreground block truncate text-xs">{f.reason}</span>
						{/if}
						<span class="text-faint block text-xs">{when(f.at)}</span>
					</span>
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
						<span class="block truncate text-sm">
							Scheduled: {s.subject?.trim() || (s.to ? `to ${s.to}` : 'message')}
						</span>
						<span class="text-faint block text-xs">sends {when(s.sendAt)}</span>
					</span>
				</a>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
