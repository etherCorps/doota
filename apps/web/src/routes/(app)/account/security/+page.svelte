<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import LockIcon from '@lucide/svelte/icons/lock';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import RecoveryEmailCard from '$lib/components/account/recovery-email-card.svelte';
	import TwoFactorCard from '$lib/components/account/two-factor-card.svelte';
	import PasskeyCard from '$lib/components/account/passkey-card.svelte';
	import DevicesCard from '$lib/components/account/devices-card.svelte';
	import ChangePasswordDialog from '$lib/components/account/change-password-dialog.svelte';

	let { data } = $props();
	let changePasswordOpen = $state(false);
</script>

<!-- One column on phones; two tracks from lg so a big screen is used instead of
     a narrow centered scroll (matches the Mail tab). items-start keeps each card
     at its natural height; priority order reads left→right, top→bottom:
     Password · Passkeys / Two-factor · Devices / Recovery email. -->
<div class="grid w-full grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
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

	<PasskeyCard passkeys={data.passkeys} />
	<TwoFactorCard enabled={data.user.twoFactorEnabled} email={data.user.email} />
	<DevicesCard />
	<RecoveryEmailCard
		recoveryEmail={data.user.recoveryEmail}
		recoveryEmailVerified={data.user.recoveryEmailVerified}
	/>
</div>

<ChangePasswordDialog bind:open={changePasswordOpen} />
