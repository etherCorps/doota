<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import type { SendIdentity } from '@doota/mail-core/identities';

	// The identity picker that makes hide-my-email usable end to end. Addresses
	// render in JetBrains Mono (font-mono) per the design system; an unavailable
	// identity (domain not active) is shown disabled WITH its reason, never hidden.
	let {
		identities,
		mailboxId = $bindable(),
		aliasId = $bindable()
	}: {
		identities: SendIdentity[];
		mailboxId: string | undefined;
		aliasId: string | null | undefined;
	} = $props();

	const key = (i: { mailboxId: string; aliasId: string | null }) => `${i.mailboxId}:${i.aliasId ?? ''}`;
	const selected = $derived(
		identities.find((i) => i.mailboxId === mailboxId && (i.aliasId ?? null) === (aliasId ?? null))
	);

	function pick(i: SendIdentity) {
		if (!i.available) return;
		mailboxId = i.mailboxId;
		aliasId = i.aliasId;
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button variant="outline" size="sm" class="h-8 max-w-full gap-1.5" {...props}>
				<AtSignIcon class="text-muted-foreground size-3.5 shrink-0" />
				<span class="max-w-[48vw] truncate font-mono text-xs sm:max-w-none">{selected?.address ?? 'Choose identity'}</span>
				<ChevronsUpDownIcon class="text-muted-foreground size-3.5 shrink-0" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="w-72" align="start" sideOffset={6}>
		<DropdownMenu.Label class="text-muted-foreground text-xs">Send as</DropdownMenu.Label>
		{#each identities as identity (key(identity))}
			<DropdownMenu.Item
				disabled={!identity.available}
				onSelect={() => pick(identity)}
				class="flex-col items-start gap-0.5"
			>
				<div class="flex w-full items-center gap-2">
					<span class="font-mono text-xs">{identity.address}</span>
					{#if identity.kind === 'alias'}
						<span class="text-muted-foreground text-[10px] uppercase tracking-wide">alias</span>
					{/if}
					{#if key(identity) === (selected ? key(selected) : '')}
						<CheckIcon class="ml-auto size-4" />
					{/if}
				</div>
				{#if !identity.available && identity.reason}
					<span class="text-faint text-[11px]">{identity.reason}</span>
				{:else if identity.displayName}
					<span class="text-muted-foreground text-[11px]">{identity.displayName}</span>
				{/if}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
