<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { PersistedState } from 'runed';
	import AppSidebar from '$lib/components/app/app-sidebar.svelte';
	import SendFailureNotifier from '$lib/components/app/send-failure-notifier.svelte';
	import RealtimeSync from '$lib/components/app/realtime-sync.svelte';
	import TopBar from '$lib/components/app/top-bar.svelte';
	import ComposePanel from '$lib/components/mail/compose-panel.svelte';
	import ShortcutsDialog from '$lib/components/app/shortcuts-dialog.svelte';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import XIcon from '@lucide/svelte/icons/x';
	import { network } from '$lib/client/online.svelte.js';
	import { appViewport } from '$lib/client/app-viewport.svelte.js';
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { compose } from '$lib/client/compose.svelte.js';

	let { data, children } = $props();

	// Persist the sidebar collapsed state across navigations/reloads (runed).
	const sidebarOpen = new PersistedState('doota:sidebar-open', true);

	// Width of the content region (sidebar excluded) — same 56rem line the mail
	// page's @4xl container query uses for its list/thread split. Below it the
	// composer is a real page (/app/compose): a document-flow route the mobile
	// keyboard can't break — iOS scrolling to a focused input is then correct
	// behavior on a normal page, not a fixed-overlay fight. Back gesture closes
	// it natively (no history-entry mirroring).
	let regionW = $state(0);
	const singlePane = $derived(regionW > 0 && regionW < 896);

	// Route every single-pane compose to the page. compose.start() keeps setting
	// the store (prefill/resumeDraftId/scheduleAt) — the page reads it on mount.
	$effect(() => {
		if (!compose.open || !singlePane) return;
		untrack(() => {
			compose.open = false; // the page is the surface; the panel never mounts
			void goto(resolve('/app/compose'));
		});
	});

	// Org 2FA grace nudge — shown when this member's org now requires 2FA and
	// they're still inside the grace window (deadline ms from hooks.server.ts).
	// Dismissible per session so it stops nagging after they've seen it — except
	// inside the final 48h, when the hard block is imminent and hiding the
	// deadline would be worse than the nag (the X is hidden then too).
	let enroll2faDismissed = $state(false);
	const enroll2faBy = $derived(data.enroll2faBy as number | null);
	const enroll2faUrgent = $derived(
		enroll2faBy != null && enroll2faBy - Date.now() < 48 * 60 * 60 * 1000
	);
	const enroll2faDeadline = $derived(
		enroll2faBy ? new Date(enroll2faBy).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
	);
	onMount(() => {
		if (sessionStorage.getItem('doota:enroll2fa-dismissed')) enroll2faDismissed = true;
		// The one keyboard/viewport controller — the shell height below reads it.
		return appViewport.attach();
	});
	function dismissEnroll2fa() {
		enroll2faDismissed = true;
		sessionStorage.setItem('doota:enroll2fa-dismissed', '1');
	}

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

<!-- Provider wrapper is min-h-svh, and svh is keyboard-blind on iOS: with the
     keyboard up the DOCUMENT stays taller than the visual viewport even though
     the Inset below shrinks — so iOS scrolls the document to chase the caret
     and the whole frame slides under the sticky TopBar (reply composer
     "disappears while typing"). Pin the wrapper to the visible viewport too:
     document == viewport == nothing to scroll. -->
<Sidebar.Provider
	bind:open={sidebarOpen.current}
	style={appViewport.height > 0 ? `height:${appViewport.height}px;min-height:0` : undefined}
>
	<RealtimeSync />
	<SendFailureNotifier />
	<AppSidebar user={data.user} onCompose={() => compose.start()} />
	<!-- Sized to the VISIBLE viewport (appViewport), falling back to h-svh before
	     the first measure. On iOS the keyboard shrinks this frame, so anything at
	     the bottom of the column (the reply bar) sits exactly above the keyboard
	     — no per-component keyboard math anywhere. -->
	<Sidebar.Inset
		class="relative flex h-svh min-w-0 flex-col overflow-hidden"
		style={appViewport.height > 0 ? `height:${appViewport.height}px` : undefined}
	>
		<TopBar>
			{#snippet action()}
				<!-- Below `sm` the list pane's floating compose button takes over and the
				     search field gets this width back. -->
				<Button
					variant="brand"
					size="sm"
					class="hidden gap-1.5 sm:inline-flex"
					disabled={network.offline}
					title={network.offline ? "You're offline — sending needs a connection" : undefined}
					onclick={() => compose.start()}
				>
					<PenLineIcon class="size-4" /> Compose
				</Button>
			{/snippet}
		</TopBar>
		{#if network.offline}
			<div
				role="status"
				class="bg-muted text-muted-foreground flex items-center gap-2 border-b px-4 py-1.5 text-xs"
			>
				<CloudOffIcon class="size-3.5 shrink-0" />
				<span class="min-w-0 flex-1"
					>You're offline. Reading works from this device; sending, search, and new mail resume when you
					reconnect.</span
				>
			</div>
		{/if}
		{#if enroll2faBy && (!enroll2faDismissed || enroll2faUrgent)}
			<div
				role="status"
				class="border-warn/40 bg-warn/10 text-foreground flex items-start gap-2 border-b px-4 py-2 text-sm"
			>
				<ShieldAlertIcon class="text-warn mt-0.5 size-4 shrink-0" />
				<p class="min-w-0 flex-1">
					Your organization now requires two-factor authentication. Enable it by
					<span class="font-medium">{enroll2faDeadline}</span> —
					<a href="/account/security" class="text-brand underline underline-offset-2">set it up now</a>.
				</p>
				{#if !enroll2faUrgent}
					<button
						type="button"
						onclick={dismissEnroll2fa}
						aria-label="Dismiss"
						class="text-muted-foreground hover:text-foreground -m-1 shrink-0 rounded-md p-1"
					>
						<XIcon class="size-4" />
					</button>
				{/if}
			</div>
		{/if}
		<!-- overflow-y-auto (not hidden): the mail view is h-full and contains itself
		     (panes scroll internally), but document-flow pages like /account scroll here.
		     overscroll-contain: no iOS rubber-band bleeding to the document. -->
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain" bind:clientWidth={regionW}>
			{@render children()}
		</div>

		<!-- Desktop composer (docked panel). Single-pane widths route to the
		     /app/compose page instead (the effect above), so the panel never
		     mounts there. -->
		{#if !singlePane}
			{#key compose.nonce}
				<ComposePanel
					bind:open={compose.open}
					prefill={compose.prefill}
					resumeDraftId={compose.resumeDraftId}
					scheduleAt={compose.scheduleAt}
				/>
			{/key}
		{/if}
	</Sidebar.Inset>
</Sidebar.Provider>

<ShortcutsDialog bind:open={shortcutsOpen} />
