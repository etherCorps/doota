<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';
	import { PersistedState } from 'runed';
	import AppSidebar from '$lib/components/app/app-sidebar.svelte';
	import EdgeSwipeOpen from '$lib/components/app/edge-swipe-open.svelte';
	import SendFailureNotifier from '$lib/components/app/send-failure-notifier.svelte';
	import RealtimeSync from '$lib/components/app/realtime-sync.svelte';
	import TopBar from '$lib/components/app/top-bar.svelte';
	import ComposePanel from '$lib/components/mail/compose-panel.svelte';
	import ShortcutsDialog from '$lib/components/app/shortcuts-dialog.svelte';
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

	// Global keyboard help — opened by `?` or the palette's "Keyboard shortcuts".
	let shortcutsOpen = $state(false);

	// ⌘K → "Compose" dispatches this; a bare `c` composes (Gmail-style); the
	// palette's help action dispatches doota:shortcuts.
	onMount(() => {
		const openCompose = () => compose.start();
		const openShortcuts = () => (shortcutsOpen = true);
		window.addEventListener('doota:compose', openCompose);
		window.addEventListener('doota:shortcuts', openShortcuts);
		return () => {
			window.removeEventListener('doota:compose', openCompose);
			window.removeEventListener('doota:shortcuts', openShortcuts);
		};
	});
	function onKeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement;
		// Never hijack typing or an open dialog/menu (palette, composer, prompts).
		if (t?.closest('input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
		// `?` (Shift+/ on most layouts; e.key resolves it) opens the shortcut help.
		if (e.key === '?') {
			e.preventDefault();
			shortcutsOpen = true;
		} else if (e.key === 'c') {
			compose.start();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<Sidebar.Provider bind:open={sidebarOpen.current}>
	<EdgeSwipeOpen />
	<RealtimeSync />
	<SendFailureNotifier />
	<AppSidebar user={data.user} onCompose={() => compose.start()} />
	<Sidebar.Inset class="relative flex h-svh min-w-0 flex-col overflow-hidden">
		<TopBar>
			{#snippet action()}
				<!-- Below `sm` the list pane's floating compose button takes over and the
				     search field gets this width back. -->
				<Button variant="brand" size="sm" class="hidden gap-1.5 sm:inline-flex" onclick={() => compose.start()}>
					<PenLineIcon class="size-4" /> Compose
					<Kbd class="bg-background/20 text-background hidden lg:inline-flex">C</Kbd>
				</Button>
			{/snippet}
		</TopBar>
		<!-- overflow-y-auto (not hidden): the mail view is h-full and scrolls its own
		     panes, but document-flow pages like /account must scroll here.
		     overscroll-contain: no iOS rubber-band bleeding to the document. -->
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain" bind:clientWidth={regionW}>
			{@render children()}
		</div>

		<!-- Mounted inside the content region so the full-screen composer fills the
		     mail view (beside the sidebar), not the whole viewport. -->
		{#key compose.nonce}
			<ComposePanel
				bind:open={compose.open}
				prefill={compose.prefill as never}
				resumeDraftId={compose.resumeDraftId}
				scheduleAt={compose.scheduleAt}
				asDrawer={singlePane}
			/>
		{/key}
	</Sidebar.Inset>
</Sidebar.Provider>

<ShortcutsDialog bind:open={shortcutsOpen} />
