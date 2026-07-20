<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { createSharedMailbox, deactivateMailbox } from '$lib/rpc/mailbox.remote';
	import { generateAlias } from '$lib/rpc/alias.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let { data } = $props();
	const org = $derived(data.org);

	let addOpen = $state(false);
	let localPart = $state('');
	let displayName = $state('');
	let saving = $state(false);

	async function createMailbox() {
		saving = true;
		try {
			const res = await createSharedMailbox({ orgId: org.id, localPart, displayName });
			if (res.success) {
				toast.success(`Created ${res.address}`);
				addOpen = false;
				localPart = '';
				displayName = '';
				await invalidateAll();
			} else {
				toast.error(res.message);
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create the mailbox.');
		} finally {
			saving = false;
		}
	}

	async function toggleActive(id: string, active: boolean) {
		try {
			await deactivateMailbox({ mailboxId: id, active });
			toast.success(active ? 'Mailbox activated.' : 'Mailbox deactivated.');
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update the mailbox.');
		}
	}

	async function makeAlias(id: string) {
		try {
			const res = await generateAlias({ mailboxId: id });
			toast.success(`Alias created: ${res.address}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create an alias.');
		}
	}
</script>

<div class="flex flex-col gap-3">
	<div class="flex justify-end">
		<Button class="gap-1.5" onclick={() => (addOpen = true)}>
			<PlusIcon class="size-4" /> Add shared mailbox
		</Button>
	</div>

	<div class="overflow-hidden rounded-md border">
		<table class="w-full text-sm">
			<thead class="bg-muted/50 text-muted-foreground">
				<tr>
					<th class="px-4 py-2 text-left font-medium">Address</th>
					<th class="px-4 py-2 text-left font-medium">Type</th>
					<th class="px-4 py-2 text-left font-medium">Status</th>
					<th class="px-4 py-2 text-right font-medium"></th>
				</tr>
			</thead>
			<tbody>
				{#each data.mailboxes as mb (mb.id)}
					<tr class="border-t">
						<td class="px-4 py-2 font-mono">{mb.address}</td>
						<td class="px-4 py-2">
							<Badge variant={mb.isPersonal ? 'default' : 'secondary'}>
								{mb.isPersonal ? 'personal' : 'shared'}
							</Badge>
						</td>
						<td class="px-4 py-2">
							<Badge variant={mb.isActive ? 'default' : 'outline'}>
								{mb.isActive ? 'active' : 'inactive'}
							</Badge>
						</td>
						<td class="px-4 py-2">
							<div class="flex justify-end gap-2">
								<Button variant="outline" size="sm" onclick={() => makeAlias(mb.id)}>
									Add alias
								</Button>
								{#if !mb.isPersonal}
									<Button
										variant="outline"
										size="sm"
										onclick={() => toggleActive(mb.id, !mb.isActive)}
									>
										{mb.isActive ? 'Deactivate' : 'Activate'}
									</Button>
								{/if}
							</div>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="4" class="text-muted-foreground px-4 py-8 text-center">
							No mailboxes yet. Personal mailboxes are created when you add members.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add shared mailbox</Dialog.Title>
			<Dialog.Description>
				A shared address on <span class="font-mono">{org.domain}</span> (e.g. support@). Grant members
				access from the members tab.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3 py-2">
			<Field.Field>
				<Field.Label>Mailbox name</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input bind:value={localPart} placeholder="support" autocomplete="off" />
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono">@{org.domain}</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>
			</Field.Field>
			<Field.Field>
				<Field.Label>Display name (optional)</Field.Label>
				<Input bind:value={displayName} placeholder="Support" autocomplete="off" />
			</Field.Field>
			<div class="flex justify-end gap-2 pt-2">
				<Button type="button" variant="ghost" onclick={() => (addOpen = false)} disabled={saving}>
					Cancel
				</Button>
				<Button type="button" onclick={createMailbox} disabled={saving || !localPart}>
					{#if saving}<Spinner class="mr-1" />{/if}
					Create
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
