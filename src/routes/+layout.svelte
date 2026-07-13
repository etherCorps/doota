<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
    import AppShell from '$lib/components/efferd/app-shell/app-shell-2/app-shell.svelte';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<!-- <AppShell> -->
    {@render children()}
<!-- </AppShell> -->
