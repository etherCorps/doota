<script lang="ts">
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let { passkeys }: { passkeys: { id: string; name: string | null }[] } = $props();

	let passkeyName = $state('');
	let passkeyLoading = $state(false);

	async function addPasskey() {
		passkeyLoading = true;
		const res = await authClient.passkey.addPasskey({ name: passkeyName || undefined });
		passkeyLoading = false;
		if (res?.error) {
			toast.error(res.error.message ?? 'Could not add passkey.');
			return;
		}
		passkeyName = '';
		toast.success('Passkey added.');
		await invalidateAll();
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<FingerprintIcon class="size-4" /> Passkeys
		</Card.CardTitle>
		<Card.CardDescription>
			Preferred login once enrolled — a passkey is already two factors, so no TOTP step follows it.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-4">
		{#if passkeys.length}
			<ul class="flex flex-col gap-1 text-sm">
				{#each passkeys as pk (pk.id)}
					<li class="flex items-center gap-2">
						<FingerprintIcon class="text-muted-foreground size-3.5" />
						{pk.name ?? 'Unnamed passkey'}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-muted-foreground text-sm">No passkeys yet.</p>
		{/if}
		<div class="flex items-end gap-2">
			<Field.Field class="flex-1">
				<Field.Label>Passkey name (optional)</Field.Label>
				<Input type="text" placeholder="e.g. MacBook Touch ID" bind:value={passkeyName} />
			</Field.Field>
			<Button variant="outline" onclick={addPasskey} disabled={passkeyLoading}>
				{#if passkeyLoading}<Spinner class="mr-1" />{/if}
				Add passkey
			</Button>
		</div>
	</Card.CardContent>
</Card.Card>
