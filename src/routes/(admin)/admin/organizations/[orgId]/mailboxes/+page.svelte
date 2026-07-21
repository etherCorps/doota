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
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { createSharedMailbox } from '$lib/rpc/mailbox.remote';
	import { generateAlias } from '$lib/rpc/alias.remote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import BotIcon from '@lucide/svelte/icons/bot';

	let { data } = $props();
	const org = $derived(data.org);
	const manageBase = $derived(`${resolve('/admin/organizations')}/${org.id}/mailboxes`);

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
	let isService = $state(false);
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
			const res = await createSharedMailbox({ orgId: org.id, localPart, displayName, isService });
			if (res.success) {
				toast.success(`Created ${res.address}`);
				addOpen = false;
				localPart = '';
				displayName = '';
				isService = false;
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

	async function makeAlias(id: string) {
		try {
			const res = await generateAlias({ mailboxId: id });
			toast.success(`Alias created: ${res.address}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create an alias.');
		}
	}
</script>

{#snippet addressCell(mb: Mailbox)}
	<span class="flex items-center gap-2">
		<span class="font-mono">{mb.address}</span>
		{#if mb.isService}
			<span class="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
				<BotIcon class="size-3" /> service
			</span>
		{/if}
	</span>
{/snippet}

{#snippet accessCell(mb: Mailbox)}
	{@const n = accessCountByMailbox.get(mb.id)?.size ?? 0}
	<span class="text-muted-foreground">{n} {n === 1 ? 'member' : 'members'}</span>
{/snippet}

{#snippet statusCell(mb: Mailbox)}
	<Badge variant={mb.isActive ? 'default' : 'outline'}>{mb.isActive ? 'active' : 'inactive'}</Badge>
{/snippet}

{#snippet sharedActionsCell(mb: Mailbox)}
	<div class="flex justify-end">
		<Button variant="outline" size="sm" href="{manageBase}/{mb.id}">Manage</Button>
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
