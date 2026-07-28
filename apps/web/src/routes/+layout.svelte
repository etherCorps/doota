<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
    import { Toaster } from "$lib/components/ui/sonner/index.js";
    import { ModeWatcher } from "mode-watcher";
	import { onMount } from 'svelte';
	import UpdateNotifier from '$lib/components/app/update-notifier.svelte';

	let { children } = $props();

	// Installed-PWA launch splash (app.html #app-splash) covers the boot gap on
	// iOS/Android/desktop. Once hydrated, fade it (CSS via .app-ready) then drop it.
	onMount(() => {
		document.documentElement.classList.add('app-ready');
		const t = setTimeout(() => document.getElementById('app-splash')?.remove(), 500);
		return () => clearTimeout(t);
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- bottom-right: same corner as the compose panel, so send/undo toasts appear
     where the user's attention already is. -->
<Toaster richColors closeButton position="bottom-right" />
<ModeWatcher defaultTheme="dark" defaultMode="system" />
<UpdateNotifier />

{@render children()}
