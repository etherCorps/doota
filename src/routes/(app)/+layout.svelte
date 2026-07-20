<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { PersistedState } from 'runed';
	import AppSidebar from '$lib/components/app/app-sidebar.svelte';
	import TopBar from '$lib/components/app/top-bar.svelte';
	import ComposePanel from '$lib/components/mail/compose-panel.svelte';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import { onMount } from 'svelte';

	let { data, children } = $props();

	// Persist the sidebar collapsed state across navigations/reloads (runed).
	const sidebarOpen = new PersistedState('doota:sidebar-open', true);
	let composeOpen = $state(false);

	// ⌘K → "Compose" dispatches this; and a bare `c` composes (Gmail-style).
	onMount(() => {
		const openCompose = () => (composeOpen = true);
		window.addEventListener('doota:compose', openCompose);
		return () => window.removeEventListener('doota:compose', openCompose);
	});
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement;
		if (t?.closest('input, textarea, [contenteditable="true"]')) return;
		composeOpen = true;
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Sidebar.Provider bind:open={sidebarOpen.current}>
	<AppSidebar user={data.user} onCompose={() => (composeOpen = true)} />
	<Sidebar.Inset class="flex h-svh flex-col overflow-hidden">
		<TopBar>
			{#snippet action()}
				<Button size="sm" class="gap-1.5" onclick={() => (composeOpen = true)}>
					<PenLineIcon class="size-4" /> Compose
				</Button>
			{/snippet}
		</TopBar>
		<div class="min-h-0 flex-1 overflow-hidden">
			{@render children()}
		</div>
	</Sidebar.Inset>
</Sidebar.Provider>

<ComposePanel bind:open={composeOpen} />
