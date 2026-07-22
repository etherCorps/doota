<script lang="ts">
	import type { ColumnDef } from '@tanstack/table-core';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import {
		renameMailbox,
		deactivateMailbox,
		grantMailboxAccess,
		revokeMailboxAccess,
		listServiceKeys,
		createServiceKey,
		revokeServiceKey
	} from '$lib/rpc/mailbox.remote';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BotIcon from '@lucide/svelte/icons/bot';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CopyIcon from '@lucide/svelte/icons/copy';

	type Member = { id: string; name: string; email: string };
	let {
		mailbox,
		members,
		grants,
		activity,
		backHref
	}: {
		mailbox: {
			id: string;
			address: string;
			displayName: string | null;
			isActive: boolean;
			isPersonal: boolean;
			isService: boolean;
			createdAt: number | null;
		};
		members: Member[];
		grants: { userId: string; canManage: boolean; canSend: boolean }[];
		activity: {
			counts: Record<string, number>;
			total: number;
			recent: { id: string; from: string | null; subject: string | null; at: number | null }[];
		};
		backHref: string;
	} = $props();

	const mb = $derived(mailbox);

	// --- Settings ---------------------------------------------------------------
	let name = $state(untrack(() => mailbox.displayName ?? ''));
	let savingName = $state(false);
	let togglingActive = $state(false);
	const nameDirty = $derived(name.trim() !== (mb.displayName ?? ''));

	async function saveName() {
		savingName = true;
		try {
			await renameMailbox({ mailboxId: mb.id, displayName: name.trim() });
			toast.success('Display name updated.');
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not rename the mailbox.');
		} finally {
			savingName = false;
		}
	}

	async function toggleActive() {
		togglingActive = true;
		try {
			await deactivateMailbox({ mailboxId: mb.id, active: !mb.isActive });
			toast.success(mb.isActive ? 'Mailbox deactivated.' : 'Mailbox activated.');
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update the mailbox.');
		} finally {
			togglingActive = false;
		}
	}

	// --- Access -----------------------------------------------------------------
	let busyUser = $state<string | null>(null);

	const grantsMap = $derived.by(() => {
		const m = new Map<string, { canManage: boolean; canSend: boolean }>();
		for (const g of grants) m.set(g.userId, { canManage: g.canManage, canSend: g.canSend });
		return m;
	});

	const accessColumns: ColumnDef<Member, unknown>[] = [
		{ accessorKey: 'name', header: 'Member', cell: ({ row }) => renderSnippet(memberCell, row.original) },
		{ id: 'access', header: 'Access', enableSorting: false, cell: ({ row }) => renderSnippet(accessCell, row.original) },
		{ id: 'send', header: 'Send', enableSorting: false, cell: ({ row }) => renderSnippet(sendCell, row.original) },
		{ id: 'manager', header: 'Manager', enableSorting: false, cell: ({ row }) => renderSnippet(managerCell, row.original) }
	];

	async function run(userId: string, fn: () => Promise<unknown>) {
		busyUser = userId;
		try {
			await fn();
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update access.');
		} finally {
			busyUser = null;
		}
	}
	const setAccess = (userId: string, granted: boolean) =>
		run(userId, () =>
			granted
				? grantMailboxAccess({ mailboxId: mb.id, userId })
				: revokeMailboxAccess({ mailboxId: mb.id, userId })
		);
	const setSend = (userId: string, canSend: boolean) =>
		run(userId, () => grantMailboxAccess({ mailboxId: mb.id, userId, canSend }));
	const setManage = (userId: string, canManage: boolean) =>
		run(userId, () => grantMailboxAccess({ mailboxId: mb.id, userId, canManage }));

	// --- Activity ---------------------------------------------------------------
	const FOLDERS = ['inbox', 'sent', 'archived', 'spam', 'trash'] as const;
	function fmt(ms: number | null): string {
		if (!ms) return '';
		return new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
	const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : '—');

	// --- Service keys (service mailboxes only) ----------------------------------
	const keysQ = $derived(mb.isService ? listServiceKeys(mb.id) : null);
	let keyDialogOpen = $state(false);
	let keyName = $state('');
	let creatingKey = $state(false);
	let newSecret = $state<string | null>(null);

	async function createKey() {
		creatingKey = true;
		try {
			const res = await createServiceKey({ mailboxId: mb.id, name: keyName || undefined });
			newSecret = res.key;
			keyName = '';
			await keysQ?.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create the key.');
		} finally {
			creatingKey = false;
		}
	}
	async function revokeKey(keyId: string) {
		try {
			await revokeServiceKey({ keyId });
			toast.success('Key revoked.');
			await keysQ?.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not revoke the key.');
		}
	}
	async function copySecret(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to clipboard.');
	}
	function closeKeyDialog() {
		keyDialogOpen = false;
		newSecret = null;
	}
</script>

{#snippet memberCell(u: Member)}
	<div class="flex min-w-0 flex-col">
		<span class="truncate text-sm font-medium">{u.name}</span>
		<span class="text-muted-foreground truncate font-mono text-xs">{u.email}</span>
	</div>
{/snippet}

{#snippet accessCell(u: Member)}
	<Switch
		checked={grantsMap.has(u.id)}
		disabled={busyUser === u.id}
		onCheckedChange={(v) => setAccess(u.id, v)}
		aria-label="Access"
	/>
{/snippet}

{#snippet sendCell(u: Member)}
	{@const grant = grantsMap.get(u.id)}
	{#if grant}
		<Switch
			checked={grant.canSend}
			disabled={busyUser === u.id}
			onCheckedChange={(v) => setSend(u.id, v)}
			aria-label="Can send"
		/>
	{:else}
		<span class="text-muted-foreground text-xs">—</span>
	{/if}
{/snippet}

{#snippet managerCell(u: Member)}
	{@const grant = grantsMap.get(u.id)}
	{#if grant}
		<Switch
			checked={grant.canManage}
			disabled={busyUser === u.id}
			onCheckedChange={(v) => setManage(u.id, v)}
			aria-label="Manager"
		/>
	{:else}
		<span class="text-muted-foreground text-xs">—</span>
	{/if}
{/snippet}

<div class="flex flex-col gap-6">
	<div class="flex flex-col gap-2">
		<a href={backHref} class="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm">
			<ArrowLeftIcon class="size-3.5" /> Mailboxes
		</a>
		<div class="flex flex-wrap items-center gap-3">
			<h1 class="font-heading text-2xl font-semibold tracking-tight">{mb.address}</h1>
			<Badge variant={mb.isActive ? 'default' : 'outline'}>{mb.isActive ? 'active' : 'inactive'}</Badge>
			{#if mb.isService}
				<span class="border-p1/30 bg-p1/10 text-p1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
					<BotIcon class="size-3.5" /> service
				</span>
			{/if}
		</div>
		<p class="text-muted-foreground text-sm">
			{mb.isService ? 'Service mailbox' : 'Shared mailbox'} · {grants.length}
			{grants.length === 1 ? 'member' : 'members'} · created {fmtDate(mb.createdAt)}
		</p>
	</div>

	<Tabs.Root value="settings">
		<Tabs.List class="max-w-full overflow-x-auto">
			<Tabs.Trigger value="settings">Settings</Tabs.Trigger>
			<Tabs.Trigger value="access">Access <Badge variant="secondary" class="ml-1.5 tabular-nums">{grantsMap.size}</Badge></Tabs.Trigger>
			{#if mb.isService}<Tabs.Trigger value="keys">API keys</Tabs.Trigger>{/if}
			<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="settings" class="mt-4">
			<Card.Card>
				<Card.CardHeader>
					<Card.CardTitle class="font-heading">Settings</Card.CardTitle>
					<Card.CardDescription>
						The address is fixed — it's the routing key. The display name is the sender name on mail
						sent from this mailbox.
					</Card.CardDescription>
				</Card.CardHeader>
				<Card.CardContent class="flex flex-col gap-4">
					<Field.Field>
						<Field.Label>Address</Field.Label>
						<Input value={mb.address} readonly class="font-mono" />
					</Field.Field>
					<Field.Field>
						<Field.Label>Display name</Field.Label>
						<div class="flex items-center gap-2">
							<Input bind:value={name} placeholder="Support" autocomplete="off" />
							<Button onclick={saveName} disabled={!nameDirty || savingName}>
								{#if savingName}<Spinner class="mr-1" />{/if}
								Save
							</Button>
						</div>
					</Field.Field>
					<div class="flex items-center justify-between gap-4 border-t pt-4">
						<div class="space-y-0.5">
							<p class="text-sm font-medium">Active</p>
							<p class="text-muted-foreground text-xs">
								Inactive mailboxes stop receiving and can't be sent from.
							</p>
						</div>
						<Switch checked={mb.isActive} disabled={togglingActive} onCheckedChange={toggleActive} aria-label="Active" />
					</div>
				</Card.CardContent>
			</Card.Card>
		</Tabs.Content>

		<Tabs.Content value="access" class="mt-4">
			<Card.Card>
				<Card.CardHeader>
					<Card.CardTitle class="font-heading">Access</Card.CardTitle>
					<Card.CardDescription>
						Who can read this mailbox. <span class="font-medium">Send</span> lets them send as the
						address; <span class="font-medium">Manager</span> lets them administer it.
					</Card.CardDescription>
				</Card.CardHeader>
				<Card.CardContent>
					<DataTable
						columns={accessColumns}
						data={members}
						filterColumn="name"
						filterPlaceholder="Search members…"
						empty="No members in this organization yet."
					>
						{#snippet actions()}
							<span class="text-muted-foreground text-xs">{grantsMap.size} with access</span>
						{/snippet}
					</DataTable>
				</Card.CardContent>
			</Card.Card>
		</Tabs.Content>

		{#if mb.isService}
			<Tabs.Content value="keys" class="mt-4">
				<Card.Card>
					<Card.CardHeader>
						<Card.CardTitle class="font-heading">API keys</Card.CardTitle>
						<Card.CardDescription>
							Send-only bearer keys for <span class="font-mono">POST /api/send</span>. Each authorizes
							sending as <span class="font-mono">{mb.address}</span> — no human owner, so it survives
							staff changes. The secret is shown once.
						</Card.CardDescription>
						<Card.CardAction>
							<Button size="sm" variant="outline" onclick={() => (keyDialogOpen = true)}>New key</Button>
						</Card.CardAction>
					</Card.CardHeader>
					<Card.CardContent>
						{#if keysQ?.current}
							{@const keys = keysQ.current}
							{#if keys.length}
								<ul class="flex flex-col divide-y">
									{#each keys as k (k.id)}
										<li class="flex items-center gap-3 py-2.5">
											<div class="flex min-w-0 flex-1 flex-col">
												<span class="truncate text-sm font-medium">{k.name || 'Untitled key'}</span>
												<span class="text-muted-foreground truncate font-mono text-xs">
													{k.prefix}… · created {fmtDate(k.createdAt)}
													{#if k.lastUsedAt} · used {fmtDate(k.lastUsedAt)}{/if}
												</span>
											</div>
											{#if k.revokedAt}
												<Badge variant="outline">Revoked</Badge>
											{:else}
												<Button size="sm" variant="outline" class="text-destructive hover:text-destructive" onclick={() => revokeKey(k.id)}>
													Revoke
												</Button>
											{/if}
										</li>
									{/each}
								</ul>
							{:else}
								<p class="text-muted-foreground text-sm">No API keys yet. Create one to send programmatically.</p>
							{/if}
						{:else}
							<div class="flex flex-col gap-3">
								<Skeleton class="h-10 w-full rounded-md" />
								<Skeleton class="h-10 w-full rounded-md" />
							</div>
						{/if}
					</Card.CardContent>
				</Card.Card>
			</Tabs.Content>
		{/if}

		<Tabs.Content value="activity" class="mt-4">
			<Card.Card>
				<Card.CardHeader>
					<Card.CardTitle class="font-heading">Activity</Card.CardTitle>
					<Card.CardDescription>Threads in this mailbox and the latest messages received.</Card.CardDescription>
				</Card.CardHeader>
				<Card.CardContent class="flex flex-col gap-5">
					<dl class="grid grid-cols-3 gap-3 sm:grid-cols-6">
						<div class="flex flex-col gap-0.5">
							<dt class="text-muted-foreground text-xs">Total</dt>
							<dd class="font-heading text-xl font-semibold tabular-nums">{activity.total}</dd>
						</div>
						{#each FOLDERS as f (f)}
							<div class="flex flex-col gap-0.5">
								<dt class="text-muted-foreground text-xs capitalize">{f}</dt>
								<dd class="font-heading text-xl font-semibold tabular-nums">{activity.counts[f] ?? 0}</dd>
							</div>
						{/each}
					</dl>

					<div class="flex flex-col">
						<p class="mb-1 text-sm font-medium">Recent messages</p>
						{#if activity.recent.length}
							<ul class="divide-y rounded-md border">
								{#each activity.recent as m (m.id)}
									<li class="flex items-center justify-between gap-3 px-3 py-2">
										<div class="flex min-w-0 flex-col">
											<span class="truncate text-sm">{m.subject || '(no subject)'}</span>
											<span class="text-muted-foreground truncate font-mono text-xs">{m.from ?? '—'}</span>
										</div>
										<span class="text-muted-foreground shrink-0 text-xs">{fmt(m.at)}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="text-muted-foreground text-sm">No messages yet.</p>
						{/if}
					</div>
				</Card.CardContent>
			</Card.Card>
		</Tabs.Content>
	</Tabs.Root>
</div>

<Dialog.Root open={keyDialogOpen} onOpenChange={(o) => !o && closeKeyDialog()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">{newSecret ? 'Copy your key' : 'New API key'}</Dialog.Title>
			<Dialog.Description>
				{#if newSecret}
					This is the only time the secret is shown. Store it somewhere safe.
				{:else}
					A send-only bearer key that sends as <span class="font-mono">{mb.address}</span>.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if newSecret}
			<div class="flex items-center gap-2 py-2">
				<Input readonly value={newSecret} class="font-mono text-xs" />
				<Button size="icon" variant="outline" onclick={() => copySecret(newSecret!)}>
					<CopyIcon class="size-4" />
				</Button>
			</div>
			<div class="flex justify-end">
				<Button onclick={closeKeyDialog}>Done</Button>
			</div>
		{:else}
			<div class="flex flex-col gap-3 py-2">
				<Field.Field>
					<Field.Label>Name (optional)</Field.Label>
					<Input bind:value={keyName} placeholder="CI deploy bot" autocomplete="off" />
				</Field.Field>
				<div class="flex justify-end gap-2 pt-1">
					<Button type="button" variant="ghost" onclick={closeKeyDialog} disabled={creatingKey}>Cancel</Button>
					<Button type="button" onclick={createKey} disabled={creatingKey}>
						{#if creatingKey}<Spinner class="mr-1" />{/if}
						Create key
					</Button>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
