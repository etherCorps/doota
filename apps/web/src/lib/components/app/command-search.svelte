<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Command from '$lib/components/ui/command/index.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { searchMail } from '$lib/rpc/search.remote';
	import { Debounced } from 'runed';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SendIcon from '@lucide/svelte/icons/send';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import StarIcon from '@lucide/svelte/icons/star';
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import ListIcon from '@lucide/svelte/icons/list';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const FOLDERS = [
		{ id: 'inbox', name: 'Inbox', icon: InboxIcon },
		{ id: 'sent', name: 'Sent', icon: SendIcon },
		{ id: 'drafts', name: 'Drafts', icon: FileTextIcon },
		{ id: 'scheduled', name: 'Scheduled', icon: ClockIcon },
		{ id: 'archived', name: 'Archive', icon: ArchiveIcon },
		{ id: 'spam', name: 'Spam', icon: ShieldAlertIcon },
		{ id: 'trash', name: 'Trash', icon: Trash2Icon }
	] as const;

	let q = $state('');
	const activeMailbox = $derived(page.url.searchParams.get('mailbox') ?? undefined);
	// Live blind-token search over the user's mailboxes; ≥2 chars to fire.
	// Debounced so a fast typist costs one request, not one per keystroke.
	const dq = new Debounced(() => q.trim(), 250);
	const results = $derived(dq.current.length >= 2 ? searchMail({ q: dq.current, mailboxId: activeMailbox }) : null);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			open = !open;
		}
	}

	function run(fn: () => void) {
		open = false;
		q = '';
		fn();
	}

	function openThread(mailboxId: string, threadId: string) {
		const sp = new URLSearchParams({ mailbox: mailboxId, thread: threadId });
		goto(`${resolve('/app')}?${sp}`);
	}
</script>

{#snippet searchSkeleton()}
	<!-- Mirrors the hit-row anatomy so results swap in without a size jump. -->
	<div class="space-y-1 px-2 py-1.5" aria-label="Searching…">
		{#each Array.from({ length: 3 }, (_, i) => i) as i (i)}
			<div class="flex items-center gap-2 rounded-md px-2 py-1.5">
				<Skeleton class="size-4 shrink-0 rounded" />
				<div class="min-w-0 flex-1 space-y-1.5">
					<Skeleton class="h-3.5 w-3/4 rounded" />
					<Skeleton class="h-3 w-1/2 rounded" />
				</div>
				<Skeleton class="h-3 w-20 shrink-0 rounded" />
			</div>
		{/each}
	</div>
{/snippet}

<svelte:window onkeydown={handleKeydown} />

<Command.Dialog bind:open shouldFilter={false}>
	<Command.Input placeholder="Search mail — from: to: is:starred work too…" bind:value={q} />
	<Command.List>
		{#if q.trim().length < 2}
			<Command.Group heading="Actions">
				<Command.Item onSelect={() => run(() => window.dispatchEvent(new CustomEvent('doota:compose')))}>
					<PenLineIcon class="text-muted-foreground size-4" />
					Compose message
				</Command.Item>
			</Command.Group>
			<Command.Separator />
			<!-- Refine items seed the query with an operator instead of navigating,
			     so the dialog stays open and the user keeps typing. -->
			<Command.Group heading="Refine">
				<Command.Item onSelect={() => (q = 'is:starred')}>
					<StarIcon class="text-muted-foreground size-4" />
					Starred conversations
					<Command.Shortcut class="font-mono">is:starred</Command.Shortcut>
				</Command.Item>
				<Command.Item onSelect={() => (q = 'from:')}>
					<AtSignIcon class="text-muted-foreground size-4" />
					From sender…
					<Command.Shortcut class="font-mono">from:</Command.Shortcut>
				</Command.Item>
				<Command.Item onSelect={() => (q = 'to:')}>
					<AtSignIcon class="text-muted-foreground size-4" />
					To recipient…
					<Command.Shortcut class="font-mono">to:</Command.Shortcut>
				</Command.Item>
			</Command.Group>
			<Command.Separator />
			<Command.Group heading="Folders">
				{#each FOLDERS as folder (folder.id)}
					{@const Icon = folder.icon}
					<Command.Item onSelect={() => run(() => goto(`${resolve('/app')}?folder=${folder.id}`))}>
						<Icon class="text-muted-foreground size-4" />
						{folder.name}
					</Command.Item>
				{/each}
			</Command.Group>
		{:else if results}
			{#await results}
				<Command.Loading>{@render searchSkeleton()}</Command.Loading>
			{:then hits}
				{#if hits.length}
					<Command.Group heading="Conversations">
						<!-- The palette caps at 20 hits; heavy senders spill into the
						     list pane's full results view. -->
						<Command.Item
							value="__view_all__"
							onSelect={() => {
								const qv = q.trim();
								run(() => goto(`${resolve('/app')}?q=${encodeURIComponent(qv)}`));
							}}
						>
							<ListIcon class="text-muted-foreground size-4" />
							View all results for “{q.trim()}”
						</Command.Item>
						{#each hits as hit (hit.threadId)}
							<Command.Item
								value={hit.threadId}
								onSelect={() => run(() => openThread(hit.mailboxId, hit.threadId))}
							>
								<SearchIcon class="text-muted-foreground size-4 shrink-0" />
								<div class="flex min-w-0 flex-col">
									<span class="truncate">{hit.subject || '(no subject)'}</span>
									{#if hit.snippet}<span class="text-muted-foreground truncate text-xs">{hit.snippet}</span>{/if}
								</div>
								{#if hit.from}<Command.Shortcut class="font-mono">{hit.from}</Command.Shortcut>{/if}
							</Command.Item>
						{/each}
					</Command.Group>
				{:else}
					<Command.Empty>No messages match “{q.trim()}”.</Command.Empty>
				{/if}
			{/await}
		{:else}
			<!-- Debounce window: typed enough, query not fired yet. -->
			<Command.Loading>{@render searchSkeleton()}</Command.Loading>
		{/if}
	</Command.List>
</Command.Dialog>
