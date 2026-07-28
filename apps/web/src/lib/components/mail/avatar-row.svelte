<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Inline participant cluster shown beside a group thread's name — a compact,
	// horizontal row of small overlapped avatars so the conversation reads as a
	// group at a glance. Groups only (total > 2, the caller guards):
	//  · ≤3 people → that many real faces (user image or dicebear, via SenderAvatar)
	//  · >3 people → 2 real faces + a "+N" overflow chip (N = total − 2, "9+" past 9)
	// shrink-0 + no-wrap so it never steals width from the (truncating) name.
	import SenderAvatar from './sender-avatar.svelte';

	let { participants, total }: { participants: string[]; total: number } = $props();

	const faceCls = 'ring-background size-4 shrink-0 rounded-full text-[6px] ring-2';
</script>

{#if total > 2}
	<span class="flex shrink-0 items-center self-center" aria-label={`${total} people`}>
		{#if total <= 3}
			{#each participants.slice(0, 3) as p, i (p)}
				<SenderAvatar from={p} class="{faceCls} {i > 0 ? '-ml-1.5' : ''}" />
			{/each}
		{:else}
			{#each participants.slice(0, 2) as p, i (p)}
				<SenderAvatar from={p} class="{faceCls} {i > 0 ? '-ml-1.5' : ''}" />
			{/each}
			<span
				class="ring-background bg-muted text-muted-foreground relative z-10 -ml-1.5 grid size-4 shrink-0 place-items-center rounded-full text-[7px] leading-none font-semibold tabular-nums ring-2"
			>
				{total - 2 > 9 ? '9+' : `+${total - 2}`}
			</span>
		{/if}
	</span>
{/if}
