<script lang="ts">
	import MailCheckIcon from '@lucide/svelte/icons/mail-check';
	import MailXIcon from '@lucide/svelte/icons/mail-x';
	import { resolve } from '$app/paths';
	import AuthShell from '$lib/components/pages/auth-shell.svelte';

	let { data } = $props();
</script>

<AuthShell
	title="Recovery email"
	description={data.verified ? 'Address confirmed.' : 'Verification failed.'}
>
	<div class="flex flex-col items-center gap-3 py-4 text-center">
		{#if data.verified}
			<MailCheckIcon class="size-8 text-muted-foreground" />
			<p>Recovery email verified. You can close this tab.</p>
		{:else}
			<MailXIcon class="size-8 text-destructive" />
			<p>
				This verification link is invalid or has expired. Request a new one from your account
				security settings.
			</p>
			<a href={resolve('/login')} class="text-sm underline underline-offset-4">Go to login</a>
		{/if}
	</div>
</AuthShell>
