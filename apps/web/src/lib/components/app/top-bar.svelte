<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';
	import CommandSearch from './command-search.svelte';
	import NotificationPanel from './notification-panel.svelte';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import { toggleMode } from 'mode-watcher';

	let { action }: { action?: import('svelte').Snippet } = $props();

	let searchOpen = $state(false);
</script>

<CommandSearch bind:open={searchOpen} />

<header
	class="bg-background/80 sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-3 backdrop-blur md:px-4"
>
	<!-- Thumb-sized on touch (40px), back to the compact 32px once a pointer exists. -->
	<Sidebar.Trigger
		class="text-muted-foreground size-10 md:size-8 [&_svg:not([class*='size-'])]:size-5 md:[&_svg:not([class*='size-'])]:size-4"
	/>

	<button
		type="button"
		onclick={() => (searchOpen = true)}
		class="text-muted-foreground hover:border-ring/40 flex h-9 max-w-md flex-1 items-center gap-2 rounded-full border bg-card px-3.5 text-sm shadow-xs transition-colors hover:shadow-sm"
	>
		<SearchIcon class="size-4" />
		<span class="flex-1 text-left">Search</span>
		<Kbd class="hidden sm:inline-flex">⌘K</Kbd>
	</button>

	<div class="ml-auto flex items-center gap-2">
		<NotificationPanel />
		<!-- Sun/moon cross-rotate on theme flip; collapses under reduced motion. -->
		<Button variant="ghost" size="icon" class="text-muted-foreground relative" title="Toggle theme" onclick={toggleMode}>
			<SunIcon class="size-4 scale-100 rotate-0 transition-all duration-200 ease-out motion-reduce:transition-none dark:scale-0 dark:-rotate-90" />
			<MoonIcon class="absolute size-4 scale-0 rotate-90 transition-all duration-200 ease-out motion-reduce:transition-none dark:scale-100 dark:rotate-0" />
			<span class="sr-only">Toggle theme</span>
		</Button>
		{@render action?.()}
	</div>
</header>
