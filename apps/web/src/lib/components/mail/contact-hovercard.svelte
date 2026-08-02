<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Gmail-style sender hover card: identity + quick actions, expandable to recent
     interactions. Data (org-internal? + recent threads) is fetched lazily the
     first time a card opens, scoped to mailboxes the reader can already see.
   Hallmark · component: hover-card · genre: modern-minimal · theme: project tokens
   states: trigger default/hover/focus · actions default/hover/focus/active/disabled
           · recent loading/empty/error · contrast: pass -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { cn } from '$lib/utils/ui.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import * as HoverCard from '$lib/components/ui/hover-card/index.js';
	import SenderAvatar from './sender-avatar.svelte';
	import { compose } from '$lib/client/compose.svelte.js';
	import { contactRecent } from '$lib/rpc/contact.remote';
	import { relTime } from '$lib/utils/reltime';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ArrowDownLeftIcon from '@lucide/svelte/icons/arrow-down-left';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

	let {
		address,
		name,
		mailboxId,
		class: className,
		children
	}: {
		address: string;
		name: string;
		mailboxId: string | null;
		/** Classes for the trigger element — carry the caller's text/layout styling
		 * (e.g. `truncate font-semibold`) so wrapping doesn't break the row. */
		class?: string;
		children: Snippet;
	} = $props();

	const addr = $derived(address.trim());
	let open = $state(false);
	let showRecent = $state(false);
	// Lazy: the query only instantiates once a card has opened. `name <addr>` gives
	// SenderAvatar the same string the message rows use.
	const info = $derived(open && addr ? contactRecent({ address: addr }) : null);
	const recent = $derived(info?.current?.recent ?? []);

	const reduce = () =>
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	// Touch has no hover — on coarse pointers a tap on the sender name toggles the
	// card, so the feature isn't hover-locked (Gmail taps open the same card).
	const coarse = () =>
		typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
	function onTriggerClick() {
		if (coarse()) open = !open;
	}

	function composeTo() {
		if (!mailboxId) return;
		open = false;
		compose.start({ prefill: { kind: 'new', mailboxId, to: addr } });
	}
	async function copyEmail() {
		try {
			await navigator.clipboard.writeText(addr);
			toast.success('Email copied');
		} catch {
			toast.error('Could not copy');
		}
	}
	function searchFrom() {
		open = false;
		goto(`${resolve('/app')}?q=${encodeURIComponent(`from:${addr}`)}`);
	}
	function openThread(thread: { mailboxId: string; threadId: string }) {
		open = false;
		const sp = new URLSearchParams({ mailbox: thread.mailboxId, thread: thread.threadId });
		goto(`${resolve('/app')}?${sp}`);
	}
</script>

<HoverCard.Root bind:open openDelay={450} closeDelay={120}>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<!-- The caller's sender text IS the trigger — a span carrying their
			     classes, not the primitive's default anchor and not an extra wrapper. -->
			<span {...props} onclick={onTriggerClick} class={cn('focus-visible:ring-ring/50 cursor-default rounded-sm outline-none focus-visible:ring-2', className)}>{@render children()}</span>
		{/snippet}
	</HoverCard.Trigger>
	<HoverCard.Content class="w-80 p-0" sideOffset={8}>
		<div class="flex items-start gap-3 p-3.5">
			<SenderAvatar from={`${name} <${addr}>`} class="size-11 text-sm" />
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1.5">
					<span class="truncate text-sm font-semibold">{name}</span>
					{#if info?.current}
						<span
							class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium {info.current.isInternal
								? 'bg-brand/10 text-brand'
								: 'bg-muted text-muted-foreground'}"
						>
							{info.current.isInternal ? 'Team' : 'External'}
						</span>
					{:else}
						<!-- Reserve the chip slot while loading so the name doesn't shift
						     when the badge resolves (widest label = "External"). -->
						<span class="invisible shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium">External</span>
					{/if}
				</div>
				<span class="text-muted-foreground block truncate font-mono text-xs">{addr}</span>
			</div>
		</div>

		<!-- Quick actions -->
		<div class="flex items-center gap-1 border-t px-2 py-1.5">
			<button type="button" disabled={!mailboxId} onclick={composeTo} class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition-colors outline-none focus-visible:ring-2 disabled:opacity-40">
				<PenLineIcon class="size-3.5" /> Compose
			</button>
			<button type="button" onclick={copyEmail} class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition-colors outline-none focus-visible:ring-2">
				<CopyIcon class="size-3.5" /> Copy
			</button>
			<button type="button" onclick={searchFrom} class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs transition-colors outline-none focus-visible:ring-2">
				<SearchIcon class="size-3.5" /> Search
			</button>
		</div>

		<!-- Recent interactions — expands on demand (data already loaded on open). -->
		<div class="border-t">
			<button
				type="button"
				aria-expanded={showRecent}
				onclick={() => (showRecent = !showRecent)}
				class="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center justify-between px-3.5 py-2 text-left text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
			>
				<span>Recent conversations{info?.current ? ` · ${recent.length}` : ''}</span>
				<ChevronDownIcon class="text-muted-foreground size-4 transition-transform duration-150 motion-reduce:transition-none {showRecent ? 'rotate-180' : ''}" />
			</button>
			{#if showRecent}
				<div transition:slide={{ duration: reduce() ? 0 : 150, easing: cubicOut }} class="pb-1.5">
					{#if !info?.current}
						<p class="text-muted-foreground px-3.5 py-2 text-xs">Loading…</p>
					{:else if recent.length === 0}
						<p class="text-muted-foreground px-3.5 py-2 text-xs">No shared conversations yet.</p>
					{:else}
						{#each recent as thread (thread.threadId)}
							<button
								type="button"
								onclick={() => openThread(thread)}
								class="hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset"
							>
								{#if thread.inbound}
									<ArrowDownLeftIcon class="text-brand size-3.5 shrink-0" />
								{:else}
									<ArrowUpRightIcon class="text-muted-foreground size-3.5 shrink-0" />
								{/if}
								<span class="min-w-0 flex-1 truncate text-xs">{thread.subject || '(no subject)'}</span>
								{#if thread.at}<span class="text-faint shrink-0 text-[10px]">{relTime(thread.at)}</span>{/if}
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
	</HoverCard.Content>
</HoverCard.Root>
