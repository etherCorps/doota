<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import Login from '$lib/components/pages/login.svelte';
	import AuthShell from '$lib/components/pages/auth-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import { MAX_DEVICE_SESSIONS } from '$lib/auth-limits.js';

	let { data } = $props();

	// Surface a redirect notice (e.g. "admin already exists") once on arrival.
	$effect(() => {
		if (data.notice) toast.error(data.notice);
	});
</script>

{#if data.addLimit}
	<!-- Add-account blocked at the device-session cap. Past it, better-auth
	     silently stops tracking sessions, so never let a sign-in reach that. -->
	<AuthShell
		title="Account limit reached"
		description="This device already has {MAX_DEVICE_SESSIONS} accounts signed in."
	>
		<div class="flex flex-col gap-4">
			<p class="text-muted-foreground text-sm">
				To add another account, log out of one of your existing accounts first (open the account
				menu in the sidebar and choose Log out).
			</p>
			<Button href={resolve('/')} class="w-full">Go back</Button>
		</div>
	</AuthShell>
{:else}
	<Login />
{/if}
