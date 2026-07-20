<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import RecoveryEmailCard from '$lib/components/account/recovery-email-card.svelte';
	import TwoFactorCard from '$lib/components/account/two-factor-card.svelte';
	import PasskeyCard from '$lib/components/account/passkey-card.svelte';
	import ChangePasswordDialog from '$lib/components/account/change-password-dialog.svelte';

	let { data } = $props();
	let changePasswordOpen = $state(false);
</script>

<div class="flex flex-col gap-6">
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
