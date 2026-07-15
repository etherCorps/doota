<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import Lock from '@lucide/svelte/icons/lock';
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputOTP from '$lib/components/ui/input-otp/index.js';
	import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { renderSVG } from 'uqr';

	let { enabled, email }: { enabled: boolean; email: string } = $props();
	let totpPassword = $state('');
	let totpUri = $state('');
	let backupCodes = $state<string[]>([]);
	let totpCode = $state('');
	let totpLoading = $state(false);

	async function enableTotp(e: SubmitEvent) {
		e.preventDefault();
		totpLoading = true;
		const issuer = `Doota: ${email}`;
		const { data: res, error } = await authClient.twoFactor.enable({ password: totpPassword, issuer });
		totpLoading = false;
		if (error) {
			toast.error(error.message ?? 'Could not start 2FA enrollment.');
			return;
		}
		totpUri = res.totpURI;
		backupCodes = res.backupCodes;
	}

	async function confirmTotp(e: SubmitEvent) {
		e.preventDefault();
		totpLoading = true;
		const { error } = await authClient.twoFactor.verifyTotp({ code: totpCode });
		totpLoading = false;
		if (error) {
			toast.error(error.message ?? 'Invalid code.');
			return;
		}
		totpUri = '';
		toast.success('Two-factor authentication enabled.');
		await invalidateAll();
	}

	async function copyBackupCodes() {
		await navigator.clipboard.writeText(backupCodes.join('\n'));
		toast.success('Backup codes copied to clipboard.');
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<KeyRoundIcon class="size-4" /> Two-factor authentication
		</Card.CardTitle>
		<Card.CardDescription>
			Time-based codes from an authenticator app, with backup codes as the lost-authenticator
			recovery path.
		</Card.CardDescription>
		<Card.CardAction>
			<Badge variant={enabled ? 'default' : 'secondary'}>{enabled ? 'Enabled' : 'Off'}</Badge>
		</Card.CardAction>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-4">
		{#if enabled}
			<p class="text-muted-foreground text-sm">
				Enabled. Keep your backup codes safe — they are the recovery path if you lose your
				authenticator.
			</p>
		{:else if totpUri}
			<Field.Field>
				<Field.Label>1. Add to your authenticator app</Field.Label>
				<!-- <code class="bg-muted/50 rounded-md border p-3 text-xs break-all">{totpUri}</code> -->
				{@html renderSVG(totpUri)}
			</Field.Field>
			<Field.Field>
				<Field.Label>2. Store your backup codes</Field.Label>
				<Field.Description>
					They will not be shown again. Each works once, in place of an authenticator code.
				</Field.Description>
				<div class="grid grid-cols-2 gap-1 rounded-md border p-3 font-mono text-xs">
					{#each backupCodes as bc (bc)}
						<span>{bc}</span>
					{/each}
				</div>
				<Button variant="outline" size="sm" class="self-start" onclick={copyBackupCodes}>
					<CopyIcon /> Copy codes
				</Button>
			</Field.Field>
			<form onsubmit={confirmTotp} class="flex flex-col gap-3">
				<Field.Field>
					<Field.Label>3. Enter a code to confirm</Field.Label>
					<InputOTP.Root maxlength={6} bind:value={totpCode}>
						{#snippet children({ cells })}
							<InputOTP.Group>
								{#each cells as cell (cell)}
									<InputOTP.Slot {cell} />
								{/each}
							</InputOTP.Group>
						{/snippet}
					</InputOTP.Root>
				</Field.Field>
				<Button type="submit" class="self-start" disabled={totpLoading}>
					{#if totpLoading}<Spinner class="mr-1" />{/if}
					Confirm & enable
				</Button>
			</form>
		{:else}
			<form onsubmit={enableTotp} class="flex flex-col gap-3">
				<Field.Field>
					<Field.Label>Confirm your password</Field.Label>
					<InputGroup>
						<InputGroupInput
							type="password"
							placeholder="Password"
							bind:value={totpPassword}
							required
							autocomplete="current-password"
						/>
						<InputGroupAddon align="inline-start">
							<Lock />
						</InputGroupAddon>
					</InputGroup>
				</Field.Field>
				<Button type="submit" class="self-start" disabled={totpLoading}>
					{#if totpLoading}<Spinner class="mr-1" />{/if}
					Enable 2FA
				</Button>
			</form>
		{/if}
	</Card.CardContent>
</Card.Card>
