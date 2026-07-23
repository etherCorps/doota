<script lang="ts">
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import { authClient } from '$lib/client/auth-client';
	import { goto } from '$app/navigation';
	import { navigating } from '$app/state';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let { data, children } = $props();

	async function logout() {
		await authClient.signOut();
		await goto(resolve('/login'));
	}
</script>

<!-- Deliberately NO sidebar: onboarding is a focused, gated flow. -->
<div class="bg-background flex min-h-svh flex-col">
	<header class="flex h-14 items-center justify-between border-b px-4 md:px-6">
		<div class="flex items-center gap-2">
			<div
				class="bg-primary text-primary-foreground font-heading flex size-7 items-center justify-center rounded-md text-base font-bold"
			>
				D
			</div>
			<span class="font-heading text-lg font-semibold tracking-tight">Doota</span>
		</div>
		<div class="flex items-center gap-3">
			<span class="text-muted-foreground hidden font-mono text-xs sm:inline">{data.user.email}</span>
			<Button variant="ghost" size="sm" class="gap-1.5" onclick={logout}>
				<LogOutIcon class="size-4" /> Sign out
			</Button>
		</div>
	</header>

	<main class="relative mx-auto w-full max-w-xl flex-1 px-4 py-8 md:py-12">
		{@render children()}
		<!-- Every step completion re-derives onboarding server-side (fresh D1 reads)
		     before the page updates — surface that as progress, not a frozen page. -->
		{#if navigating.to}
			<div
				class="bg-background/70 absolute inset-0 z-10 flex items-start justify-center pt-24 backdrop-blur-[2px]"
				role="status"
			>
				<div class="text-muted-foreground flex items-center gap-2.5 text-sm">
					<Spinner class="size-4" />
					<span>Checking your setup…</span>
				</div>
			</div>
		{/if}
	</main>
</div>
