<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Contact card: opened by tapping the sender name/avatar in the open thread
     header. Drawer on mobile / Dialog on desktop (same split as move-sheet).
     Identity + interaction history + accepted details + domain colleagues +
     signature-derived suggestions — a suggestion is NEVER auto-applied, only a
     one-tap Accept writes it (acceptContactDetail is the sole writer).
   Hallmark · component: contact-card · genre: modern-minimal · theme: project tokens
   states: loading skeleton · loaded · accept busy · empty sections hidden · contrast: pass -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { toast } from 'svelte-sonner';
	import SenderAvatar from './sender-avatar.svelte';
	import { compose } from '$lib/client/compose.svelte.js';
	import { contactCard, acceptContactDetail } from '$lib/rpc/contact-card.remote';
	import { relTime } from '$lib/utils/reltime';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import PhoneIcon from '@lucide/svelte/icons/phone';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import MailIcon from '@lucide/svelte/icons/mail';
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import ReplyIcon from '@lucide/svelte/icons/reply';
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let {
		open = $bindable(false),
		address,
		name,
		mailboxId,
		verified = false
	}: {
		open?: boolean;
		/** Bare lowercase address of the contact. */
		address: string;
		/** Display name (header/nameFor resolution — the card query may know none). */
		name: string;
		mailboxId: string | null;
		/** The thread already showed this sender as DMARC-verified — reuse the chip. */
		verified?: boolean;
	} = $props();

	const isMobile = new IsMobile();
	// Lazy: the query only instantiates once the card opens for a real address.
	const q = $derived(open && address && mailboxId ? contactCard({ mailboxId, address }) : null);
	const card = $derived(q?.current);

	const FIELD_ICONS = { phone: PhoneIcon, url: GlobeIcon, email: MailIcon, handle: AtSignIcon } as const;
	type DetailField = keyof typeof FIELD_ICONS;
	const detailRows = $derived(
		(Object.entries(card?.details ?? {}) as [string, string][]).filter(
			(entry): entry is [DetailField, string] => entry[0] in FIELD_ICONS
		)
	);

	let accepting = $state<string | null>(null);
	async function accept(field: DetailField, value: string) {
		if (!mailboxId || accepting) return;
		accepting = `${field}:${value}`;
		try {
			await acceptContactDetail({ mailboxId, address, field, value });
			await q?.refresh(); // suggestion moves into the accepted rows
			toast.success('Added to contact.');
		} catch {
			toast.error('Could not save the detail.');
		} finally {
			accepting = null;
		}
	}

	function composeTo() {
		if (!mailboxId) return;
		open = false;
		compose.start({ prefill: { kind: 'new', mailboxId, to: address } });
	}
</script>

{#snippet body()}
	<div class="flex flex-col">
		<!-- Identity: big avatar (same SenderAvatar as the thread header — BIMI/
		     uploaded/DiceBear fallback chain comes along for free) + name + address. -->
		<div class="flex items-center gap-3.5 px-4 pb-3">
			<SenderAvatar from={`${name} <${address}>`} class="size-14 text-lg" />
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1.5">
					<span class="truncate text-base font-semibold">{card?.name || name}</span>
					{#if verified}
						<span class="bg-ok/10 text-ok inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
							<ShieldCheckIcon class="size-3" /> Verified
						</span>
					{/if}
				</div>
				<span class="text-muted-foreground block truncate font-mono text-xs">{address}</span>
			</div>
			<Button variant="outline" size="sm" class="h-8 shrink-0 gap-1.5" disabled={!mailboxId} onclick={composeTo}>
				<PenLineIcon class="size-3.5" /> Compose
			</Button>
		</div>

		{#if !card}
			<div class="flex flex-col gap-2 border-t px-4 py-3">
				<Skeleton class="h-4 w-40 rounded" />
				<Skeleton class="h-4 w-28 rounded" />
				<Skeleton class="h-4 w-48 rounded" />
			</div>
		{:else}
			<!-- Interaction history -->
			<div class="text-muted-foreground flex flex-col gap-1.5 border-t px-4 py-3 text-xs">
				{#if card.firstSeenAt}
					<span class="flex items-center gap-2"><ClockIcon class="size-3.5 shrink-0" /> First seen {relTime(card.firstSeenAt)}</span>
				{/if}
				<span class="flex items-center gap-2">
					<MessagesSquareIcon class="size-3.5 shrink-0" />
					{card.messageCount} message{card.messageCount === 1 ? '' : 's'}
				</span>
				<span class="flex items-center gap-2">
					<ReplyIcon class="size-3.5 shrink-0" />
					{card.lastRepliedAt ? `You last replied ${relTime(card.lastRepliedAt)}` : "You've never replied"}
				</span>
			</div>

			<!-- Accepted contact details -->
			{#if detailRows.length}
				<div class="flex flex-col gap-1.5 border-t px-4 py-3">
					{#each detailRows as [field, value] (field)}
						{@const Icon = FIELD_ICONS[field]}
						<span class="flex items-center gap-2 text-sm">
							<Icon class="text-muted-foreground size-3.5 shrink-0" />
							<span class="min-w-0 truncate">{value}</span>
						</span>
					{/each}
				</div>
			{/if}

			<!-- Domain colleagues -->
			{#if card.domainOthers.length}
				<div class="border-t px-4 py-3">
					<p class="text-muted-foreground mb-1.5 flex items-center gap-2 text-xs font-medium">
						<Building2Icon class="size-3.5 shrink-0" /> Also at {card.domain}
					</p>
					<div class="flex flex-col gap-1">
						{#each card.domainOthers as other (other.address)}
							<span class="flex min-w-0 items-baseline gap-1.5 text-xs">
								{#if other.name}
									<span class="truncate">{other.name}</span>
									<span class="text-muted-foreground min-w-0 truncate font-mono text-[11px]">{other.address}</span>
								{:else}
									<span class="text-muted-foreground min-w-0 truncate font-mono text-[11px]">{other.address}</span>
								{/if}
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Signature-derived suggestions — explicit Accept only, never auto-applied. -->
			{#if card.suggestions.length}
				<div class="border-t px-4 py-3">
					<p class="text-muted-foreground mb-1.5 flex items-center gap-2 text-xs font-medium">
						<SparklesIcon class="size-3.5 shrink-0" /> Suggested from their signature
					</p>
					<div class="flex flex-col gap-1">
						{#each card.suggestions as suggestion (`${suggestion.field}:${suggestion.value}`)}
							{@const Icon = FIELD_ICONS[suggestion.field]}
							{@const busy = accepting === `${suggestion.field}:${suggestion.value}`}
							<div class="flex items-center gap-2">
								<Icon class="text-muted-foreground size-3.5 shrink-0" />
								<span class="min-w-0 flex-1 truncate text-sm">{suggestion.value}</span>
								<Button
									variant="ghost"
									size="sm"
									class="text-brand h-7 shrink-0 gap-1 px-2 text-xs"
									disabled={!!accepting}
									onclick={() => accept(suggestion.field, suggestion.value)}
								>
									<PlusIcon class="size-3" /> {busy ? 'Adding…' : 'Accept'}
								</Button>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open>
		<Drawer.Content class="p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
			<Drawer.Header class="pb-2">
				<Drawer.Title class="text-sm">Contact</Drawer.Title>
			</Drawer.Header>
			<div class="min-h-0 flex-1 overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Dialog.Root bind:open>
		<Dialog.Content class="max-w-sm gap-0 p-0">
			<Dialog.Header class="border-b px-4 pt-4 pb-2.5">
				<Dialog.Title class="text-sm">Contact</Dialog.Title>
			</Dialog.Header>
			<div class="max-h-[70vh] overflow-y-auto pt-3">{@render body()}</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}
