<script lang="ts">
	import { page } from '$app/state';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ThreadListItem from '$lib/components/mail/thread-list-item.svelte';
	import MessageBubble from '$lib/components/mail/message-bubble.svelte';
	import ReplyComposer from '$lib/components/mail/reply-composer.svelte';
	import EmptyState from '$lib/components/mail/empty-state.svelte';
	import {
		threads,
		folders,
		threadMessages,
		participant,
		type Thread
	} from '$lib/mock/index.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	const activeFolder = $derived(page.url.searchParams.get('folder') ?? 'inbox');
	const folder = $derived(folders.find((f) => f.id === activeFolder) ?? folders[0]);
	// Only the inbox is populated in mock data; other folders demo the zero-mail state.
	const folderThreads = $derived(activeFolder === 'inbox' ? threads : []);

	let selectedId = $state<string | null>(page.url.searchParams.get('thread'));
	const selected = $derived<Thread | undefined>(folderThreads.find((t) => t.id === selectedId));
	const conversation = $derived(selected ? threadMessages(selected.id) : []);
	const people = $derived(selected ? selected.participantIds.map(participant) : []);
</script>

<div class="flex h-full">
	<!-- Thread list pane -->
	<div
		class="flex w-full flex-col border-r md:w-[360px] md:shrink-0 {selected
			? 'hidden md:flex'
			: 'flex'}"
	>
		<div class="flex h-12 items-center justify-between border-b px-4">
			<h2 class="font-heading text-sm font-semibold">{folder.name}</h2>
			{#if folderThreads.length}
				<span class="text-faint text-xs">{folderThreads.length} conversations</span>
			{/if}
		</div>
		{#if folderThreads.length}
			<ScrollArea class="flex-1">
				{#each folderThreads as thread (thread.id)}
					<ThreadListItem
						{thread}
						active={selectedId === thread.id}
						onselect={() => (selectedId = thread.id)}
					/>
				{/each}
			</ScrollArea>
		{:else}
			<EmptyState
				icon={InboxIcon}
				title="Nothing here"
				description="This folder is empty. Mail you move here will show up in this list."
			/>
		{/if}
	</div>

	<!-- Conversation pane -->
	<div class="min-w-0 flex-1 flex-col {selected ? 'flex' : 'hidden md:flex'}">
		{#if selected}
			<div class="flex h-12 items-center gap-2 border-b px-3 md:px-4">
				<Button
					variant="ghost"
					size="icon"
					class="text-muted-foreground md:hidden"
					onclick={() => (selectedId = null)}
				>
					<ArrowLeftIcon class="size-4" />
				</Button>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-semibold">{selected.subject}</p>
					<p class="text-muted-foreground truncate font-mono text-xs">
						{people.map((p) => p.email).join(', ')}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					class="text-muted-foreground"
					onclick={() => console.log('TODO: archive')}
				>
					<ArchiveIcon class="size-4" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="text-muted-foreground"
					onclick={() => console.log('TODO: trash')}
				>
					<Trash2Icon class="size-4" />
				</Button>
			</div>

			<ScrollArea class="min-h-0 flex-1">
				<div class="flex flex-col gap-4 p-4 md:p-6">
					{#each conversation as message (message.id)}
						<MessageBubble {message} />
					{/each}
				</div>
			</ScrollArea>

			<ReplyComposer to={people[0].email} />
		{:else}
			<EmptyState
				icon={MessagesSquareIcon}
				title="No conversation selected"
				description="Pick a thread from the list to read it here, or compose a new message."
			/>
		{/if}
	</div>
</div>
