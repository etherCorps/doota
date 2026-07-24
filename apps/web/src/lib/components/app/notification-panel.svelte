<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import BellIcon from '@lucide/svelte/icons/bell';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import { resolve } from '$app/paths';
	import { failedSends, scheduledSends, mailEvents } from '$lib/rpc/draft.remote.js';
	import { FAILED_SEND_STATUSES } from '@doota/mail-core/mail-thread-contract';

	// In-app notification panel — derived, not stored. Failures (last 7d) and
	// pending scheduled sends come from the same queries that feed toasts and the
	// Scheduled folder; nothing is written server-side. New mail is deliberately
	// absent: the inbox badge/list IS that notification.
	// ponytail: device-local seen-set; add a notification table when cross-device
	// read-state matters.

	const SEEN_KEY = 'doota:notif-seen';
	const FAILED = new Set<string>(FAILED_SEND_STATUSES);

	let open = $state(false);
	let seenIds = $state<Set<string>>(new Set());
	const failuresQ = failedSends();
	const scheduledQ = scheduledSends();
	const live = mailEvents();

	onMount(() => {
		try {
			seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'));
		} catch {
			// corrupt key — treat all as unseen
		}
	});

	const failures = $derived(failuresQ.current ?? []);
	const scheduled = $derived(scheduledQ.current ?? []);
	const unseen = $derived(failures.filter((f) => !seenIds.has(f.submissionId)).length);

	// Opening the panel acknowledges everything currently listed.
	function onOpenChange(v: boolean) {
		open = v;
		if (!v || !failures.length) return;
		seenIds = new Set([...seenIds, ...failures.map((f) => f.submissionId)]);
		localStorage.setItem(SEEN_KEY, JSON.stringify([...seenIds].slice(-200)));
	}

	// Live push: a failure refreshes the list; scheduled leaving the queue
	// (sent or canceled) refreshes the other.
	$effect(() => {
		const evt = live.current;
		if (evt?.type !== 'send_state') return;
		if (FAILED.has(evt.status)) void failuresQ.refresh();
		else void scheduledQ.refresh();
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
				{#if unseen > 0}
					<span class="bg-destructive absolute top-1.5 right-1.5 size-2 rounded-full"></span>
				{/if}
				<span class="sr-only">Notifications</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-80 p-0">
		<div class="border-b px-3 py-2 text-sm font-medium">Notifications</div>
		<div class="max-h-96 overflow-y-auto">
			{#if failures.length === 0 && scheduled.length === 0}
				<p class="text-muted-foreground px-3 py-6 text-center text-sm">You're all caught up.</p>
			{/if}
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
