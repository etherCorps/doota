<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	let {
		icon: Icon,
		title,
		description,
		action
	}: { icon: Component; title: string; description: string; action?: Snippet } = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
	<div class="bg-brand/10 text-brand ring-brand/15 flex size-14 items-center justify-center rounded-2xl shadow-sm ring-1">
		<Icon class="size-6" />
	</div>
	<div class="space-y-1">
		<p class="font-heading text-base font-semibold">{title}</p>
		<p class="text-muted-foreground max-w-xs text-sm">{description}</p>
	</div>
	{#if action}
		<div class="mt-1">{@render action()}</div>
	{/if}
</div>
