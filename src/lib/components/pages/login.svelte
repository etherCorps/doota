<script lang="ts">
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import Lock from '@lucide/svelte/icons/lock';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { MAIL_DOMAIN } from '$app/env/public';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import AuthShell from './auth-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputOTP from '$lib/components/ui/input-otp/index.js';
	import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let email = $state('');
	let password = $state('');
	let code = $state('');
	let step = $state<'credentials' | 'totp'>('credentials');
	let useBackup = $state(false);
	let loading = $state(false);

	const shell = $derived(
		step === 'credentials'
			? { title: 'Doota', description: 'Log in to your mailbox.' }
			: {
					title: 'Two-factor check',
					description: useBackup
						? 'Enter one of your backup codes.'
						: 'Enter the 6-digit code from your authenticator app.'
				}
	);

	async function loginPassword(e: SubmitEvent) {
		e.preventDefault();
		loading = true;
		const { data, error } = await authClient.signIn.email({ email, password });
		loading = false;
		if (error) {
			toast.error(error.message ?? 'Login failed.');
			return;
		}
		if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
			step = 'totp';
			return;
		}
		await goto(resolve('/'));
	}

	async function verifyCode(e: SubmitEvent) {
		e.preventDefault();
		loading = true;
		const res = useBackup
			? await authClient.twoFactor.verifyBackupCode({ code })
			: await authClient.twoFactor.verifyTotp({ code });
		loading = false;
		if (res.error) {
			toast.error(res.error.message ?? 'Invalid code.');
			return;
		}
		await goto(resolve('/'));
	}

	// No TOTP after passkey — a passkey is already two factors.
	async function loginPasskey() {
		const res = await authClient.signIn.passkey();
		if (res?.error) {
			toast.error(res.error.message ?? 'Passkey login failed.');
			return;
		}
		await goto(resolve('/'));
	}
</script>

<AuthShell title={shell.title} description={shell.description}>
	{#if step === 'credentials'}
		<form onsubmit={loginPassword}>
			<Field.Group>
				<Field.Field>
					<Field.Label>Email</Field.Label>
					<InputGroup>
						<InputGroupInput
							type="email"
							placeholder="you@{MAIL_DOMAIN}"
							bind:value={email}
							required
							autocomplete="username webauthn"
						/>
						<InputGroupAddon align="inline-start">
							<AtSignIcon />
						</InputGroupAddon>
					</InputGroup>
				</Field.Field>
				<Field.Field>
					<Field.Label>Password</Field.Label>
					<InputGroup>
						<InputGroupInput
							type="password"
							placeholder="Password"
							bind:value={password}
							required
							autocomplete="current-password"
						/>
						<InputGroupAddon align="inline-start">
							<Lock />
						</InputGroupAddon>
					</InputGroup>
					<Field.Description>
						<a href={resolve('/forgot-password')} class="underline underline-offset-4">
							Forgot password?
						</a>
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Button class="w-full" type="submit" disabled={loading}>
						{#if loading}<Spinner class="mr-1" />{/if}
						Log in
					</Button>
				</Field.Field>
				<Field.Separator>Or</Field.Separator>
				<Field.Field>
					<Button class="w-full" variant="outline" type="button" onclick={loginPasskey}>
						<FingerprintIcon />
						Log in with passkey
					</Button>
				</Field.Field>
			</Field.Group>
		</form>
	{:else}
		<form onsubmit={verifyCode}>
			<Field.Group>
				<Field.Field>
					{#if useBackup}
						<Field.Label>Backup code</Field.Label>
						<Input type="text" bind:value={code} required autocomplete="one-time-code" />
					{:else}
						<Field.Label>Authenticator code</Field.Label>
						<InputOTP.Root maxlength={6} bind:value={code}>
							{#snippet children({ cells })}
								<InputOTP.Group>
									{#each cells as cell (cell)}
										<InputOTP.Slot {cell} />
									{/each}
								</InputOTP.Group>
							{/snippet}
						</InputOTP.Root>
					{/if}
				</Field.Field>
				<Field.Field>
					<Button class="w-full" type="submit" disabled={loading}>
						{#if loading}<Spinner class="mr-1" />{/if}
						Verify
					</Button>
				</Field.Field>
				<Field.Field>
					<Button
						variant="ghost"
						type="button"
						onclick={() => {
							useBackup = !useBackup;
							code = '';
						}}
					>
						{useBackup ? 'Use authenticator code instead' : 'Lost your authenticator? Use a backup code'}
					</Button>
				</Field.Field>
			</Field.Group>
		</form>
	{/if}
</AuthShell>
