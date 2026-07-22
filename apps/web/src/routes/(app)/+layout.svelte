<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { PersistedState } from 'runed';
	import AppSidebar from '$lib/components/app/app-sidebar.svelte';
	import EdgeSwipeOpen from '$lib/components/app/edge-swipe-open.svelte';
	import TopBar from '$lib/components/app/top-bar.svelte';
	import ComposePanel from '$lib/components/mail/compose-panel.svelte';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import { onMount } from 'svelte';
	import { compose } from '$lib/client/compose.svelte.js';

	let { data, children } = $props();

	// Persist the sidebar collapsed state across navigations/reloads (runed).
	const sidebarOpen = new PersistedState('doota:sidebar-open', true);

	// Width of the content region (sidebar excluded) — same 56rem line the mail
	// page's @4xl container query uses for its list/thread split. Below it the
	// composer renders as a bottom drawer instead of the docked window.
	let regionW = $state(0);
	const singlePane = $derived(regionW > 0 && regionW < 896);

	// ⌘K → "Compose" dispatches this; and a bare `c` composes (Gmail-style).
	onMount(() => {
		const openCompose = () => compose.start();
		window.addEventListener('doota:compose', openCompose);
		return () => window.removeEventListener('doota:compose', openCompose);
	});
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement;
		if (t?.closest('input, textarea, [contenteditable="true"]')) return;
		compose.start();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Sidebar.Provider bind:open={sidebarOpen.current}>
	<EdgeSwipeOpen />
	<AppSidebar user={data.user} onCompose={() => compose.start()} />
	<Sidebar.Inset class="relative flex h-svh flex-col overflow-hidden">
		<TopBar>
			{#snippet action()}
				<!-- Below `sm` the list pane's floating compose button takes over and the
				     search field gets this width back. -->
				<Button variant="brand" size="sm" class="hidden gap-1.5 sm:inline-flex" onclick={() => compose.start()}>
					<PenLineIcon class="size-4" /> Compose
				</Button>
			{/snippet}
		</TopBar>
		<!-- overflow-y-auto (not hidden): the mail view is h-full and scrolls its own
		     panes, but document-flow pages like /account must scroll here. -->
		<div class="min-h-0 flex-1 overflow-y-auto" bind:clientWidth={regionW}>
			{@render children()}
		</div>

		<!-- Mounted inside the content region so the full-screen composer fills the
		     mail view (beside the sidebar), not the whole viewport. -->
		{#key compose.nonce}
			<ComposePanel
				bind:open={compose.open}
				prefill={compose.prefill as never}
				resumeDraftId={compose.resumeDraftId}
				asDrawer={singlePane}
			/>
		{/key}
	</Sidebar.Inset>
</Sidebar.Provider>
