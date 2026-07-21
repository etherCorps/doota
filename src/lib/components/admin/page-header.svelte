<script lang="ts">
	import type { Snippet } from 'svelte';

	// Consistent per-tab header: title + optional description, with an optional
	// right-aligned action (button, etc). Shared across the org admin tabs.
	let {
		title,
		description,
		action
	}: { title: string; description?: string; action?: Snippet } = $props();
</script>

<div class="flex flex-wrap items-end justify-between gap-3">
	<div class="flex flex-col gap-0.5">
		<h2 class="font-heading text-lg font-semibold">{title}</h2>
		{#if description}<p class="text-muted-foreground text-sm">{description}</p>{/if}
	</div>
	{#if action}<div class="shrink-0">{@render action()}</div>{/if}
</div>
