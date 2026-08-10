<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: per-mailbox outbound webhook endpoints. A user with access
	// to the scoped mailbox manages its own webhooks (mirrors sender-lists-card).
	// Create opens a dialog (desktop) / drawer (mobile); the signing secret is
	// shown once on creation. Per endpoint: enable toggle, edit events, delete,
	// and an on-demand recent-deliveries list.
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { errorMessage } from '$lib/utils/error-message';
	import {
		mailboxWebhooks,
		createWebhook,
		updateWebhook,
		deleteWebhook,
		webhookDeliveries
	} from '$lib/rpc/webhooks.remote';
	import { WEBHOOK_EVENTS } from '@doota/mail-core/webhooks';

	// Page-level mailbox scope (see sender-lists-card): only the picked mailbox's
	// endpoints render.
	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const isMobile = new IsMobile();
	const endpointsQ = $derived(mailboxId ? mailboxWebhooks({ mailboxId }) : undefined);

	const fmtDate = (ms: number) =>
		new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	const fmtTime = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});

	const STATUS: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
		delivered: 'default',
		failed: 'destructive',
		queued: 'secondary',
		delivering: 'outline'
	};

	// ---- Create dialog/drawer ----
	let addOpen = $state(false);
	let url = $state('');
	let selectedEvents = $state<string[]>([...WEBHOOK_EVENTS]);
	let creating = $state(false);
	// Set once the endpoint is created — flips the form into the copy-secret view.
	let newSecret = $state<string | null>(null);
	// The secret is shown once. Until the user has actually copied it, the
	// dialog/drawer refuses to dismiss (Esc/backdrop/swipe) and Done stays locked,
	// so one stray tap can't discard an unrecoverable credential.
	let secretCopied = $state(false);
	const guardingSecret = $derived(newSecret !== null && !secretCopied);

	function toggleEvent(event: string, on: boolean) {
		selectedEvents = on
			? [...selectedEvents, event]
			: selectedEvents.filter((current) => current !== event);
	}

	function resetAdd() {
		url = '';
		selectedEvents = [...WEBHOOK_EVENTS];
		newSecret = null;
		secretCopied = false;
	}

	async function create() {
		if (!mailboxId) return;
		creating = true;
		try {
			const res = await createWebhook({ mailboxId, url, events: selectedEvents });
			newSecret = res.secret;
			await endpointsQ?.refresh();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not create the endpoint.'));
		} finally {
			creating = false;
		}
	}

	// Clipboard writes can reject (iOS permission, focus loss) — a silent failure
	// here means the user closes believing they copied an unrecoverable secret.
	let secretInput = $state<HTMLInputElement | null>(null);
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			secretCopied = true;
			toast.success('Secret copied.');
		} catch {
			// Fallback: select the text so a manual ⌘C still works.
			secretInput?.focus();
			secretInput?.select();
			toast.error("Couldn't copy automatically — the secret is selected, copy it manually.");
		}
	}

	// ---- Per-endpoint mutations ----
	let busy = $state<Record<string, boolean>>({});
	function setBusy(id: string, on: boolean) {
		busy = { ...busy, [id]: on };
	}

	async function toggleEnabled(id: string, isEnabled: boolean) {
		setBusy(id, true);
		try {
			await updateWebhook({ id, isEnabled });
			await endpointsQ?.refresh();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not update the endpoint.'));
		} finally {
			setBusy(id, false);
		}
	}

	async function remove(id: string) {
		setBusy(id, true);
		try {
			await deleteWebhook(id);
			toast.success('Endpoint deleted.');
			await endpointsQ?.refresh();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not delete the endpoint.'));
		} finally {
			setBusy(id, false);
		}
	}

	// ---- Edit-events dialog/drawer ----
	let editOpen = $state(false);
	let editId = $state('');
	let editEvents = $state<string[]>([]);
	let savingEvents = $state(false);

	function openEdit(id: string, events: string[]) {
		editId = id;
		editEvents = [...events];
		editOpen = true;
	}
	function toggleEditEvent(event: string, on: boolean) {
		editEvents = on ? [...editEvents, event] : editEvents.filter((current) => current !== event);
	}
	async function saveEvents() {
		savingEvents = true;
		try {
			await updateWebhook({ id: editId, events: editEvents });
			editOpen = false;
			await endpointsQ?.refresh();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not save events.'));
		} finally {
			savingEvents = false;
		}
	}

	// ---- On-demand recent deliveries ----
	let openDeliveries = $state<Record<string, boolean>>({});
	function toggleDeliveries(id: string, on: boolean) {
		openDeliveries = { ...openDeliveries, [id]: on };
	}
</script>

{#snippet eventChecklist(selected: string[], onToggle: (event: string, on: boolean) => void)}
	<div class="flex flex-col gap-2 pt-1">
		{#each WEBHOOK_EVENTS as event (event)}
			<label class="flex items-center gap-2 text-sm">
				<Checkbox
					checked={selected.includes(event)}
					onCheckedChange={(on) => onToggle(event, on === true)}
				/>
				<span class="font-mono text-xs">{event}</span>
			</label>
		{/each}
	</div>
{/snippet}

{#snippet addBody()}
	{#if newSecret}
		<div class="flex flex-col gap-3">
			<p class="text-muted-foreground text-sm">
				This is the only time the secret is shown. Store it somewhere safe — you'll use it to verify
				the <span class="font-mono">Doota-Signature</span> header. A test event has been sent to your
				endpoint.
			</p>
			<div class="flex items-center gap-2">
				<Input
					readonly
					value={newSecret}
					class="font-mono text-xs"
					bind:ref={secretInput}
					oncopy={() => (secretCopied = true)}
				/>
				<Button size="icon" variant="outline" onclick={() => copy(newSecret!)} aria-label="Copy secret">
					<CopyIcon class="size-4" />
				</Button>
			</div>
			<div class="flex items-center justify-end gap-3">
				{#if !secretCopied}
					<span class="text-muted-foreground text-xs">Copy the secret first — it won't be shown again.</span>
				{/if}
				<Button disabled={!secretCopied} onclick={() => (addOpen = false)}>Done</Button>
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			<Field.Field>
				<Field.Label>Endpoint URL</Field.Label>
				<Input bind:value={url} placeholder="https://hooks.example.com/doota" autocomplete="off" />
			</Field.Field>
			<Field.Field>
				<Field.Label>Events</Field.Label>
				{@render eventChecklist(selectedEvents, toggleEvent)}
			</Field.Field>
			<div class="flex justify-end gap-2 pt-1">
				<Button type="button" variant="ghost" onclick={() => (addOpen = false)} disabled={creating}>
					Cancel
				</Button>
				<Button type="button" onclick={create} disabled={creating || !url || selectedEvents.length === 0}>
					{#if creating}<Spinner class="mr-1" />{/if}
					Create
				</Button>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet editBody()}
	<div class="flex flex-col gap-4">
		{@render eventChecklist(editEvents, toggleEditEvent)}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" onclick={() => (editOpen = false)} disabled={savingEvents}>
				Cancel
			</Button>
			<Button type="button" onclick={saveEvents} disabled={savingEvents || editEvents.length === 0}>
				{#if savingEvents}<Spinner class="mr-1" />{/if}
				Save
			</Button>
		</div>
	</div>
{/snippet}

<SettingsCollapsibleCard contentClass="flex flex-col gap-4">
	{#snippet title()}
		<WebhookIcon class="size-4" /> Webhooks
	{/snippet}
	{#snippet summary()}
		{#if endpointsQ?.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else}
			{@const count = endpointsQ.current.length}
			{count} endpoint{count === 1 ? '' : 's'}
		{/if}
	{/snippet}

	<Card.CardDescription>
		Doota POSTs signed event payloads (sent, delivered, bounced, complained, failed, and
		inbound-mail events) for this mailbox to your systems. Payloads carry references only — never
		message content.
	</Card.CardDescription>

	<div>
		<Button
			size="sm"
			class="gap-1.5"
			disabled={!mailboxId}
			onclick={() => {
				resetAdd();
				addOpen = true;
			}}
		>
			<PlusIcon class="size-4" /> Add endpoint
		</Button>
	</div>

	{#if endpointsQ?.current}
		{@const endpoints = endpointsQ.current}
		{#if endpoints.length}
			<div class="flex flex-col gap-3">
				{#each endpoints as endpoint (endpoint.id)}
					{@const deliveriesQ = openDeliveries[endpoint.id]
						? webhookDeliveries({ endpointId: endpoint.id })
						: null}
					<div class="flex flex-col gap-3 rounded-md border p-3">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="flex min-w-0 flex-col gap-1">
								<span class="min-w-0 break-all font-mono text-sm">{endpoint.url}</span>
								<span class="text-muted-foreground font-mono text-xs">
									{endpoint.secretPrefix}… · created {fmtDate(endpoint.createdAt)}
								</span>
							</div>
							<!-- label wraps the switch so the state text is a click target too -->
							<label class="flex cursor-pointer items-center gap-2">
								<span class="text-muted-foreground text-xs">
									{endpoint.isEnabled ? 'Enabled' : 'Disabled'}
								</span>
								<Switch
									checked={endpoint.isEnabled}
									disabled={busy[endpoint.id]}
									onCheckedChange={(on) => toggleEnabled(endpoint.id, on)}
									aria-label="Toggle endpoint"
								/>
							</label>
						</div>

						{#if endpoint.disabledAt && !endpoint.isEnabled && endpoint.failureCount > 0}
							<div
								class="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border p-2 text-xs"
							>
								<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
								<span>
									Auto-disabled after {endpoint.failureCount} consecutive failures. Re-enable to resume
									delivery.
								</span>
							</div>
						{/if}

						<div class="flex flex-wrap items-center gap-1.5">
							{#if endpoint.events.length}
								{#each endpoint.events as event (event)}
									<Badge variant="secondary" class="text-[11px]">{event}</Badge>
								{/each}
							{:else}
								<Badge variant="outline" class="text-[11px]">all events</Badge>
							{/if}
						</div>

						<div
							class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
						>
							<span>{endpoint.delivered} delivered</span>
							<span>{endpoint.failed} failed</span>
							{#if endpoint.failureCount > 0 && endpoint.isEnabled}
								<span class="text-warning">{endpoint.failureCount} recent failures</span>
							{/if}
						</div>

						<div class="flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={busy[endpoint.id]}
								onclick={() => openEdit(endpoint.id, endpoint.events)}
							>
								Edit events
							</Button>

							<AlertDialog.Root>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											size="sm"
											variant="outline"
											class="text-destructive hover:text-destructive"
											disabled={busy[endpoint.id]}
										>
											Delete
										</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>Delete this endpoint?</AlertDialog.Title>
										<AlertDialog.Description>
											Doota will stop delivering events to
											<span class="font-mono break-all">{endpoint.url}</span>. Its delivery history
											is dropped. This can't be undone.
										</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
										<AlertDialog.Action
											onclick={(event) => {
												event.preventDefault();
												remove(endpoint.id);
											}}
											class="bg-destructive text-white hover:bg-destructive/90"
										>
											Delete
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						</div>

						<Collapsible.Root
							open={openDeliveries[endpoint.id] ?? false}
							onOpenChange={(on) => toggleDeliveries(endpoint.id, on)}
						>
							<Collapsible.Trigger
								class="text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 flex min-h-8 items-center gap-1 text-xs"
							>
								<ChevronDownIcon
									class="size-3.5 transition-transform {openDeliveries[endpoint.id]
										? 'rotate-180'
										: ''}"
								/>
								Recent deliveries
							</Collapsible.Trigger>
							<Collapsible.Content class="pt-2">
								{#if deliveriesQ?.current}
									{@const rows = deliveriesQ.current}
									{#if rows.length}
										<ul class="flex flex-col divide-y text-xs">
											{#each rows as row (row.id)}
												<li class="flex items-center justify-between gap-2 py-1.5">
													<div class="flex min-w-0 items-center gap-2">
														<Badge variant={STATUS[row.status] ?? 'outline'} class="text-[11px]">
															{row.status}
														</Badge>
														<span class="text-muted-foreground truncate font-mono">
															{row.eventType}
														</span>
													</div>
													<div class="text-muted-foreground flex shrink-0 items-center gap-2">
														{#if row.responseCode}<span>HTTP {row.responseCode}</span>{/if}
														<span>· {row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span>
														<span>· {fmtTime(row.createdAt)}</span>
													</div>
												</li>
												{#if row.lastError}
													<li class="text-destructive pb-1.5 font-mono text-[11px]">
														{row.lastError}
													</li>
												{/if}
											{/each}
										</ul>
									{:else}
										<p class="text-muted-foreground text-xs">No deliveries yet.</p>
									{/if}
								{:else}
									<div class="text-muted-foreground flex items-center gap-2 text-xs">
										<Spinner class="size-3.5" /> Loading…
									</div>
								{/if}
							</Collapsible.Content>
						</Collapsible.Root>
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-muted-foreground text-sm">
				No webhook endpoints yet. Add one to receive delivery and inbound events for this mailbox.
			</p>
		{/if}
	{:else}
		<div class="flex flex-col gap-2">
			<Skeleton class="h-24 w-full rounded-md" />
		</div>
	{/if}
</SettingsCollapsibleCard>

<!-- Create / copy-secret: dialog (desktop) / drawer (mobile) -->
{#if isMobile.current}
	<Drawer.Root
		bind:open={addOpen}
		dismissible={!guardingSecret}
		onOpenChange={(open) => !open && resetAdd()}
	>
		<Drawer.Content class="pb-[env(safe-area-inset-bottom)]">
			<Drawer.Header class="text-left">
				<Drawer.Title class="font-heading">
					{newSecret ? 'Copy your signing secret' : 'Add endpoint'}
				</Drawer.Title>
			</Drawer.Header>
			<div class="px-4 pb-4">{@render addBody()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Dialog.Root bind:open={addOpen} onOpenChange={(open) => !open && resetAdd()}>
		<Dialog.Content
			class="sm:max-w-md"
			showCloseButton={!guardingSecret}
			interactOutsideBehavior={guardingSecret ? 'ignore' : 'close'}
			escapeKeydownBehavior={guardingSecret ? 'ignore' : 'close'}
		>
			<Dialog.Header>
				<Dialog.Title class="font-heading">
					{newSecret ? 'Copy your signing secret' : 'Add endpoint'}
				</Dialog.Title>
				<Dialog.Description>
					{#if newSecret}
						The only time the secret is shown.
					{:else}
						An https URL Doota POSTs signed event payloads to. A test event is sent on creation.
					{/if}
				</Dialog.Description>
			</Dialog.Header>
			{@render addBody()}
		</Dialog.Content>
	</Dialog.Root>
{/if}

<!-- Edit events: dialog (desktop) / drawer (mobile) -->
{#if isMobile.current}
	<Drawer.Root bind:open={editOpen}>
		<Drawer.Content class="pb-[env(safe-area-inset-bottom)]">
			<Drawer.Header class="text-left">
				<Drawer.Title class="font-heading">Subscribed events</Drawer.Title>
			</Drawer.Header>
			<div class="px-4 pb-4">{@render editBody()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Dialog.Root bind:open={editOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title class="font-heading">Subscribed events</Dialog.Title>
				<Dialog.Description>Choose which events this endpoint receives.</Dialog.Description>
			</Dialog.Header>
			{@render editBody()}
		</Dialog.Content>
	</Dialog.Root>
{/if}
