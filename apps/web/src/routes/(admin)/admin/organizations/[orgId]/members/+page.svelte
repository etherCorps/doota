<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { ColumnDef } from '@tanstack/table-core';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { ButtonGroup } from '$lib/components/ui/button-group/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import HostSelect from '$lib/components/admin/host-select.svelte';
	import { createUser, pauseUser, removeUser } from '$lib/rpc/manage-users.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	let { data } = $props();
	const org = $derived(data.org);

	type Member = (typeof data.members)[number];

	const columns: ColumnDef<Member, unknown>[] = [
		{ accessorKey: 'name', header: 'Member', cell: ({ row }) => renderSnippet(memberCell, row.original) },
		{ accessorKey: 'role', header: 'Role', cell: ({ row }) => renderSnippet(roleCell, row.original) },
		{ accessorKey: 'status', header: 'Status', cell: ({ row }) => renderSnippet(statusCell, row.original) },
		{ id: 'actions', header: '', enableSorting: false, cell: ({ row }) => renderSnippet(actionsCell, row.original) }
	];

	let addOpen = $state(false);
	let host = $derived(data.mailHosts[0]);
	let handled: unknown;
	$effect(() => {
		const result = createUser.result;
		if (result && result !== handled) {
			handled = result;
			if (result.success) {
				toast.success(result.message);
				addOpen = false;
				invalidateAll();
			} else {
				toast.error(result.message);
			}
		}
	});

	async function pause(userId: string) {
		const { paused } = await pauseUser(userId);
		toast.success(paused ? 'Login paused.' : 'Login resumed.');
		await invalidateAll();
	}

	let confirmRemove = $state<{ id: string; name: string } | null>(null);
	let removing = $state(false);

	async function remove() {
		if (!confirmRemove) return;
		removing = true;
		try {
			await removeUser(confirmRemove.id);
			toast.success('User removed.');
			confirmRemove = null;
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not remove user.');
		} finally {
			removing = false;
		}
	}
</script>

{#snippet memberCell(m: Member)}
	<div class="flex flex-col">
		<span class="font-medium">{m.name}</span>
		<span class="text-muted-foreground font-mono text-xs">{m.email}</span>
	</div>
{/snippet}

{#snippet roleCell(m: Member)}
	<Badge variant={m.role === 'member' ? 'secondary' : 'info'} class="capitalize">{m.role}</Badge>
{/snippet}

{#snippet statusCell(m: Member)}
	<StatusChip status={m.status} />
{/snippet}

{#snippet actionsCell(m: Member)}
	<ButtonGroup class="justify-end">
		<Button variant="outline" size="sm" onclick={() => pause(m.id)}>
			<PauseIcon class="size-3.5" />
			{m.status === 'paused' ? 'Resume' : 'Pause'}
		</Button>
		<Button
			variant="outline"
			size="sm"
			class="text-destructive hover:text-destructive"
			onclick={() => (confirmRemove = { id: m.id, name: m.name })}
		>
			<Trash2Icon class="size-3.5" /> Remove
		</Button>
	</ButtonGroup>
{/snippet}

<div class="flex flex-col gap-4">
	<PageHeader title="Members" description="People with access to {org.domain}. Adding one provisions a mailbox and sends an invite.">
		{#snippet action()}
			<Button class="gap-1.5" onclick={() => (addOpen = true)}>
				<PlusIcon class="size-4" /> Add member
			</Button>
		{/snippet}
	</PageHeader>
	<DataTable
		{columns}
		data={data.members}
		filterColumn="name"
		filterPlaceholder="Search members…"
		empty="No members yet. Add one to send an invite."
	/>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add member</Dialog.Title>
			<Dialog.Description>
				A mailbox on <span class="font-mono">{org.domain}</span> is created and an invite with a
				temporary password is sent to their external recovery address.
			</Dialog.Description>
		</Dialog.Header>

		<form {...createUser} class="flex flex-col gap-3 py-2">
			<input {...createUser.fields.organizationId.as('text')} type="hidden" value={org.id} />
			<Field.Field>
				<Field.Label>Name</Field.Label>
				<Input {...createUser.fields.name.as('text')} placeholder="Ada Lovelace" required />
				{#each createUser.fields.name.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>Mailbox email</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						{...createUser.fields.email.as('text')}
						placeholder="ada"
						autocomplete="off"
						required
					/>
					<InputGroup.Addon align="inline-end">
						<HostSelect hosts={data.mailHosts} bind:value={host} />
					</InputGroup.Addon>
				</InputGroup.Root>
				<input type="hidden" name="host" value={host} />
				{#each createUser.fields.email.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>Recovery email (external)</Field.Label>
				<Input
					{...createUser.fields.recoveryEmail.as('email')}
					placeholder="ada@gmail.com"
					autocomplete="off"
					required
				/>
				{#each createUser.fields.recoveryEmail.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<Field.Field>
				<Field.Label>Role</Field.Label>
				<select
					{...createUser.fields.role.as('text')}
					class="border-input bg-background h-9 rounded-md border px-3 text-sm"
				>
					<option value="member">Member</option>
					<option value="admin">Admin</option>
				</select>
				{#each createUser.fields.role.issues() ?? [] as issue (issue)}
					<Field.Error>{issue.message}</Field.Error>
				{/each}
			</Field.Field>
			<div class="flex justify-end gap-2 pt-2">
				<Button type="button" variant="ghost" onclick={() => (addOpen = false)} disabled={createUser.pending > 0}>
					Cancel
				</Button>
				<Button type="submit" disabled={createUser.pending > 0}>
					{#if createUser.pending > 0}<Spinner class="mr-1" />{/if}
					Send invite
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={!!confirmRemove} onOpenChange={(o) => !o && (confirmRemove = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Remove {confirmRemove?.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				This deletes the account, its mailbox membership and all active sessions. This can't be
				undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={removing}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={removing}
				onclick={(e) => {
					e.preventDefault();
					remove();
				}}
				class="bg-destructive text-white hover:bg-destructive/90"
			>
				{#if removing}<Spinner class="mr-1" />{/if}
				Remove
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
