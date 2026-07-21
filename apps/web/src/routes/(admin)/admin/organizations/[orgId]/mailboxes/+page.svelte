<script lang="ts">
	import type { ColumnDef } from '@tanstack/table-core';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import HostSelect from '$lib/components/admin/host-select.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { createSharedMailbox } from '$lib/rpc/mailbox.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import BotIcon from '@lucide/svelte/icons/bot';

	let { data } = $props();
	const org = $derived(data.org);
	const manageBase = $derived(`${resolve('/admin/organizations')}/${org.id}/mailboxes`);

	type Mailbox = (typeof data.mailboxes)[number];

	// Mailbox categories (a mailbox is exactly one).
	const kindOf = (m: Mailbox) => (m.isService ? 'service' : m.isPersonal ? 'individual' : 'shared');
	const sharedMailboxes = $derived(data.mailboxes.filter((m) => kindOf(m) === 'shared'));
	const serviceMailboxes = $derived(data.mailboxes.filter((m) => kindOf(m) === 'service'));
	const personalMailboxes = $derived(data.mailboxes.filter((m) => kindOf(m) === 'individual'));

	// Segmented filter over a single table.
	type Filter = 'all' | 'shared' | 'service' | 'individual';
	let filter = $state<Filter>('all');
	const segments = $derived([
		{ key: 'all' as const, label: 'All', n: data.mailboxes.length },
		{ key: 'shared' as const, label: 'Shared', n: sharedMailboxes.length },
		{ key: 'service' as const, label: 'Service', n: serviceMailboxes.length },
		{ key: 'individual' as const, label: 'Individual', n: personalMailboxes.length }
	]);
	const filtered = $derived(
		filter === 'all' ? data.mailboxes : data.mailboxes.filter((m) => kindOf(m) === filter)
	);

	let addOpen = $state(false);
	let localPart = $state('');
	let displayName = $state('');
	let isService = $state(false);
	// Defaulted when the add dialog opens — kept out of the initializer so it
	// doesn't capture only the initial `data`.
	let host = $state('');
	const openAdd = () => {
		host = data.mailHosts[0];
		addOpen = true;
	};
	let saving = $state(false);

	// mailboxId → number of members with any grant (drives the access count column).
	const accessCountByMailbox = $derived.by(() => {
		const map = new Map<string, Set<string>>();
		for (const g of data.grants) {
			const set = map.get(g.mailboxId) ?? new Set<string>();
			set.add(g.userId);
			map.set(g.mailboxId, set);
		}
		return map;
	});

	const columns: ColumnDef<Mailbox, unknown>[] = [
		{ accessorKey: 'address', header: 'Address', cell: ({ row }) => renderSnippet(addressCell, row.original) },
		{ id: 'kind', header: 'Type', enableSorting: false, cell: ({ row }) => renderSnippet(typeCell, row.original) },
		{ id: 'access', header: 'Access', enableSorting: false, cell: ({ row }) => renderSnippet(accessCell, row.original) },
		{ accessorKey: 'isActive', header: 'Status', cell: ({ row }) => renderSnippet(statusCell, row.original) },
		{ id: 'actions', header: '', enableSorting: false, cell: ({ row }) => renderSnippet(actionsCell, row.original) }
	];

	async function createMailbox() {
		saving = true;
		try {
			const res = await createSharedMailbox({ orgId: org.id, localPart, displayName, isService, host });
			if (res.success) {
				toast.success(`Created ${res.address}`);
				addOpen = false;
				localPart = '';
				displayName = '';
				isService = false;
				host = data.mailHosts[0];
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
</script>

{#snippet addressCell(mb: Mailbox)}
	<span class="font-mono">{mb.address}</span>
{/snippet}

{#snippet typeCell(mb: Mailbox)}
	{#if mb.isService}
		<span class="border-p1/30 bg-p1/10 text-p1 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
			<BotIcon class="size-3" /> service
		</span>
	{:else if mb.isPersonal}
		<Badge variant="outline" class="text-[10px]">individual</Badge>
	{:else}
		<Badge variant="secondary" class="text-[10px]">shared</Badge>
	{/if}
{/snippet}

{#snippet accessCell(mb: Mailbox)}
	{#if mb.isPersonal}
		<span class="text-muted-foreground">—</span>
	{:else}
		{@const n = accessCountByMailbox.get(mb.id)?.size ?? 0}
		<span class="text-muted-foreground">{n} {n === 1 ? 'member' : 'members'}</span>
	{/if}
{/snippet}

{#snippet statusCell(mb: Mailbox)}
	<Badge variant={mb.isActive ? 'default' : 'outline'}>{mb.isActive ? 'active' : 'inactive'}</Badge>
{/snippet}

{#snippet actionsCell(mb: Mailbox)}
	<div class="flex justify-end">
		{#if !mb.isPersonal}
			<Button variant="outline" size="sm" href="{manageBase}/{mb.id}">Manage</Button>
		{/if}
	</div>
{/snippet}

<div class="flex flex-col gap-4">
	<PageHeader title="Mailboxes" description="Team, service, and individual addresses on {org.domain}.">
		{#snippet action()}
			<Button class="gap-1.5" onclick={openAdd}>
				<PlusIcon class="size-4" /> Add mailbox
			</Button>
		{/snippet}
	</PageHeader>

	<ToggleGroup.Root
		type="single"
		variant="outline"
		size="sm"
		value={filter}
		onValueChange={(v) => v && (filter = v as Filter)}
		class="justify-start"
	>
		{#each segments as s (s.key)}
			<ToggleGroup.Item value={s.key} class="gap-1.5">
				{s.label}
				<span class="text-muted-foreground text-xs tabular-nums">{s.n}</span>
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>

	<DataTable
		{columns}
		data={filtered}
		filterColumn="address"
		filterPlaceholder="Search mailboxes…"
		empty="No mailboxes in this view."
	/>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add mailbox</Dialog.Title>
			<Dialog.Description>
				A team address on <span class="font-mono">{org.domain}</span> (e.g. support@). Grant members
				access from its Manage page, or make it a service mailbox for API sending.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3 py-2">
			<Field.Field>
				<Field.Label>Mailbox name</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input bind:value={localPart} placeholder="support" autocomplete="off" />
					<InputGroup.Addon align="inline-end">
						<HostSelect hosts={data.mailHosts} bind:value={host} />
					</InputGroup.Addon>
				</InputGroup.Root>
			</Field.Field>
			<Field.Field>
				<Field.Label>Display name (optional)</Field.Label>
				<Input bind:value={displayName} placeholder="Support" autocomplete="off" />
			</Field.Field>
			<label class="flex items-start gap-3 rounded-md border p-3">
				<Switch checked={isService} onCheckedChange={(v) => (isService = v)} aria-label="Service mailbox" />
				<span class="flex flex-col gap-0.5">
					<span class="text-sm font-medium">Service mailbox</span>
					<span class="text-muted-foreground text-xs">
						A non-human sending identity for automation. Admins issue API keys against it (e.g. noreply@, notifications@).
					</span>
				</span>
			</label>
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
