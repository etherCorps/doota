<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
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

	function downloadBackupCodes() {
		const blob = new Blob([`Doota backup codes — ${email}\n\n${backupCodes.join('\n')}\n`], {
			type: 'text/plain'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'doota-backup-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
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
			<div class="flex items-start gap-3 rounded-lg border p-4">
				<div class="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
					<ShieldCheckIcon class="size-5" />
				</div>
				<div class="space-y-0.5">
					<p class="text-sm font-medium">Two-factor authentication is on</p>
					<p class="text-muted-foreground text-sm">
						Keep your backup codes safe — they're the recovery path if you lose your authenticator.
					</p>
				</div>
			</div>
		{:else if totpUri}
			<!-- Step 1 — scan -->
			<div class="flex flex-col gap-4 sm:flex-row sm:items-center">
				<div class="[&_svg]:size-40 [&_svg]:block shrink-0 self-start rounded-lg border bg-white p-2.5">
					{@html renderSVG(totpUri)}
				</div>
				<div class="space-y-1">
					<p class="text-sm font-medium">1 · Scan with your authenticator</p>
					<p class="text-muted-foreground text-sm">
						Open your authenticator app (1Password, Authy, Google Authenticator) and scan this QR
						code to add Doota.
					</p>
				</div>
			</div>

			<!-- Step 2 — backup codes -->
			<div class="space-y-2 border-t pt-4">
				<p class="text-sm font-medium">2 · Save your backup codes</p>
				<p class="text-muted-foreground text-xs">
					Shown only once. Each code works one time, in place of an authenticator code.
				</p>
				<div class="bg-muted/30 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border p-3 font-mono text-xs">
					{#each backupCodes as bc (bc)}
						<span>{bc}</span>
					{/each}
				</div>
				<div class="flex gap-2">
					<Button variant="outline" size="sm" onclick={copyBackupCodes}>
						<CopyIcon /> Copy
					</Button>
					<Button variant="outline" size="sm" onclick={downloadBackupCodes}>
						<DownloadIcon /> Download
					</Button>
				</div>
			</div>

			<!-- Step 3 — confirm -->
			<form onsubmit={confirmTotp} class="space-y-3 border-t pt-4">
				<p class="text-sm font-medium">3 · Enter the 6-digit code to finish</p>
				<InputOTP.Root maxlength={6} bind:value={totpCode}>
					{#snippet children({ cells })}
						<InputOTP.Group>
							{#each cells as cell (cell)}
								<InputOTP.Slot {cell} />
							{/each}
						</InputOTP.Group>
					{/snippet}
				</InputOTP.Root>
				<Button type="submit" class="self-start" disabled={totpLoading || totpCode.length < 6}>
					{#if totpLoading}<Spinner class="mr-1" />{/if}
					Confirm &amp; enable
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
