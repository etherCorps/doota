<script lang="ts">
	import * as Command from '$lib/components/ui/command/index.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { folders, threads, participant } from '$lib/mock/index.js';
	import SearchIcon from '@lucide/svelte/icons/search';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			open = !open;
		}
	}

	function run(fn: () => void) {
		open = false;
		fn();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<Command.Dialog bind:open>
	<Command.Input placeholder="Search mail, people, folders…" />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>
		<Command.Group heading="Folders">
			{#each folders as folder (folder.id)}
				<Command.Item onSelect={() => run(() => goto(`${resolve('/app')}?folder=${folder.id}`))}>
					<SearchIcon class="text-muted-foreground size-4" />
					{folder.name}
					{#if folder.count}<Command.Shortcut>{folder.count}</Command.Shortcut>{/if}
				</Command.Item>
			{/each}
		</Command.Group>
		<Command.Separator />
		<Command.Group heading="Conversations">
			{#each threads as thread (thread.id)}
				<Command.Item
					value={thread.subject + ' ' + thread.participantIds.map((id) => participant(id).name).join(' ')}
					onSelect={() => run(() => goto(`${resolve('/app')}?thread=${thread.id}`))}
				>
					<span class="truncate">{thread.subject}</span>
					<Command.Shortcut class="font-mono">
						{participant(thread.participantIds[0]).email}
					</Command.Shortcut>
				</Command.Item>
			{/each}
		</Command.Group>
	</Command.List>
</Command.Dialog>
