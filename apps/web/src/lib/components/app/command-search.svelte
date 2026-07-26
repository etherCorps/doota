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
	import HistoryIcon from '@lucide/svelte/icons/history';
	import { recentThreads, pushRecentThread } from '$lib/client/recent-threads';
	import Highlight from '$lib/components/mail/highlight.svelte';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';

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
	// Preserve the current mailbox when jumping to a folder (else it drops to the
	// first mailbox — a surprise auto-switch).
	const folderHref = (id: string) => {
		const sp = new URLSearchParams({ folder: id });
		if (activeMailbox) sp.set('mailbox', activeMailbox);
		return `${resolve('/app')}?${sp}`;
	};
	// Live blind-token search over the user's mailboxes; ≥2 chars to fire.
	// Debounced so a fast typist costs one request, not one per keystroke.
	const dq = new Debounced(() => q.trim(), 250);
	const results = $derived(dq.current.length >= 2 ? searchMail({ q: dq.current, mailboxId: activeMailbox }) : null);

	// Clear the query whenever the palette closes (Esc / outside-click / ⌘K —
	// only `run()` reset it before). Otherwise reopening lands on stale results
	// instead of the browse view (Actions / Refine / Folders).
	$effect(() => {
		if (!open) q = '';
	});

	// iOS keyboard shrinks only the visual viewport — dvh/svh don't track it, so
	// the list's fixed max-h left half the results (and their scroll range)
	// hidden under the keyboard. Cap the list to the room actually visible below
	// its top edge. listRef re-binds when bits-ui re-keys the list, re-running this.
	let listRef = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = listRef;
		if (!open || !el) return;
		const vv = window.visualViewport;
		if (!vv) return;
		const apply = () => {
			const room = vv.height + vv.offsetTop - el.getBoundingClientRect().top - 12;
			el.style.maxHeight = `${Math.max(140, Math.min(288, Math.round(room)))}px`;
		};
		apply();
		vv.addEventListener('resize', apply);
		vv.addEventListener('scroll', apply);
		return () => {
			vv.removeEventListener('resize', apply);
			vv.removeEventListener('scroll', apply);
		};
	});

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

	function openThread(mailboxId: string, threadId: string, meta?: { subject: string | null; from: string | null }) {
		pushRecentThread({ threadId, mailboxId, subject: meta?.subject ?? null, from: meta?.from ?? null });
		const sp = new URLSearchParams({ mailbox: mailboxId, thread: threadId });
		goto(`${resolve('/app')}?${sp}`);
	}
	// Re-read on each palette open (device-local, cheap).
	const recents = $derived(open ? recentThreads() : []);
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
	<Command.Input placeholder="Search — from: to: has:attachment is:unread after:7d…" bind:value={q} />
	<Command.List bind:ref={listRef}>
		{#if q.trim().length < 2}
			{#if recents.length}
				<Command.Group heading="Recent">
					{#each recents.slice(0, 5) as r (r.threadId)}
						<Command.Item value={`recent-${r.threadId}`} onSelect={() => run(() => openThread(r.mailboxId, r.threadId))}>
							<HistoryIcon class="text-muted-foreground size-4 shrink-0" />
							<span class="truncate">{r.subject || '(no subject)'}</span>
						</Command.Item>
					{/each}
				</Command.Group>
				<Command.Separator />
			{/if}
			<Command.Group heading="Actions">
				<Command.Item onSelect={() => run(() => window.dispatchEvent(new CustomEvent('doota:compose')))}>
					<PenLineIcon class="text-muted-foreground size-4" />
					Compose message
				</Command.Item>
				<Command.Item onSelect={() => run(() => window.dispatchEvent(new CustomEvent('doota:shortcuts')))}>
					<KeyboardIcon class="text-muted-foreground size-4" />
					Keyboard shortcuts
					<Command.Shortcut class="font-mono">?</Command.Shortcut>
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
				<Command.Item onSelect={() => (q = 'has:attachment')}>
					<PaperclipIcon class="text-muted-foreground size-4" />
					Has attachment
					<Command.Shortcut class="font-mono">has:attachment</Command.Shortcut>
				</Command.Item>
				<Command.Item onSelect={() => (q = 'is:unread')}>
					<MailOpenIcon class="text-muted-foreground size-4" />
					Unread conversations
					<Command.Shortcut class="font-mono">is:unread</Command.Shortcut>
				</Command.Item>
			</Command.Group>
			<Command.Separator />
			<Command.Group heading="Folders">
				{#each FOLDERS as folder (folder.id)}
					{@const Icon = folder.icon}
					<Command.Item onSelect={() => run(() => goto(folderHref(folder.id)))}>
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
								onSelect={() => run(() => openThread(hit.mailboxId, hit.threadId, { subject: hit.subject, from: hit.from }))}
							>
								<SearchIcon class="text-muted-foreground size-4 shrink-0" />
								<div class="flex min-w-0 flex-col">
									<span class="truncate">
										{#if hit.subject}<Highlight text={hit.subject} terms={hit.terms} />{:else}(no subject){/if}
									</span>
									{#if hit.snippet}<span class="text-muted-foreground truncate text-xs"><Highlight text={hit.snippet} terms={hit.terms} /></span>{/if}
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
