<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import LockIcon from '@lucide/svelte/icons/lock';
	import { invalidateAll } from '$app/navigation';
	import { changeInitialPassword } from '$lib/rpc/onboarding.remote';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';

	// Refresh onboarding state as soon as the flag clears.
	$effect(() => {
		if (changeInitialPassword.result?.success) invalidateAll();
	});
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<LockIcon class="size-4" /> Set your password
		</Card.CardTitle>
		<Card.CardDescription>
			Replace the temporary password you were given with one only you know.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<form {...changeInitialPassword} class="flex flex-col gap-3">
			<Field.Field>
				<Field.Label>Current (temporary) password</Field.Label>
				<Input
					{...changeInitialPassword.fields.currentPassword.as('password')}
					type="password"
					autocomplete="current-password"
					required
				/>
				{#each changeInitialPassword.fields.currentPassword.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>New password</Field.Label>
				<Input
					{...changeInitialPassword.fields.newPassword.as('password')}
					type="password"
					autocomplete="new-password"
					required
				/>
				{#each changeInitialPassword.fields.newPassword.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Button type="submit" class="self-start">Update password</Button>
			{#if changeInitialPassword.result && !changeInitialPassword.result.success}
				<p class="text-destructive text-sm">{changeInitialPassword.result.message}</p>
			{/if}
		</form>
	</Card.CardContent>
</Card.Card>
