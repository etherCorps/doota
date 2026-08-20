<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { ColumnDef } from '@tanstack/table-core';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import HostSelect from '$lib/components/admin/host-select.svelte';
	import MemberSheet from '$lib/components/admin/member-sheet.svelte';
	import { createUser } from '$lib/rpc/manage-users.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let { data } = $props();
	const org = $derived(data.org);

	type Member = (typeof data.members)[number];

	const columns: ColumnDef<Member, unknown>[] = [
		{ accessorKey: 'name', header: 'Member', cell: ({ row }) => renderSnippet(memberCell, row.original) },
		{ accessorKey: 'role', header: 'Role', cell: ({ row }) => renderSnippet(roleCell, row.original) },
		{ accessorKey: 'status', header: 'Status', cell: ({ row }) => renderSnippet(statusCell, row.original) },
		{ id: 'actions', header: '', enableSorting: false, cell: () => renderSnippet(chevronCell) }
	];

	let selectedMember = $state<Member | null>(null);

	let addOpen = $state(false);
	let host = $derived(data.mailHosts[0]);
	// Role rides a hidden input (bits-ui `name`), so it needs its own state and
	// its own reset — the remote form's own fields clear themselves, this one
	// won't. Defaulting to member is what stops an untouched field submitting
	// nothing and failing the schema.
	const ROLE_LABEL = { member: 'Member', admin: 'Admin' } as const;
	let role = $state<keyof typeof ROLE_LABEL>('member');
	// The field name for the hidden input. It only exists on the `as()` result —
	// fields themselves expose value()/set()/issues()/as() and nothing else, and
	// the index signature types a bogus `.name()` as `any`, so a wrong guess here
	// type-checks clean and then throws at render time.
	const roleFieldName = $derived(createUser.fields.role.as('select').name);
	$effect(() => {
		if (!addOpen) role = 'member';
	});
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
</script>

{#snippet memberCell(member: Member)}
	<div class="flex flex-col">
		<span class="font-medium">{member.name}</span>
		<span class="text-muted-foreground font-mono text-xs">{member.email}</span>
	</div>
{/snippet}

{#snippet roleCell(member: Member)}
	<Badge variant={member.role === 'member' ? 'secondary' : 'info'} class="capitalize">{member.role}</Badge>
{/snippet}

{#snippet statusCell(member: Member)}
	<StatusChip status={member.status} />
{/snippet}

{#snippet chevronCell()}
	<ChevronRightIcon class="text-muted-foreground ml-auto size-4" />
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
		onRowClick={(member) => (selectedMember = member)}
	/>
</div>

<MemberSheet
	member={selectedMember}
	organizationId={org.id}
	onClose={() => (selectedMember = null)}
	onChanged={invalidateAll}
/>

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
				<Field.Label for="member-new-role">Role</Field.Label>
				<Select.Root type="single" name={roleFieldName} bind:value={role}>
					<Select.Trigger id="member-new-role" class="w-full">
						{ROLE_LABEL[role]}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="member" label="Member" />
						<Select.Item value="admin" label="Admin" />
					</Select.Content>
				</Select.Root>
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
