<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { authClient } from '$lib/client/auth-client';
	import AvatarCard from '$lib/components/account/avatar-card.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import UserIcon from '@lucide/svelte/icons/user';

	let { data } = $props();

	// Editable copy seeded once; the form owns it thereafter.
	let name = $state(untrack(() => data.user.name));
	let saving = $state(false);
	const dirty = $derived(name.trim().length > 0 && name.trim() !== data.user.name);

	function fmtDate(ms: number | null): string {
		return ms
			? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
			: '—';
	}

	async function save() {
		saving = true;
		const { error } = await authClient.updateUser({ name: name.trim() });
		saving = false;
		if (error) {
			toast.error(error.message ?? 'Could not update your name.');
			return;
		}
		toast.success('Profile updated.');
		await invalidateAll();
	}
</script>

<div class="flex flex-col gap-6">
	<AvatarCard name={data.user.name} image={data.user.image} />

	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="flex items-center gap-2">
				<UserIcon class="size-4" /> Display name
			</Card.CardTitle>
			<Card.CardDescription>
				Shown as your sender name on outgoing mail. Your login address and security settings live in
				the Security tab.
			</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent class="flex flex-col gap-4">
			<Field.Field>
				<Field.Label>Name</Field.Label>
				<Input bind:value={name} placeholder="Ada Lovelace" autocomplete="name" />
			</Field.Field>
			<div class="flex items-center justify-between gap-4">
				<span class="text-muted-foreground text-xs">Member since {fmtDate(data.user.createdAt)}</span>
				<Button disabled={!dirty || saving} onclick={save}>
					{#if saving}<Spinner class="mr-1" />{/if}
					Save
				</Button>
			</div>
		</Card.CardContent>
	</Card.Card>
</div>
