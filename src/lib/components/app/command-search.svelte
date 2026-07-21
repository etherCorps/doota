<script lang="ts">
	import * as Command from '$lib/components/ui/command/index.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { searchMail } from '$lib/rpc/search.remote';
	import SearchIcon from '@lucide/svelte/icons/search';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SendIcon from '@lucide/svelte/icons/send';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

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
	const results = $derived(q.trim().length >= 2 ? searchMail({ q: q.trim(), mailboxId: activeMailbox }) : null);

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

<svelte:window onkeydown={handleKeydown} />

<Command.Dialog bind:open shouldFilter={false}>
	<Command.Input placeholder="Search mail, or jump to a folder…" bind:value={q} />
	<Command.List>
		{#if q.trim().length < 2}
			<Command.Group heading="Actions">
				<Command.Item onSelect={() => run(() => window.dispatchEvent(new CustomEvent('doota:compose')))}>
					<PenLineIcon class="text-muted-foreground size-4" />
					Compose message
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
				<Command.Loading>Searching…</Command.Loading>
			{:then hits}
				{#if hits.length}
					<Command.Group heading="Conversations">
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
		{/if}
	</Command.List>
</Command.Dialog>
