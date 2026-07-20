<script lang="ts">
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import LockIcon from '@lucide/svelte/icons/lock';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import AvatarCard from '$lib/components/account/avatar-card.svelte';
	import RecoveryEmailCard from '$lib/components/account/recovery-email-card.svelte';
	import TwoFactorCard from '$lib/components/account/two-factor-card.svelte';
	import PasskeyCard from '$lib/components/account/passkey-card.svelte';
	import ChangePasswordDialog from '$lib/components/account/change-password-dialog.svelte';

	let { data } = $props();

	let changePasswordOpen = $state(false);

	const elevated = $derived(data.user.role === 'admin' || data.user.role === 'superadmin');
	const needsSecondFactor = $derived(
		elevated && !data.user.twoFactorEnabled && data.passkeys.length === 0
	);
</script>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6 md:p-10">
	<div class="flex flex-col space-y-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Account security</h1>
		<p class="text-muted-foreground font-mono text-sm">{data.user.email}</p>
	</div>

	{#if needsSecondFactor}
		<Card.Card class="border-destructive">
			<Card.CardHeader>
				<Card.CardTitle class="flex items-center gap-2">
					<ShieldAlertIcon class="size-4" /> Second factor required
				</Card.CardTitle>
				<Card.CardDescription>
					Admin accounts must have two-factor authentication or a passkey. Set one up below to
					continue.
				</Card.CardDescription>
			</Card.CardHeader>
		</Card.Card>
	{/if}

	<AvatarCard name={data.user.name} image={data.user.image} />

	<RecoveryEmailCard
		recoveryEmail={data.user.recoveryEmail}
		recoveryEmailVerified={data.user.recoveryEmailVerified}
	/>
	<TwoFactorCard enabled={data.user.twoFactorEnabled} email={data.user.email} />
	<PasskeyCard passkeys={data.passkeys} />

	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="flex items-center gap-2">
				<LockIcon class="size-4" /> Password
			</Card.CardTitle>
			<Card.CardDescription>
				Changing your password requires an emailed verification code and your current password.
			</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent>
			<Button variant="outline" onclick={() => (changePasswordOpen = true)}>Change password</Button>
		</Card.CardContent>
	</Card.Card>
</div>

<ChangePasswordDialog bind:open={changePasswordOpen} />
