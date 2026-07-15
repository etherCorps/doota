<script lang="ts">
	import { participant, labels as allLabels, type Thread } from '$lib/mock/index.js';
	import StarIcon from '@lucide/svelte/icons/star';

	let {
		thread,
		active = false,
		onselect
	}: { thread: Thread; active?: boolean; onselect: () => void } = $props();

	const people = $derived(thread.participantIds.map(participant));
	const title = $derived(
		people.length === 1 ? people[0].name : people.map((p) => p.name.split(' ')[0]).join(', ')
	);
	const threadLabels = $derived(allLabels.filter((l) => thread.labelIds.includes(l.id)));
</script>

<button
	type="button"
	onclick={onselect}
	class="flex w-full flex-col gap-1 border-b px-4 py-3 text-left transition-colors
		{active ? 'bg-accent' : 'hover:bg-muted/60'}"
>
	<div class="flex items-center gap-2">
		{#if thread.unread}
			<span class="bg-brand size-2 shrink-0 rounded-full"></span>
		{/if}
		<span class="flex-1 truncate text-sm {thread.unread ? 'font-semibold' : 'font-medium'}">
			{title}
		</span>
		{#if thread.starred}
			<StarIcon class="text-p3 size-3.5 shrink-0 fill-current" />
		{/if}
		<span class="text-faint shrink-0 text-[11px]">{thread.at}</span>
	</div>

	<span class="truncate text-sm {thread.unread ? 'text-foreground' : 'text-muted-foreground'}">
		{thread.subject}
	</span>
	<span class="text-muted-foreground line-clamp-1 text-xs">{thread.snippet}</span>

	{#if threadLabels.length || thread.messageCount > 1}
		<div class="mt-0.5 flex items-center gap-1.5">
			{#each threadLabels as label (label.id)}
				<span class="flex items-center gap-1 text-[10px] text-muted-foreground">
					<span class="size-2 rounded-full" style="background:{label.color}"></span>{label.name}
				</span>
			{/each}
			{#if thread.messageCount > 1}
				<span class="text-faint ml-auto text-[10px]">{thread.messageCount} messages</span>
			{/if}
		</div>
	{/if}
</button>
