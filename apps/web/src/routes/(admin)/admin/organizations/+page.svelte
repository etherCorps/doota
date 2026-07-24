<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { ColumnDef } from '@tanstack/table-core';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import DomainOnboarder from '$lib/components/admin/domain-onboarder.svelte';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let { data } = $props();

	type Org = (typeof data.orgs)[number];

	const STATUS: Record<string, string> = {
		pending_zone: 'pending',
		pending_nameservers: 'pending',
		wiring: 'pending',
		active: 'active',
		error: 'failed'
	};
	const chip = (s: string) => STATUS[s] ?? 'pending';
	const orgHref = (id: string) => `${resolve('/admin/organizations')}/${id}`;

	let addOpen = $state(false);

	const columns: ColumnDef<Org, unknown>[] = [
		{ accessorKey: 'name', header: 'Organization', cell: ({ row }) => renderSnippet(nameCell, row.original) },
		{ accessorKey: 'domain', header: 'Domain', cell: ({ row }) => renderSnippet(domainCell, row.original) },
		{ accessorKey: 'status', header: 'Status', cell: ({ row }) => renderSnippet(statusCell, row.original) },
		{ accessorKey: 'members', header: 'Members', cell: ({ row }) => renderSnippet(membersCell, row.original) },
		{ id: 'go', header: '', enableSorting: false, cell: () => renderSnippet(goCell) }
	];
</script>

{#snippet nameCell(org: Org)}
	<a href={orgHref(org.id)} class="flex items-center gap-3 hover:underline">
		<div class="bg-muted text-muted-foreground flex size-8 items-center justify-center overflow-hidden rounded-md">
			{#if org.logo}
				<img src={org.logo} alt="" class="size-full object-cover" />
			{:else}
				<GlobeIcon class="size-4" />
			{/if}
		</div>
		<span class="font-medium">{org.name}</span>
	</a>
{/snippet}

{#snippet goCell()}
	<div class="flex justify-end">
		<ChevronRightIcon class="text-muted-foreground size-4" />
	</div>
{/snippet}

{#snippet domainCell(org: Org)}
	<span class="text-muted-foreground font-mono text-sm">{org.domain}</span>
{/snippet}

{#snippet statusCell(org: Org)}
	<StatusChip status={chip(org.status)} />
{/snippet}

{#snippet membersCell(org: Org)}
	<span class="tabular-nums">{org.members}</span>
{/snippet}

<div class="flex w-full flex-col gap-6 p-4 sm:p-6 md:p-8">
	<div class="flex items-center justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h1 class="font-heading text-2xl font-semibold tracking-tight">Organizations</h1>
			<p class="text-muted-foreground text-sm">
				One organization per mail domain. Open one to manage DNS, members and settings.
			</p>
		</div>
		{#if data.canCreate}
			<Button class="gap-1.5" onclick={() => (addOpen = true)}>
				<PlusIcon class="size-4" /> Add organization
			</Button>
		{/if}
	</div>

	{#if data.orgs.length}
		<DataTable
			{columns}
			data={data.orgs}
			filterColumn="name"
			filterPlaceholder="Search organizations…"
			empty="No organizations match your search."
			rowHref={(o) => orgHref(o.id)}
		/>
	{:else}
		<Card.Card>
			<Card.CardContent class="flex flex-col items-center gap-3 py-10 text-center">
				<div class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
					<GlobeIcon class="size-5" />
				</div>
				<p class="font-medium">No organizations yet</p>
				<p class="text-muted-foreground text-sm">
					{data.canCreate
						? 'Onboard a domain to create its organization.'
						: 'Ask a super-admin to onboard a domain before you can manage members.'}
				</p>
				{#if data.canCreate}
					<Button onclick={() => (addOpen = true)}>Onboard a domain</Button>
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}
</div>

<!-- Onboard a domain (superadmin) — Cloudflare zone picker + manual add -->
<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add organization</Dialog.Title>
			<Dialog.Description>
				Pick a domain from your Cloudflare account. Active zones wire mail immediately; pending
				zones return nameservers to delegate first.
			</Dialog.Description>
		</Dialog.Header>

		<DomainOnboarder onChange={() => invalidateAll()} />
	</Dialog.Content>
</Dialog.Root>
