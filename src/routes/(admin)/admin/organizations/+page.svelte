<script lang="ts">
	import { invalidateAll, goto } from '$app/navigation';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let { data } = $props();

	let domain = $state('');
	let creating = $state(false);

	function slugify(d: string) {
		return d
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9.]/g, '')
			.replace(/\./g, '-');
	}

	async function createOrg(e: SubmitEvent) {
		e.preventDefault();
		const d = domain.trim().toLowerCase();
		if (!d) return;
		creating = true;
		// `domain` is a server additionalField the client types don't infer; the
		// server validates it (required/unique/format).
		const payload = { name: d, slug: slugify(d), domain: d };
		const { error } = await authClient.organization.create(
			payload as unknown as Parameters<typeof authClient.organization.create>[0]
		);
		creating = false;
		if (error) {
			toast.error(error.message ?? 'Could not create organization.');
			return;
		}
		domain = '';
		toast.success(`Organization ${d} created.`);
		await invalidateAll();
	}
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
	<div class="flex flex-col gap-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Organizations</h1>
		<p class="text-muted-foreground text-sm">
			Pick an organization to manage its members and settings.
		</p>
	</div>

	{#if data.orgs.length}
		<div class="flex flex-col gap-2">
			{#each data.orgs as org (org.id)}
				<button
					type="button"
					onclick={() => goto(`/admin/organizations/${org.id}`)}
					class="hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-4 text-left transition-colors"
				>
					<div class="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-md">
						<GlobeIcon class="size-4" />
					</div>
					<div class="flex flex-col">
						<span class="font-mono text-sm font-medium">{org.domain}</span>
						<span class="text-muted-foreground text-xs capitalize">{org.membershipRole}</span>
					</div>
					<ChevronRightIcon class="text-muted-foreground ml-auto size-4" />
				</button>
			{/each}
		</div>
	{:else}
		<Card.Card>
			<Card.CardContent class="flex flex-col items-center gap-2 py-10 text-center">
				<div class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
					<GlobeIcon class="size-5" />
				</div>
				<p class="font-medium">No organizations yet</p>
				<p class="text-muted-foreground text-sm">
					{data.canCreate
						? 'Create one below to start adding domains and members.'
						: 'Ask a super-admin to add a domain before you can manage members.'}
				</p>
			</Card.CardContent>
		</Card.Card>
	{/if}

	{#if data.canCreate}
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="flex items-center gap-2 font-heading">
					<PlusIcon class="size-4" /> Create organization
				</Card.CardTitle>
				<Card.CardDescription>
					One organization per mail domain you operate. You become its owner.
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent>
				<form onsubmit={createOrg} class="flex items-end gap-2">
					<Field.Field class="flex-1">
						<Field.Label>Domain</Field.Label>
						<Input type="text" class="font-mono" placeholder="acme.com" bind:value={domain} required />
					</Field.Field>
					<Button type="submit" disabled={creating}>
						{#if creating}<Spinner class="mr-1" />{/if}
						Create
					</Button>
				</form>
			</Card.CardContent>
		</Card.Card>
	{/if}
</div>
