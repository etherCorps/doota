<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import LockIcon from '@lucide/svelte/icons/lock';
	import { invalidateAll } from '$app/navigation';
	import { changeInitialPassword } from '$lib/rpc/onboarding.remote';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

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
			<Button type="submit" class="gap-1.5 self-start" disabled={changeInitialPassword.pending > 0}>
				{#if changeInitialPassword.pending > 0}<Spinner class="mr-1" />Updating…{:else}Update password{/if}
			</Button>
			<div aria-live="polite">
				{#if changeInitialPassword.result && !changeInitialPassword.result.success}
					<p class="text-destructive text-sm">{changeInitialPassword.result.message}</p>
				{/if}
			</div>
		</form>
	</Card.CardContent>
</Card.Card>
