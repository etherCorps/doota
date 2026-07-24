<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { authClient } from '$lib/client/auth-client';
	import AvatarCropper from '$lib/components/account/avatar-cropper.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
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

	// Photo — the layout banner shows the avatar already, so the photo editor
	// lives inside the one Profile card instead of a card of its own (the old
	// two-card stack read as clutter on mobile: avatar twice in one screen).
	let cropperOpen = $state(false);
	let override = $state<string | null>(null);
	const currentImage = $derived(override ?? data.user.image);
	const initials = $derived(
		data.user.name
			.split(' ')
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);

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

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<UserIcon class="size-4" /> Profile
		</Card.CardTitle>
		<Card.CardDescription>
			Your photo and display name are shown across Doota and as the sender on outgoing mail. Login
			address and security settings live in the Security tab.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-5">
		<div class="flex items-center gap-4">
			<Avatar.Root class="size-14">
				{#if currentImage}<Avatar.Image src={currentImage} alt={data.user.name} />{/if}
				<Avatar.Fallback class="text-base">{initials}</Avatar.Fallback>
			</Avatar.Root>
			<div class="min-w-0">
				<Button variant="outline" size="sm" onclick={() => (cropperOpen = true)}>Change photo</Button>
				<p class="text-muted-foreground mt-1 text-xs">A square image works best.</p>
			</div>
		</div>

		<Field.Field>
			<Field.Label>Name</Field.Label>
			<Input bind:value={name} placeholder="Ada Lovelace" autocomplete="name" />
		</Field.Field>

		<div class="flex flex-wrap items-center justify-between gap-3">
			<span class="text-muted-foreground text-xs">Member since {fmtDate(data.user.createdAt)}</span>
			<Button disabled={!dirty || saving} onclick={save}>
				{#if saving}<Spinner class="mr-1" />{/if}
				Save
			</Button>
		</div>
	</Card.CardContent>
</Card.Card>

<AvatarCropper
	bind:open={cropperOpen}
	image={currentImage}
	onsaved={(img) => {
		override = img;
		invalidateAll();
	}}
/>
