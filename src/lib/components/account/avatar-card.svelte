<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import AvatarCropper from './avatar-cropper.svelte';

	let { name, image = null }: { name: string; image?: string | null } = $props();

	let open = $state(false);
	let override = $state<string | null>(null);
	const current = $derived(override ?? image);
	const initials = $derived(
		name
			.split(' ')
			.map((p) => p[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle>Profile photo</Card.CardTitle>
		<Card.CardDescription>Shown across Doota. A square image works best.</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex items-center gap-4">
		<Avatar.Root class="size-16">
			{#if current}<Avatar.Image src={current} alt={name} />{/if}
			<Avatar.Fallback class="text-lg">{initials}</Avatar.Fallback>
		</Avatar.Root>
		<Button variant="outline" onclick={() => (open = true)}>Change photo</Button>
	</Card.CardContent>
</Card.Card>

<AvatarCropper
	bind:open
	image={current}
	onsaved={(img) => {
		override = img;
		invalidateAll();
	}}
/>
