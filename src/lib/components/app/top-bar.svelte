<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';
	import CommandSearch from './command-search.svelte';
	import SearchIcon from '@lucide/svelte/icons/search';

	let { action }: { action?: import('svelte').Snippet } = $props();

	let searchOpen = $state(false);
</script>

<CommandSearch bind:open={searchOpen} />

<header
	class="bg-background/80 sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-3 backdrop-blur md:px-4"
>
	<Sidebar.Trigger class="text-muted-foreground" />

	<button
		type="button"
		onclick={() => (searchOpen = true)}
		class="text-muted-foreground hover:border-ring/40 flex h-9 max-w-md flex-1 items-center gap-2 rounded-md border bg-card px-3 text-sm transition-colors"
	>
		<SearchIcon class="size-4" />
		<span class="flex-1 text-left">Search</span>
		<Kbd class="hidden sm:inline-flex">⌘K</Kbd>
	</button>

	<div class="ml-auto flex items-center gap-2">
		{@render action?.()}
	</div>
</header>
