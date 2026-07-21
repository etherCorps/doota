<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import { updateOrgProfile } from '$lib/rpc/domains.remote.js';

	let { data } = $props();
	const org = $derived(data.org);

	// Editable copies seeded from the load once; the form owns them thereafter.
	let name = $state(untrack(() => data.org.name));
	let logo = $state(untrack(() => data.org.logo ?? ''));
	let saving = $state(false);

	async function save() {
		saving = true;
		try {
			await updateOrgProfile({ orgId: org.id, name: name.trim(), logo: logo.trim() });
			toast.success('Organization updated.');
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save.');
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<PageHeader
		title="Settings"
		description="Organization profile — the display name and logo. A verified logo improves mail branding (BIMI) in inboxes."
	/>
	<Card.Card class="max-w-2xl">
		<Card.CardContent class="space-y-4 pt-6">
		<Field.Field>
			<Field.Label>Domain</Field.Label>
			<Input value={org.domain} readonly class="font-mono" />
			<Field.Description>The domain is fixed — it identifies the organization.</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label>Name</Field.Label>
			<Input bind:value={name} placeholder="Acme Inc" />
		</Field.Field>
		<Field.Field>
			<Field.Label>Logo URL</Field.Label>
			<Input bind:value={logo} placeholder="https://acme.com/logo.svg" type="url" />
			<Field.Description>
				Public HTTPS URL. BIMI requires a square SVG Tiny-PS for the verified-logo badge.
			</Field.Description>
		</Field.Field>
		<div class="flex justify-end">
			<Button disabled={saving || !name.trim()} onclick={save}>
				{#if saving}<Spinner class="mr-1" />{/if}
				Save
			</Button>
		</div>
	</Card.CardContent>
	</Card.Card>
</div>
