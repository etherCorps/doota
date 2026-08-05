<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: per-mailbox allowed/blocked sender lists. One add row per
	// mailbox (address or @domain, mirroring the rpc regex) with Allow/Block
	// buttons; entries render as two labelled lists with remove buttons.
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import XIcon from '@lucide/svelte/icons/x';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';

	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';

	// Reactive (not one-shot await): self-heals if the experimental remote-query
	// cache resolves late or transiently undefined during hydration.
	const mailboxesQ = myMailboxes();
	import { senderLists, addSenderEntry, removeSenderEntry } from '$lib/rpc/sender-list.remote';

	// Page-level mailbox scope (see signatures-card): only that mailbox's lists
	// render and the address heading drops.
	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const visible = $derived(
		mailboxesQ.current === undefined
			? undefined
			: mailboxId
				? mailboxesQ.current.filter((box) => box.id === mailboxId)
				: mailboxesQ.current
	);
	// Header summary reads the same per-mailbox query the lists use (cached by args).
	const summaryQuery = $derived(mailboxId ? senderLists({ mailboxId }) : undefined);

	// Mirrors the server rule: a full address or "@domain".
	const ADDRESS_RE = /^(@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

	let inputs = $state<Record<string, string>>({});
	let busy = $state<string | null>(null);

	async function add(mailboxId: string, kind: 'allow' | 'block') {
		const address = (inputs[mailboxId] ?? '').trim().toLowerCase();
		if (!ADDRESS_RE.test(address)) {
			toast.error('Enter a full address (person@example.com) or a whole domain (@example.com).');
			return;
		}
		busy = mailboxId;
		try {
			await addSenderEntry({ mailboxId, address, kind });
			inputs[mailboxId] = '';
			await senderLists({ mailboxId }).refresh();
			toast.success(kind === 'allow' ? `${address} is now allowed.` : `${address} is now blocked.`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update the list.');
		} finally {
			busy = null;
		}
	}

	async function remove(mailboxId: string, address: string) {
		busy = `${mailboxId}:${address}`;
		try {
			await removeSenderEntry({ mailboxId, address });
			await senderLists({ mailboxId }).refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not remove the entry.');
		} finally {
			busy = null;
		}
	}
</script>

{#snippet entryList(
	mailboxId: string,
	title: string,
	entries: { id: string; address: string }[],
	emptyCopy: string
)}
	<div class="flex min-w-0 flex-col gap-1.5">
		<span class="text-muted-foreground text-xs font-medium">{title}</span>
		{#if entries.length}
			<ul class="flex flex-col divide-y rounded-md border">
				{#each entries as entry (entry.id)}
					<li class="flex items-center gap-2 px-3 py-1.5">
						<span class="min-w-0 flex-1 truncate font-mono text-xs">{entry.address}</span>
						<Button
							size="icon"
							variant="ghost"
							class="size-7 shrink-0"
							title="Remove"
							aria-label="Remove {entry.address} from {title.toLowerCase()}"
							disabled={busy === `${mailboxId}:${entry.address}`}
							onclick={() => remove(mailboxId, entry.address)}
						>
							<XIcon class="size-3.5" />
						</Button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-muted-foreground text-xs">{emptyCopy}</p>
		{/if}
	</div>
{/snippet}

<SettingsCollapsibleCard contentClass="flex flex-col gap-6">
	{#snippet title()}
		<ShieldIcon class="size-4" /> Allowed &amp; blocked senders
	{/snippet}
	{#snippet summary()}
		{#if summaryQuery?.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else}
			{summaryQuery.current.filter((entry) => entry.kind === 'allow').length} allowed · {summaryQuery.current.filter(
				(entry) => entry.kind === 'block'
			).length} blocked
		{/if}
	{/snippet}
	<Card.CardDescription>
		Allowed senders always skip the Junk folder; blocked senders always land there. Moving a
		message out of Junk adds its sender to the allowed list automatically.
	</Card.CardDescription>
	<div class="flex flex-col gap-6">
		{#if visible === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-8 w-full rounded-md" />
				<Skeleton class="h-8 w-full rounded-md" />
			</div>
		{:else}
			{@const boxes = visible}
			{#if boxes.length === 0}
				<p class="text-muted-foreground text-sm">You don't have any mailboxes yet.</p>
			{:else}
				{#each boxes as box (box.id)}
					{@const listQuery = senderLists({ mailboxId: box.id })}
					<section
						class="flex flex-col gap-3 border-t pt-6 first:border-t-0 first:pt-0"
						aria-label="Sender lists for {box.address}"
					>
						{#if !mailboxId}
							<span class="min-w-0 truncate font-mono text-sm font-medium">{box.address}</span>
						{/if}
						<div class="flex flex-wrap items-center gap-2">
							<Input
								class="min-w-40 flex-1"
								value={inputs[box.id] ?? ''}
								oninput={(event) => (inputs[box.id] = event.currentTarget.value)}
								placeholder="person@example.com or @example.com"
								aria-label="Sender to allow or block for {box.address}"
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={busy === box.id}
								onclick={() => add(box.id, 'allow')}
							>
								Allow
							</Button>
							<Button
								size="sm"
								variant="outline"
								class="text-destructive hover:text-destructive"
								disabled={busy === box.id}
								onclick={() => add(box.id, 'block')}
							>
								Block
							</Button>
						</div>
						<p class="text-muted-foreground text-xs">
							Use a full address for one person, or @example.com for everyone at that domain.
						</p>
						{#if listQuery.current}
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
								{@render entryList(
									box.id,
									'Allowed',
									listQuery.current.filter((entry) => entry.kind === 'allow'),
									'No allowed senders yet.'
								)}
								{@render entryList(
									box.id,
									'Blocked',
									listQuery.current.filter((entry) => entry.kind === 'block'),
									'No blocked senders yet.'
								)}
							</div>
						{:else}
							<Skeleton class="h-8 w-full rounded-md" />
						{/if}
					</section>
				{/each}
			{/if}
		{/if}
	</div>
</SettingsCollapsibleCard>
