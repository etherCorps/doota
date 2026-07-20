<script lang="ts">
	import type { ColumnDef } from '@tanstack/table-core';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import {
		createSharedMailbox,
		deactivateMailbox,
		grantMailboxAccess,
		revokeMailboxAccess
	} from '$lib/rpc/mailbox.remote';
	import { generateAlias } from '$lib/rpc/alias.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UsersIcon from '@lucide/svelte/icons/users';
	import SearchIcon from '@lucide/svelte/icons/search';

	let { data } = $props();
	const org = $derived(data.org);

	type Mailbox = (typeof data.mailboxes)[number];

	// Shared and individual (personal) mailboxes live in separate tables: only
	// shared mailboxes are provisioned here (personal ones come with members),
	// and only shared ones carry access grants / activation.
	const sharedMailboxes = $derived(data.mailboxes.filter((m) => !m.isPersonal));
	const personalMailboxes = $derived(data.mailboxes.filter((m) => m.isPersonal));

	// Honest counts for the summary strip — distinct members holding any grant.
	const membersWithAccess = $derived(new Set(data.grants.map((g) => g.userId)).size);

	let addOpen = $state(false);
	let localPart = $state('');
	let displayName = $state('');
	let saving = $state(false);

	// Which shared mailbox's access dialog is open, and per-toggle busy state.
	let accessFor = $state<{ id: string; address: string } | null>(null);
	let busyUser = $state<string | null>(null);
	let memberQuery = $state('');

	// Members filtered by the dialog's search box (name or email).
	const filteredMembers = $derived.by(() => {
		const q = memberQuery.trim().toLowerCase();
		if (!q) return data.members;
		return data.members.filter(
			(m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
		);
	});

	// mailboxId → (userId → canManage) from the current grants (recomputed on load).
	const grantsByMailbox = $derived.by(() => {
		const map = new Map<string, Map<string, boolean>>();
		for (const g of data.grants) {
			const inner = map.get(g.mailboxId) ?? new Map<string, boolean>();
			inner.set(g.userId, g.canManage);
			map.set(g.mailboxId, inner);
		}
		return map;
	});
	const currentGrants = $derived(
		accessFor ? (grantsByMailbox.get(accessFor.id) ?? new Map<string, boolean>()) : new Map<string, boolean>()
	);

	const sharedColumns: ColumnDef<Mailbox, unknown>[] = [
		{ accessorKey: 'address', header: 'Address', cell: ({ row }) => renderSnippet(addressCell, row.original) },
		{ id: 'access', header: 'Access', enableSorting: false, cell: ({ row }) => renderSnippet(accessCell, row.original) },
		{ accessorKey: 'isActive', header: 'Status', cell: ({ row }) => renderSnippet(statusCell, row.original) },
		{ id: 'actions', header: '', enableSorting: false, cell: ({ row }) => renderSnippet(sharedActionsCell, row.original) }
	];
	const personalColumns: ColumnDef<Mailbox, unknown>[] = [
		{ accessorKey: 'address', header: 'Address', cell: ({ row }) => renderSnippet(addressCell, row.original) },
		{ accessorKey: 'isActive', header: 'Status', cell: ({ row }) => renderSnippet(statusCell, row.original) },
		{ id: 'actions', header: '', enableSorting: false, cell: ({ row }) => renderSnippet(personalActionsCell, row.original) }
	];

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

	async function setAccess(userId: string, granted: boolean) {
		if (!accessFor) return;
		busyUser = userId;
		try {
			if (granted) await grantMailboxAccess({ mailboxId: accessFor.id, userId });
			else await revokeMailboxAccess({ mailboxId: accessFor.id, userId });
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update access.');
		} finally {
			busyUser = null;
		}
	}

	async function setManage(userId: string, canManage: boolean) {
		if (!accessFor) return;
		busyUser = userId;
		try {
			await grantMailboxAccess({ mailboxId: accessFor.id, userId, canManage });
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update access.');
		} finally {
			busyUser = null;
		}
	}
</script>

{#snippet addressCell(mb: Mailbox)}
	<span class="font-mono">{mb.address}</span>
{/snippet}

{#snippet accessCell(mb: Mailbox)}
	{@const n = grantsByMailbox.get(mb.id)?.size ?? 0}
	<span class="text-muted-foreground">{n} {n === 1 ? 'member' : 'members'}</span>
{/snippet}

{#snippet statusCell(mb: Mailbox)}
	<Badge variant={mb.isActive ? 'default' : 'outline'}>{mb.isActive ? 'active' : 'inactive'}</Badge>
{/snippet}

{#snippet sharedActionsCell(mb: Mailbox)}
	<div class="flex justify-end gap-2">
		<Button
			variant="outline"
			size="sm"
			class="gap-1.5"
			onclick={() => (accessFor = { id: mb.id, address: mb.address })}
		>
			<UsersIcon class="size-3.5" /> Manage access
		</Button>
		<Button variant="outline" size="sm" onclick={() => toggleActive(mb.id, !mb.isActive)}>
			{mb.isActive ? 'Deactivate' : 'Activate'}
		</Button>
	</div>
{/snippet}

{#snippet personalActionsCell(mb: Mailbox)}
	<div class="flex justify-end">
		<Button variant="outline" size="sm" onclick={() => makeAlias(mb.id)}>Add alias</Button>
	</div>
{/snippet}

<div class="flex flex-col gap-8">
	<dl class="grid grid-cols-3 divide-x rounded-lg border">
		<div class="flex flex-col gap-0.5 px-4 py-3">
			<dt class="text-muted-foreground text-xs">Shared</dt>
			<dd class="font-heading text-2xl font-semibold tabular-nums">{sharedMailboxes.length}</dd>
		</div>
		<div class="flex flex-col gap-0.5 px-4 py-3">
			<dt class="text-muted-foreground text-xs">Individual</dt>
			<dd class="font-heading text-2xl font-semibold tabular-nums">{personalMailboxes.length}</dd>
		</div>
		<div class="flex flex-col gap-0.5 px-4 py-3">
			<dt class="text-muted-foreground text-xs">Members with access</dt>
			<dd class="font-heading text-2xl font-semibold tabular-nums">{membersWithAccess}</dd>
		</div>
	</dl>

	<section class="flex flex-col gap-3">
		<div class="flex items-end justify-between gap-3">
			<div class="flex flex-col">
				<div class="flex items-center gap-2">
					<h2 class="font-heading text-lg font-semibold">Shared mailboxes</h2>
					<Badge variant="secondary" class="tabular-nums">{sharedMailboxes.length}</Badge>
				</div>
				<p class="text-muted-foreground text-sm">
					Team addresses like support@ — grant members access to read and send.
				</p>
			</div>
			<Button class="gap-1.5" onclick={() => (addOpen = true)}>
				<PlusIcon class="size-4" /> Add shared mailbox
			</Button>
		</div>
		<DataTable
			columns={sharedColumns}
			data={sharedMailboxes}
			filterColumn="address"
			filterPlaceholder="Search shared mailboxes…"
			empty="No shared mailboxes yet. Add one to give the team a common inbox."
		/>
	</section>

	<section class="flex flex-col gap-3">
		<div class="flex flex-col">
			<div class="flex items-center gap-2">
				<h2 class="font-heading text-lg font-semibold">Individual mailboxes</h2>
				<Badge variant="secondary" class="tabular-nums">{personalMailboxes.length}</Badge>
			</div>
			<p class="text-muted-foreground text-sm">
				One per member — created automatically when you add a member.
			</p>
		</div>
		<DataTable
			columns={personalColumns}
			data={personalMailboxes}
			filterColumn="address"
			filterPlaceholder="Search individual mailboxes…"
			empty="No individual mailboxes yet. They appear when you add members."
		/>
	</section>
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add shared mailbox</Dialog.Title>
			<Dialog.Description>
				A shared address on <span class="font-mono">{org.domain}</span> (e.g. support@). Grant members
				access with “Manage access” once it exists.
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

<Dialog.Root open={!!accessFor} onOpenChange={(o) => !o && ((accessFor = null), (memberQuery = ''))}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Manage access</Dialog.Title>
			<Dialog.Description>
				Who can read and send as <span class="font-mono">{accessFor?.address}</span>. Managers can
				also administer the mailbox.
			</Dialog.Description>
		</Dialog.Header>

		<div class="relative">
			<SearchIcon class="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
			<Input bind:value={memberQuery} placeholder="Search members by name or email…" class="pl-8" />
		</div>

		<ScrollArea class="max-h-96 rounded-md border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Member</Table.Head>
						<Table.Head class="w-24 text-center">Access</Table.Head>
						<Table.Head class="w-28 text-center">Manager</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each filteredMembers as m (m.id)}
						{@const granted = currentGrants.has(m.id)}
						{@const canManage = currentGrants.get(m.id) ?? false}
						<Table.Row>
							<Table.Cell>
								<div class="flex min-w-0 flex-col">
									<span class="truncate text-sm font-medium">{m.name}</span>
									<span class="text-muted-foreground truncate font-mono text-xs">{m.email}</span>
								</div>
							</Table.Cell>
							<Table.Cell class="text-center">
								<Switch
									checked={granted}
									disabled={busyUser === m.id}
									onCheckedChange={(v) => setAccess(m.id, v)}
									aria-label="Access"
								/>
							</Table.Cell>
							<Table.Cell class="text-center">
								{#if granted}
									<Switch
										checked={canManage}
										disabled={busyUser === m.id}
										onCheckedChange={(v) => setManage(m.id, v)}
										aria-label="Manager"
									/>
								{:else}
									<span class="text-muted-foreground text-xs">—</span>
								{/if}
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={3} class="text-muted-foreground py-6 text-center text-sm">
								{data.members.length ? 'No members match your search.' : 'No members in this organization yet.'}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</ScrollArea>

		<div class="flex items-center justify-between pt-2">
			<span class="text-muted-foreground text-xs">{currentGrants.size} with access</span>
			<Button type="button" variant="ghost" onclick={() => ((accessFor = null), (memberQuery = ''))}>Done</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
