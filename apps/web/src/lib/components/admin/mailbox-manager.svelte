<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
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
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import {
		renameMailbox,
		deactivateMailbox,
		grantMailboxAccess,
		revokeMailboxAccess,
		listServiceKeys,
		createServiceKey,
		revokeServiceKey,
		listSendLog
	} from '$lib/rpc/mailbox.remote';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BotIcon from '@lucide/svelte/icons/bot';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { errorMessage } from '$lib/utils/error-message';

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
		grants: { userId: string; canManage: boolean; canSend: boolean; assignedOnly: boolean }[];
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
			toast.error(errorMessage(err, 'Could not rename the mailbox.'));
		} finally {
			savingName = false;
		}
	}

	let confirmDeactivate = $state(false);

	async function toggleActive() {
		togglingActive = true;
		try {
			await deactivateMailbox({ mailboxId: mb.id, active: !mb.isActive });
			toast.success(mb.isActive ? 'Mailbox deactivated.' : 'Mailbox activated.');
			await invalidateAll();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not update the mailbox.'));
		} finally {
			togglingActive = false;
		}
	}

	// --- Access -----------------------------------------------------------------
	let busyUser = $state<string | null>(null);

	const grantsMap = $derived.by(() => {
		const m = new Map<string, { canManage: boolean; canSend: boolean; assignedOnly: boolean }>();
		for (const grant of grants)
			m.set(grant.userId, { canManage: grant.canManage, canSend: grant.canSend, assignedOnly: grant.assignedOnly });
		return m;
	});

	const accessColumns: ColumnDef<Member, unknown>[] = [
		{ accessorKey: 'name', header: 'Member', cell: ({ row }) => renderSnippet(memberCell, row.original) },
		{ id: 'access', header: 'Access', enableSorting: false, cell: ({ row }) => renderSnippet(accessCell, row.original) },
		{ id: 'scope', header: 'Sees all mail', enableSorting: false, cell: ({ row }) => renderSnippet(scopeCell, row.original) },
		{ id: 'send', header: 'Send', enableSorting: false, cell: ({ row }) => renderSnippet(sendCell, row.original) },
		{ id: 'manager', header: 'Manager', enableSorting: false, cell: ({ row }) => renderSnippet(managerCell, row.original) }
	];

	async function run(userId: string, fn: () => Promise<unknown>) {
		busyUser = userId;
		const req = fn();
		toast.promise(req, {
			loading: 'Updating access…',
			success: 'Access updated.',
			error: (err) => (errorMessage(err, 'Could not update access.'))
		});
		try {
			await req;
			await invalidateAll();
		} catch {
			// Error surfaced by toast.promise.
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
	const setSeesAll = (userId: string, seesAll: boolean) =>
		run(userId, () => grantMailboxAccess({ mailboxId: mb.id, userId, assignedOnly: !seesAll }));

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
	// --- Send log (service mailboxes only) --------------------------------------
	const logQ = $derived(mb.isService ? listSendLog(mb.id) : null);
	const keyNameById = $derived(
		new Map((keysQ?.current ?? []).map((apiKey) => [apiKey.id, apiKey.name || `${apiKey.prefix}…`]))
	);
	let keyDialogOpen = $state(false);
	let keyName = $state('');
	let creatingKey = $state(false);
	let newSecret = $state<string | null>(null);

	async function createKey() {
		creatingKey = true;
		const req = createServiceKey({ mailboxId: mb.id, name: keyName.trim() });
		toast.promise(req, {
			loading: 'Creating key…',
			success: 'Service key created.',
			error: (err) => (errorMessage(err, 'Could not create the key.'))
		});
		try {
			const res = await req;
			newSecret = res.key;
			keyName = '';
			await keysQ?.refresh();
		} catch {
			// Error surfaced by toast.promise.
		} finally {
			creatingKey = false;
		}
	}
	let confirmRevokeKey = $state<{ id: string; name: string } | null>(null);

	async function revokeKey(keyId: string) {
		const req = revokeServiceKey({ keyId });
		toast.promise(req, {
			loading: 'Revoking key…',
			success: 'Key revoked.',
			error: (err) => (errorMessage(err, 'Could not revoke the key.'))
		});
		try {
			await req;
			await keysQ?.refresh();
		} catch (err) {
			void err; // error surfaced by toast.promise
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

{#snippet memberCell(member: Member)}
	<div class="flex min-w-0 flex-col">
		<span class="truncate text-sm font-medium">{member.name}</span>
		<span class="text-muted-foreground truncate font-mono text-xs">{member.email}</span>
	</div>
{/snippet}

{#snippet accessCell(member: Member)}
	<Switch
		checked={grantsMap.has(member.id)}
		disabled={busyUser === member.id}
		onCheckedChange={(checked) => setAccess(member.id, checked)}
		aria-label="Access"
	/>
{/snippet}

{#snippet scopeCell(member: Member)}
	{@const grant = grantsMap.get(member.id)}
	{#if grant}
		<Switch
			checked={grant.canManage || !grant.assignedOnly}
			disabled={busyUser === member.id || grant.canManage}
			onCheckedChange={(checked) => setSeesAll(member.id, checked)}
			aria-label="Sees all mail"
			title={grant.canManage
				? 'Managers always see the whole mailbox.'
				: 'Off: this member sees only threads assigned to them.'}
		/>
	{:else}
		<span class="text-muted-foreground text-xs">—</span>
	{/if}
{/snippet}

{#snippet sendCell(member: Member)}
	{@const grant = grantsMap.get(member.id)}
	{#if grant}
		<Switch
			checked={grant.canSend}
			disabled={busyUser === member.id}
			onCheckedChange={(checked) => setSend(member.id, checked)}
			aria-label="Can send"
		/>
	{:else}
		<span class="text-muted-foreground text-xs">—</span>
	{/if}
{/snippet}

{#snippet managerCell(member: Member)}
	{@const grant = grantsMap.get(member.id)}
	{#if grant}
		<Switch
			checked={grant.canManage}
			disabled={busyUser === member.id}
			onCheckedChange={(checked) => setManage(member.id, checked)}
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
			{#if mb.isService}<Tabs.Trigger value="logs">Send log</Tabs.Trigger>{/if}
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
						<Switch
							checked={mb.isActive}
							disabled={togglingActive}
							onCheckedChange={(checked) => (checked ? toggleActive() : (confirmDeactivate = true))}
							aria-label="Active"
						/>
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
									{#each keys as apiKey (apiKey.id)}
										<li class="flex items-center gap-3 py-2.5">
											<div class="flex min-w-0 flex-1 flex-col">
												<span class="truncate text-sm font-medium">{apiKey.name || 'Untitled key'}</span>
												<span class="text-muted-foreground truncate font-mono text-xs">
													{apiKey.prefix}… · created {fmtDate(apiKey.createdAt)}
													{#if apiKey.lastUsedAt} · used {fmtDate(apiKey.lastUsedAt)}{/if}
												</span>
											</div>
											{#if apiKey.revokedAt}
												<Badge variant="outline">Revoked</Badge>
											{:else}
												<Button size="sm" variant="outline" class="text-destructive hover:text-destructive" onclick={() => (confirmRevokeKey = { id: apiKey.id, name: apiKey.name || 'Untitled key' })}>
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
						<p class="text-muted-foreground mt-4 border-t pt-3 text-xs">
							Send templated mail via the API? <a href="/templates" class="text-foreground underline underline-offset-2">Manage templates →</a>
						</p>
					</Card.CardContent>
				</Card.Card>
			</Tabs.Content>

			<Tabs.Content value="logs" class="mt-4">
				<Card.Card>
					<Card.CardHeader>
						<Card.CardTitle class="font-heading">Send log</Card.CardTitle>
						<Card.CardDescription>
							Every message sent via the API — when, to whom, and which key. Merge
							data is encrypted and auto-expires; only metadata is kept long-term.
						</Card.CardDescription>
					</Card.CardHeader>
					<Card.CardContent>
						{#if logQ?.current}
							{@const events = logQ.current}
							{#if events.length}
								<ul class="flex flex-col divide-y">
									{#each events as logEntry (logEntry.id)}
										<li class="flex items-center gap-3 py-2.5">
											<div class="flex min-w-0 flex-1 flex-col">
												<span class="truncate text-sm font-medium">{logEntry.subject || '(no subject)'}</span>
												<span class="text-muted-foreground truncate font-mono text-xs">
													{logEntry.toAddresses.join(', ') || '—'}
												</span>
												<span class="text-muted-foreground truncate text-xs">
													{fmt(logEntry.createdAt)}
													{#if logEntry.apiKeyId} · {keyNameById.get(logEntry.apiKeyId) ?? 'key'}{/if}
													{#if logEntry.templateId} · template{/if}
												</span>
											</div>
											<Badge variant={logEntry.status === 'failed' || logEntry.status === 'bounced' ? 'destructive' : 'secondary'}>
												{logEntry.status}
											</Badge>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="text-muted-foreground text-sm">No sends yet. Messages sent via the API appear here.</p>
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
						{#each FOLDERS as folder (folder)}
							<div class="flex flex-col gap-0.5">
								<dt class="text-muted-foreground text-xs capitalize">{folder}</dt>
								<dd class="font-heading text-xl font-semibold tabular-nums">{activity.counts[folder] ?? 0}</dd>
							</div>
						{/each}
					</dl>

					<div class="flex flex-col">
						<p class="mb-1 text-sm font-medium">Recent messages</p>
						{#if activity.recent.length}
							<ul class="divide-y rounded-md border">
								{#each activity.recent as message (message.id)}
									<li class="flex items-center justify-between gap-3 px-3 py-2">
										<div class="flex min-w-0 flex-col">
											<span class="truncate text-sm">{message.subject || '(no subject)'}</span>
											<span class="text-muted-foreground truncate font-mono text-xs">{message.from ?? '—'}</span>
										</div>
										<span class="text-muted-foreground shrink-0 text-xs">{fmt(message.at)}</span>
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

<Dialog.Root open={keyDialogOpen} onOpenChange={(open) => !open && closeKeyDialog()}>
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
					<Field.Label>Name</Field.Label>
					<Input bind:value={keyName} placeholder="CI deploy bot" autocomplete="off" />
					<p class="text-muted-foreground text-xs">Name it after where it's used, so it's identifiable later.</p>
				</Field.Field>
				<div class="flex justify-end gap-2 pt-1">
					<Button type="button" variant="ghost" onclick={closeKeyDialog} disabled={creatingKey}>Cancel</Button>
					<Button type="button" onclick={createKey} disabled={creatingKey || !keyName.trim()}>
						{#if creatingKey}<Spinner class="mr-1" />{/if}
						Create key
					</Button>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={!!confirmRevokeKey} onOpenChange={(open) => !open && (confirmRevokeKey = null)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Revoke {confirmRevokeKey?.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				Any app still using this key will immediately stop being able to send. This can't be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={(event) => {
					event.preventDefault();
					const id = confirmRevokeKey?.id;
					confirmRevokeKey = null;
					if (id) revokeKey(id);
				}}
				class="bg-destructive text-white hover:bg-destructive/90"
			>
				Revoke
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root open={confirmDeactivate} onOpenChange={(open) => !open && (confirmDeactivate = false)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Deactivate {mb.address}?</AlertDialog.Title>
			<AlertDialog.Description>
				While inactive this mailbox stops receiving mail and can't be sent from. You can reactivate
				it later.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={togglingActive}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={togglingActive}
				onclick={(event) => {
					event.preventDefault();
					confirmDeactivate = false;
					toggleActive();
				}}
				class="bg-destructive text-white hover:bg-destructive/90"
			>
				{#if togglingActive}<Spinner class="mr-1" />{/if}
				Deactivate
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
