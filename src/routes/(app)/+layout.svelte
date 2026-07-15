<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { PersistedState } from 'runed';
	import AppSidebar from '$lib/components/app/app-sidebar.svelte';
	import TopBar from '$lib/components/app/top-bar.svelte';
	import ComposeDialog from '$lib/components/mail/compose-dialog.svelte';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';

	let { data, children } = $props();

	// Persist the sidebar collapsed state across navigations/reloads (runed).
	const sidebarOpen = new PersistedState('doota:sidebar-open', true);
	let composeOpen = $state(false);
</script>

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

<ComposeDialog bind:open={composeOpen} />
