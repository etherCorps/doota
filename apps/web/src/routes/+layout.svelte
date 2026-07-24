<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
    import { Toaster } from "$lib/components/ui/sonner/index.js";
    import { ModeWatcher } from "mode-watcher";

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- bottom-right: same corner as the compose panel, so send/undo toasts appear
     where the user's attention already is. -->
<Toaster richColors closeButton position="bottom-right" />
<ModeWatcher defaultTheme="dark" defaultMode="system" />

{@render children()}
