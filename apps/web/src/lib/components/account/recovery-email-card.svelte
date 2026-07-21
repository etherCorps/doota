<script lang="ts">
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import { setRecoveryEmail } from '$lib/rpc/recovery-email.remote';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { InputGroup, InputGroupAddon, InputGroupInput } from '$lib/components/ui/input-group';

	let {
		recoveryEmail,
		recoveryEmailVerified
	}: { recoveryEmail: string | null; recoveryEmailVerified: boolean } = $props();
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<AtSignIcon class="size-4" /> Recovery email
		</Card.CardTitle>
		<Card.CardDescription>
			External address used to reset your password. Your Doota inbox can't receive reset links —
			this is the only self-service recovery path.
		</Card.CardDescription>
		{#if recoveryEmail}
			<Card.CardAction>
				<Badge variant={recoveryEmailVerified ? 'default' : 'destructive'}>
					{recoveryEmailVerified ? 'Verified' : 'Unverified'}
				</Badge>
			</Card.CardAction>
		{/if}
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-4">
		{#if recoveryEmail}
			<p class="text-sm">
				<span class="font-mono">{recoveryEmail}</span>
				{#if !recoveryEmailVerified}
					<span class="text-muted-foreground">— check that inbox for the confirmation link.</span>
				{/if}
			</p>
		{:else}
			<p class="text-muted-foreground text-sm">
				No recovery email set. Without a verified external recovery email you cannot reset your own
				password.
			</p>
		{/if}
		{#if !recoveryEmailVerified}
			<form {...setRecoveryEmail} class="flex flex-col gap-3">
				<Field.Field>
					<Field.Label>External recovery email</Field.Label>
					<InputGroup>
						<InputGroupInput
							{...setRecoveryEmail.fields.recoveryEmail.as('email')}
							type="email"
							placeholder="you@example.com"
							required
						/>
						<InputGroupAddon align="inline-start">
							<AtSignIcon />
						</InputGroupAddon>
					</InputGroup>
					{#each setRecoveryEmail.fields.recoveryEmail.issues() ?? [] as issue (issue)}
						<Field.Error>{issue.message}</Field.Error>
					{/each}
				</Field.Field>
				<Button type="submit" class="self-start">
					{recoveryEmail ? 'Resend verification' : 'Save & send verification'}
				</Button>
			</form>
		{/if}
		{#if setRecoveryEmail.result}
			<p
				class="text-sm {setRecoveryEmail.result.success
					? 'text-muted-foreground'
					: 'text-destructive'}"
			>
				{setRecoveryEmail.result.message}
			</p>
		{/if}
	</Card.CardContent>
</Card.Card>
