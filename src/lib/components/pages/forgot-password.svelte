<script lang="ts">
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import MailCheckIcon from '@lucide/svelte/icons/mail-check';
	import { resolve } from '$app/paths';
	import { MAIL_DOMAIN } from '$app/env/public';
	import { authClient } from '$lib/client/auth-client';
	import AuthShell from './auth-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field/index.js';
	import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let email = $state('');
	let sent = $state(false);
	let loading = $state(false);

	// Always show the same generic message — no account enumeration,
	// never reveal the recovery address.
	async function request(e: SubmitEvent) {
		e.preventDefault();
		loading = true;
		await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
		loading = false;
		sent = true;
	}
</script>

<AuthShell
	title="Forgot password"
	description="Enter your Doota email. If it has a verified recovery address, we'll send a reset link there."
>
	{#if sent}
		<div class="flex flex-col items-center gap-3 py-4 text-center">
			<MailCheckIcon class="size-8 text-muted-foreground" />
			<p>If an account exists, a reset link was sent to its recovery address.</p>
			<a href={resolve('/login')} class="text-sm underline underline-offset-4">Back to login</a>
		</div>
	{:else}
		<form onsubmit={request}>
			<Field.Group>
				<Field.Field>
					<Field.Label>Your Doota email</Field.Label>
					<InputGroup>
						<InputGroupInput
							type="email"
							placeholder="you@{MAIL_DOMAIN}"
							bind:value={email}
							required
						/>
						<InputGroupAddon align="inline-start">
							<AtSignIcon />
						</InputGroupAddon>
					</InputGroup>
				</Field.Field>
				<Field.Field>
					<Button class="w-full" type="submit" disabled={loading}>
						{#if loading}<Spinner class="mr-1" />{/if}
						Send reset link
					</Button>
				</Field.Field>
				<Field.Description class="text-center">
					Remembered it? <a href={resolve('/login')} class="underline underline-offset-4">Log in</a>
				</Field.Description>
			</Field.Group>
		</form>
	{/if}
</AuthShell>
