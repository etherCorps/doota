<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { ColumnDef } from '@tanstack/table-core';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import { addSuppression, removeSuppression } from '$lib/rpc/suppressions.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { errorMessage } from '$lib/utils/error-message';

	let { data } = $props();
	const org = $derived(data.org);

	type Row = (typeof data.suppressions)[number];

	// hard_bounce / complaint are automatic (from bounce DSNs); manual is admin-added.
	const REASON: Record<string, { label: string; variant: 'destructive' | 'warning' | 'secondary' | 'outline' }> = {
		hard_bounce: { label: 'hard bounce', variant: 'destructive' },
		complaint: { label: 'complaint', variant: 'warning' },
		manual: { label: 'manual', variant: 'secondary' }
	};
	const fmtDate = (date: Date | string | number) =>
		new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

	let addOpen = $state(false);
	let address = $state('');
	let saving = $state(false);
	// Addresses with a remove in flight — disables the row button.
	let removing = $state<Record<string, boolean>>({});

	const columns: ColumnDef<Row, unknown>[] = [
		{ accessorKey: 'address', header: 'Address', cell: ({ row }) => renderSnippet(addressCell, row.original) },
		{ id: 'reason', header: 'Reason', enableSorting: false, cell: ({ row }) => renderSnippet(reasonCell, row.original) },
		{ accessorKey: 'lastSeenAt', header: 'Last seen', cell: ({ row }) => renderSnippet(seenCell, row.original) },
		{ id: 'actions', header: '', enableSorting: false, cell: ({ row }) => renderSnippet(actionsCell, row.original) }
	];

	async function add() {
		saving = true;
		try {
			const res = await addSuppression({ orgId: org.id, address });
			if (res.success) {
				toast.success(`Suppressed ${address}`);
				addOpen = false;
				address = '';
				await invalidateAll();
			} else {
				toast.error(res.message);
			}
		} catch (err) {
			toast.error(errorMessage(err, 'Could not add the address.'));
		} finally {
			saving = false;
		}
	}

	async function remove(addr: string) {
		removing = { ...removing, [addr]: true };
		try {
			await removeSuppression({ orgId: org.id, address: addr });
			toast.success(`Removed ${addr}`);
			await invalidateAll();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not remove the address.'));
		} finally {
			const next = { ...removing };
			delete next[addr];
			removing = next;
		}
	}
</script>

{#snippet addressCell(row: Row)}
	<span class="font-mono">{row.address}</span>
{/snippet}

{#snippet reasonCell(row: Row)}
	{@const meta = REASON[row.reason] ?? { label: row.reason, variant: 'outline' as const }}
	<Badge variant={meta.variant} class="text-[10px]">{meta.label}</Badge>
{/snippet}

{#snippet seenCell(row: Row)}
	<span class="text-muted-foreground text-sm">{fmtDate(row.lastSeenAt)}</span>
{/snippet}

{#snippet actionsCell(row: Row)}
	<div class="flex justify-end">
		<AlertDialog.Root>
			<AlertDialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" disabled={removing[row.address]}>
						{#if removing[row.address]}<Spinner class="mr-1" />{/if}
						Remove
					</Button>
				{/snippet}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Remove {row.address}?</AlertDialog.Title>
					<AlertDialog.Description>
						This re-enables sending to <code class="font-mono">{row.address}</code>, a previously
						suppressed address. If it's still bad, future sends may bounce or draw spam complaints.
					</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel disabled={removing[row.address]}>Cancel</AlertDialog.Cancel>
					<AlertDialog.Action
						disabled={removing[row.address]}
						onclick={(event) => {
							event.preventDefault();
							remove(row.address);
						}}
						class="bg-destructive text-white hover:bg-destructive/90"
					>
						{#if removing[row.address]}<Spinner class="mr-1" />{/if}
						Remove
					</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</div>
{/snippet}

<div class="flex flex-col gap-4">
	<PageHeader
		title="Suppressions"
		description="Addresses that won't receive mail from {org.domain}. Hard bounces and spam complaints are added automatically; add addresses manually to stop sending to them. Removing an address re-enables sending."
	>
		{#snippet action()}
			<Button class="gap-1.5" onclick={() => (addOpen = true)}>
				<PlusIcon class="size-4" /> Add address
			</Button>
		{/snippet}
	</PageHeader>

	<DataTable
		{columns}
		data={data.suppressions}
		filterColumn="address"
		filterPlaceholder="Search addresses…"
		empty="No suppressed addresses."
	/>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Suppress an address</Dialog.Title>
			<Dialog.Description>
				Mail to this address will be dropped before it's sent. Use this for addresses you know are
				bad or that asked to stop receiving mail.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3 py-2">
			<Field.Field>
				<Field.Label>Email address</Field.Label>
				<Input bind:value={address} placeholder="user@example.com" autocomplete="off" type="email" />
			</Field.Field>
			<div class="flex justify-end gap-2 pt-2">
				<Button type="button" variant="ghost" onclick={() => (addOpen = false)} disabled={saving}>
					Cancel
				</Button>
				<Button type="button" onclick={add} disabled={saving || !address}>
					{#if saving}<Spinner class="mr-1" />{/if}
					Suppress
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
