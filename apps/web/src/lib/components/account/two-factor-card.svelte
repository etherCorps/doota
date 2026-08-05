<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import Lock from '@lucide/svelte/icons/lock';
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputOTP from '$lib/components/ui/input-otp/index.js';
	import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { renderSVG } from 'uqr';

	let { enabled, email }: { enabled: boolean; email: string } = $props();
	let showEnroll = $state(false);
	let totpPassword = $state('');
	let totpUri = $state('');
	let backupCodes = $state<string[]>([]);
	let totpCode = $state('');
	let totpLoading = $state(false);
	let codesSaved = $state(false);

	// Backup-code regeneration (enabled branch) — same save-validation flow as
	// enrollment, driven through the shared backupCodesFlow snippet below.
	let showRegen = $state(false);
	let regenPassword = $state('');
	let regenLoading = $state(false);
	let regenCodes = $state<string[]>([]);
	let regenDone = $state(false);

	const enrollSteps = [
		{ n: 1, title: 'Add to your authenticator' },
		{ n: 2, title: 'Save your backup codes' },
		{ n: 3, title: 'Enter the 6-digit code to finish' }
	];
	let enrollStep = $state(1);
	let setupMode = $state<'qr' | 'manual'>('qr');
	// Backup-code challenge: sub-state of step 2 (replaces the saved-checkbox).
	let challengeActive = $state(false);
	let challengeIndex = $state(0); // 1-based N, rolled on each Continue
	let challengeInput = $state('');
	let challengeError = $state(false);
	let activeStepEl = $state<HTMLElement | null>(null);

	async function focusActiveStep() {
		await tick();
		activeStepEl?.querySelector<HTMLElement>('button, input')?.focus();
	}

	function goToStep(stepNumber: number) {
		if (stepNumber >= enrollStep) return; // only completed steps are clickable
		enrollStep = stepNumber;
		challengeActive = false; // returning to step 2 shows the codes again
		focusActiveStep();
	}

	function startChallenge(codeCount: number) {
		challengeIndex = Math.floor(Math.random() * codeCount) + 1;
		challengeInput = '';
		challengeError = false;
		challengeActive = true;
		focusActiveStep();
	}

	function showCodesAgain() {
		challengeActive = false;
		focusActiveStep();
	}

	function verifyChallenge(e: SubmitEvent, codes: string[], onVerified: () => void) {
		e.preventDefault();
		const expected = codes[challengeIndex - 1] ?? '';
		if (challengeInput.trim().toLowerCase() !== expected.trim().toLowerCase()) {
			challengeError = true;
			return;
		}
		challengeActive = false;
		onVerified();
	}

	function onEnrollCodesVerified() {
		enrollStep = 3;
		focusActiveStep();
	}

	// otpauth:// URIs parse fine with WHATWG URL (verified); regex is the
	// belt-and-braces fallback if a runtime trips on the scheme.
	const totpSecret = $derived.by(() => {
		if (!totpUri) return '';
		try {
			return new URL(totpUri).searchParams.get('secret') ?? '';
		} catch {
			return /[?&]secret=([^&#]+)/i.exec(totpUri)?.[1] ?? '';
		}
	});
	// Display-only grouping in 4-char blocks; copy always uses the raw secret.
	const totpSecretDisplay = $derived(totpSecret.replace(/(.{4})/g, '$1 ').trim());

	async function copySetupKey() {
		await navigator.clipboard.writeText(totpSecret);
		toast.success('Setup key copied to clipboard.');
	}

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
		codesSaved = false;
		enrollStep = 1;
		setupMode = 'qr';
		challengeActive = false;
		challengeInput = '';
		challengeError = false;
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

	async function copyBackupCodes(codes: string[]) {
		await navigator.clipboard.writeText(codes.join('\n'));
		codesSaved = true;
		toast.success('Backup codes copied to clipboard.');
	}

	function downloadBackupCodes(codes: string[]) {
		const blob = new Blob([`Doota backup codes — ${email}\n\n${codes.join('\n')}\n`], {
			type: 'text/plain'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'doota-backup-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
		codesSaved = true;
	}

	async function regenerateBackupCodes(e: SubmitEvent) {
		e.preventDefault();
		regenLoading = true;
		const { data: res, error } = await authClient.twoFactor.generateBackupCodes({
			password: regenPassword
		});
		regenLoading = false;
		if (error) {
			toast.error(error.message ?? 'Could not regenerate backup codes.');
			return;
		}
		regenCodes = res.backupCodes;
		regenPassword = '';
		showRegen = false;
		regenDone = false;
		codesSaved = false;
		challengeActive = false;
		challengeInput = '';
		challengeError = false;
		focusActiveStep();
	}

	function onRegenCodesVerified() {
		regenCodes = [];
		regenDone = true;
	}
</script>

<!-- Shared save-validation flow: codes grid + Copy/Download (gates Continue) →
     hidden-codes "enter code #N" challenge → onVerified. Used by both enrollment
     (step 2/2b) and regeneration so the two never diverge. -->
{#snippet backupCodesFlow(
	codes: string[],
	heading: string,
	challengeHeading: string,
	onVerified: () => void
)}
	{#if !challengeActive}
		<p class="text-sm font-medium">{heading}</p>
		<p class="text-muted-foreground text-xs">
			Shown only once. Each code works one time, in place of an authenticator code.
		</p>
		<div
			class="bg-muted/30 grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border p-3 font-mono text-xs"
		>
			{#each codes as bc (bc)}
				<span>{bc}</span>
			{/each}
		</div>
		<div class="flex gap-2">
			<Button variant="outline" size="sm" onclick={() => copyBackupCodes(codes)}>
				<CopyIcon /> Copy
			</Button>
			<Button variant="outline" size="sm" onclick={() => downloadBackupCodes(codes)}>
				<DownloadIcon /> Download
			</Button>
		</div>
		<div class="flex items-center gap-2">
			<Button size="sm" disabled={!codesSaved} onclick={() => startChallenge(codes.length)}>
				Continue
			</Button>
			{#if !codesSaved}
				<p class="text-muted-foreground text-xs">Copy or download them first.</p>
			{/if}
		</div>
	{:else}
		<p class="text-sm font-medium">{challengeHeading}</p>
		<form onsubmit={(e) => verifyChallenge(e, codes, onVerified)} class="flex flex-col gap-2">
			<Label for="totp-backup-challenge" class="text-sm font-normal">
				Enter backup code #{challengeIndex} from your saved copy
			</Label>
			<Input
				id="totp-backup-challenge"
				class="max-w-60 font-mono"
				bind:value={challengeInput}
				autocomplete="off"
				spellcheck={false}
				aria-label="Backup code number {challengeIndex}"
				aria-invalid={challengeError}
				aria-describedby={challengeError ? 'totp-backup-challenge-error' : undefined}
				oninput={() => (challengeError = false)}
			/>
			{#if challengeError}
				<p id="totp-backup-challenge-error" class="text-destructive text-xs">
					That doesn't match code #{challengeIndex} — check your saved copy.
				</p>
			{/if}
			<div class="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={!challengeInput.trim()}>Verify</Button>
				<Button variant="ghost" size="sm" onclick={showCodesAgain}>
					Show codes again
				</Button>
			</div>
		</form>
	{/if}
{/snippet}

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
			{#if regenCodes.length}
				<div bind:this={activeStepEl} class="flex flex-col gap-3">
					{@render backupCodesFlow(
						regenCodes,
						'Save your new backup codes',
						'Confirm a backup code',
						onRegenCodesVerified
					)}
				</div>
			{:else if showRegen}
				<form onsubmit={regenerateBackupCodes} class="flex flex-col gap-3">
					<Field.Field>
						<Field.Label>Confirm your password</Field.Label>
						<InputGroup>
							<InputGroupInput
								type="password"
								placeholder="Password"
								bind:value={regenPassword}
								required
								autocomplete="current-password"
							/>
							<InputGroupAddon align="inline-start">
								<Lock />
							</InputGroupAddon>
						</InputGroup>
					</Field.Field>
					<p class="text-muted-foreground text-xs">
						Regenerating invalidates all existing backup codes.
					</p>
					<Button type="submit" class="self-start" disabled={regenLoading}>
						{#if regenLoading}<Spinner class="mr-1" />{/if}
						Generate new codes
					</Button>
				</form>
			{:else}
				{#if regenDone}
					<p class="text-muted-foreground flex items-center gap-2 text-sm">
						<CheckIcon class="size-4" /> New backup codes saved — old codes no longer work.
					</p>
				{/if}
				<Button variant="outline" class="self-start" onclick={() => (showRegen = true)}>
					Regenerate backup codes…
				</Button>
			{/if}
		{:else if totpUri}
			{#each enrollSteps as stepDef (stepDef.n)}
				{#if stepDef.n < enrollStep}
					<!-- Completed step — compact done row, click to go back -->
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground flex items-center gap-2 self-start text-sm"
						onclick={() => goToStep(stepDef.n)}
					>
						<CheckIcon class="size-4" />
						{stepDef.title}
					</button>
				{:else if stepDef.n === enrollStep}
					<div bind:this={activeStepEl} class="flex flex-col gap-3">
						{#if stepDef.n === 1}
							<p class="text-sm font-medium">1 · {stepDef.title}</p>
							<div class="bg-muted text-muted-foreground inline-flex items-center gap-0.5 self-start rounded-lg p-0.5 text-xs">
								<button
									type="button"
									class="rounded-md px-2.5 py-1 {setupMode === 'qr'
										? 'bg-background text-foreground shadow-sm'
										: 'hover:text-foreground'}"
									aria-pressed={setupMode === 'qr'}
									onclick={() => (setupMode = 'qr')}
								>
									Scan QR
								</button>
								<button
									type="button"
									class="rounded-md px-2.5 py-1 {setupMode === 'manual'
										? 'bg-background text-foreground shadow-sm'
										: 'hover:text-foreground'}"
									aria-pressed={setupMode === 'manual'}
									onclick={() => (setupMode = 'manual')}
								>
									Enter key manually
								</button>
							</div>
							<!-- Both modes stacked in the same grid cell so the box keeps the
							     QR's dimensions exactly — zero layout shift on toggle. -->
							<div class="grid min-h-45 self-start rounded-lg border">
								<div
									class="col-start-1 row-start-1 flex items-center justify-center p-2.5"
									class:invisible={setupMode !== 'qr'}
								>
									<div class="[&_svg]:size-40 [&_svg]:block rounded-md bg-white p-2">
										{@html renderSVG(totpUri)}
									</div>
								</div>
								<div
									class="col-start-1 row-start-1 flex flex-col items-center justify-center gap-1.5 p-4"
									class:invisible={setupMode !== 'manual'}
								>
									<p class="text-muted-foreground text-xs">Doota · {email}</p>
									<div class="flex items-center gap-1.5">
										<span
											class="bg-muted/30 select-all rounded-md border px-2 py-1 font-mono text-xs tracking-wide"
										>
											{totpSecretDisplay}
										</span>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Copy setup key"
											onclick={copySetupKey}
										>
											<CopyIcon />
										</Button>
									</div>
								</div>
							</div>
							<p class="text-muted-foreground text-sm">
								Open your authenticator app (1Password, Authy, Google Authenticator) and scan the QR
								code — or enter the setup key manually — to add Doota.
							</p>
							<Button
								class="self-start"
								size="sm"
								onclick={() => {
									enrollStep = 2;
									focusActiveStep();
								}}
							>
								Next
							</Button>
						{:else if stepDef.n === 2}
							{@render backupCodesFlow(
								backupCodes,
								`2 · ${stepDef.title}`,
								'2 · Confirm a backup code',
								onEnrollCodesVerified
							)}
						{:else}
							<p class="text-sm font-medium">3 · {stepDef.title}</p>
							<form onsubmit={confirmTotp} class="flex flex-col gap-3">
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
						{/if}
					</div>
				{:else}
					<!-- Future step — locked row -->
					<div class="text-muted-foreground/60 flex items-center gap-2 text-sm">
						<Lock class="size-3.5" />
						{stepDef.title}
					</div>
				{/if}
			{/each}
		{:else if showEnroll}
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
		{:else}
			<Button variant="outline" class="self-start" onclick={() => (showEnroll = true)}>
				Enable two-factor…
			</Button>
		{/if}
	</Card.CardContent>
</Card.Card>
