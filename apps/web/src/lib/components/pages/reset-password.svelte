<script lang="ts">
	import Lock from '@lucide/svelte/icons/lock';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import AuthShell from './auth-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field/index.js';
	import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let newPassword = $state('');
	let loading = $state(false);

	const token = $derived(page.url.searchParams.get('token'));
	const invalid = $derived(page.url.searchParams.get('error') === 'INVALID_TOKEN' || !token);

	// Resets the password only — 2FA stays intact by design.
	async function reset(e: SubmitEvent) {
		e.preventDefault();
		if (!token) return;
		loading = true;
		const { error } = await authClient.resetPassword({ newPassword, token });
		loading = false;
		if (error) {
			toast.error(error.message ?? 'Reset failed. The link may have expired.');
			return;
		}
		toast.success('Password updated. Log in with your new password.');
		await goto(resolve('/login'));
	}
</script>

<AuthShell
	title="Reset password"
	description="Choose a new password for your Doota account."
>
	{#if invalid}
		<div class="flex flex-col gap-3">
			<p>This reset link is invalid or has expired.</p>
			<a href={resolve('/forgot-password')} class="text-sm underline underline-offset-4">
				Request a new one
			</a>
		</div>
	{:else}
		<form onsubmit={reset}>
			<Field.Group>
				<Field.Field>
					<Field.Label>New password</Field.Label>
					<InputGroup>
						<InputGroupInput
							type="password"
							placeholder="New password"
							bind:value={newPassword}
							required
							minlength={8}
							maxlength={128}
							autocomplete="new-password"
						/>
						<InputGroupAddon align="inline-start">
							<Lock />
						</InputGroupAddon>
					</InputGroup>
					<Field.Description>
						This only resets your password. Two-factor authentication stays active — use a backup
						code if you lost your authenticator.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Button class="w-full" type="submit" disabled={loading}>
						{#if loading}<Spinner class="mr-1" />{/if}
						Reset password
					</Button>
				</Field.Field>
			</Field.Group>
		</form>
	{/if}
</AuthShell>
