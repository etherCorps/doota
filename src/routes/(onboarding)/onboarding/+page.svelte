<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import RecoveryEmailCard from '$lib/components/account/recovery-email-card.svelte';
	import TwoFactorCard from '$lib/components/account/two-factor-card.svelte';
	import PasskeyCard from '$lib/components/account/passkey-card.svelte';
	import EmailVerifyCard from '$lib/components/account/email-verify-card.svelte';
	import SetPasswordCard from '$lib/components/account/set-password-card.svelte';

	let { data } = $props();

	const steps = $derived(data.onboarding.steps);
	const doneCount = $derived(steps.filter((s) => s.done).length);
</script>

<div class="flex flex-col gap-6">
	<div class="flex flex-col gap-2">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Finish setting up</h1>
		<p class="text-muted-foreground text-sm">
			A few steps before you can access Doota. {doneCount} of {steps.length} done.
		</p>
		<div class="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full">
			<div
				class="bg-ok h-full rounded-full transition-all"
				style="width:{steps.length ? (doneCount / steps.length) * 100 : 0}%"
			></div>
		</div>
	</div>

	{#each steps as step, i (step.id)}
		{#if step.done}
			<div class="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
				<span class="bg-ok/10 text-ok flex size-6 items-center justify-center rounded-full">
					<CheckIcon class="size-4" />
				</span>
				<div class="flex flex-col">
					<span class="text-sm font-medium">{step.title}</span>
					<span class="text-muted-foreground text-xs">Done</span>
				</div>
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				<div class="text-muted-foreground flex items-center gap-2 text-xs font-medium">
					<span class="bg-muted flex size-5 items-center justify-center rounded-full text-[11px]">
						{i + 1}
					</span>
					Step {i + 1} of {steps.length}
				</div>
				{#if step.id === 'verify-email'}
					<EmailVerifyCard email={data.account.email} />
				{:else if step.id === 'verify-recovery'}
					<RecoveryEmailCard
						recoveryEmail={data.account.recoveryEmail}
						recoveryEmailVerified={data.account.recoveryEmailVerified}
					/>
				{:else if step.id === 'set-password'}
					<SetPasswordCard />
				{:else if step.id === 'secure-account'}
					<TwoFactorCard enabled={data.account.twoFactorEnabled} email={data.account.email} />
					<PasskeyCard passkeys={data.passkeys} />
				{/if}
			</div>
		{/if}
	{/each}
</div>
