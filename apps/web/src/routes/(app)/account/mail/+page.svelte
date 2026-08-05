<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import AliasesCard from '$lib/components/account/aliases-card.svelte';
	import ExportCard from '$lib/components/account/export-card.svelte';
	import ReadingCard from '$lib/components/account/reading-card.svelte';
	import RemoteImagesCard from '$lib/components/account/remote-images-card.svelte';
	import SenderListsCard from '$lib/components/account/sender-lists-card.svelte';
	import SignaturesCard from '$lib/components/account/signatures-card.svelte';
	import VacationCard from '$lib/components/account/vacation-card.svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';

	// Page-level mailbox scope (audit #1): pick the mailbox once here instead of
	// every card repeating its full form per mailbox (page height was
	// O(cards × mailboxes)). Cards receive the id and render only that section.
	const mailboxesQ = myMailboxes();
	let pickedId = $state<string | null>(null);
	const boxes = $derived(mailboxesQ.current ?? []);
	const scopedId = $derived(pickedId ?? boxes[0]?.id ?? null);
	const scopedBox = $derived(boxes.find((box) => box.id === scopedId));
	const labelOf = (box: { displayName: string | null; address: string }) =>
		box.displayName ?? box.address;
</script>

<!--
	Mail settings — grouped + scoped (UX audit):

	· A scope bar picks the mailbox once (hidden while loading and for
	  single-mailbox users, who must see zero extra chrome).
	· Four labeled groups replace the flat card pile: Composing, Incoming,
	  Reading, Your data (audit #2).
	· Heavy cards collapse to a one-line live summary (audit #3+#4) — see
	  settings-collapsible-card.svelte.

	Responsive (verified 320 / 375 / 414 / 768): one column on phones; within
	the Reading and Your data groups the two short cards pair up on lg and
	restack on xl, where the page becomes a 2-track layout — Composing +
	Incoming span 2 tracks (rich-text editors need horizontal room), Reading +
	Your data form the side rail. xl:items-start keeps each track at its
	natural height.
-->
<div class="flex flex-col gap-6">
	{#if boxes.length > 1}
		<div class="flex items-center gap-3">
			<Label for="mail-settings-scope" class="text-muted-foreground shrink-0 text-sm font-normal">
				Settings for
			</Label>
			<Select.Root
				type="single"
				value={scopedId ?? ''}
				onValueChange={(value) => (pickedId = value)}
			>
				<Select.Trigger id="mail-settings-scope" class="w-full max-w-72">
					<span class="truncate">{scopedBox ? labelOf(scopedBox) : 'Choose a mailbox'}</span>
				</Select.Trigger>
				<Select.Content>
					{#each boxes as box (box.id)}
						<Select.Item value={box.id} label={labelOf(box)}>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{labelOf(box)}</span>
								{#if box.displayName}
									<span class="text-muted-foreground truncate text-xs">{box.address}</span>
								{/if}
							</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	{/if}
	<div class="grid grid-cols-1 gap-6 xl:grid-cols-3 xl:items-start">
		<div class="flex flex-col gap-8 xl:col-span-2">
			<section class="flex flex-col gap-3">
				<h2 class="text-muted-foreground text-sm font-medium">Composing</h2>
				<SignaturesCard mailboxId={scopedId} />
				<VacationCard mailboxId={scopedId} />
			</section>
			<section class="flex flex-col gap-3">
				<h2 class="text-muted-foreground text-sm font-medium">Incoming</h2>
				<SenderListsCard mailboxId={scopedId} />
			</section>
		</div>
		<div class="flex flex-col gap-8">
			<section class="flex flex-col gap-3">
				<h2 class="text-muted-foreground text-sm font-medium">Reading</h2>
				<div class="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-1">
					<RemoteImagesCard />
					<ReadingCard />
				</div>
			</section>
			<section class="flex flex-col gap-3">
				<h2 class="text-muted-foreground text-sm font-medium">Your data</h2>
				<div class="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-1">
					<AliasesCard mailboxId={scopedId} />
					<ExportCard mailboxId={scopedId} />
				</div>
			</section>
		</div>
	</div>
</div>
