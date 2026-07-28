<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Row avatar that reads the conversation at a glance:
	//  · 0 people   → a dashed "add a recipient" glyph (a draft with no To yet)
	//  · ≤2 people  → the single sender avatar (a normal 1:1)
	//  · >2 people  → the sender avatar with a count badge, so a group thread is
	//                 obvious AND you see how many are on it.
	// `participants` are addresses (SenderAvatar extracts the bare addr); `total`
	// is the real (uncapped) headcount — defaults to participants.length.
	import SenderAvatar from './sender-avatar.svelte';
	import UserRoundPlusIcon from '@lucide/svelte/icons/user-round-plus';

	let {
		participants,
		total = participants.length,
		class: cls = ''
	}: { participants: string[]; total?: number; class?: string } = $props();
</script>

{#if participants.length === 0}
	<span
		class="text-muted-foreground/70 border-muted-foreground/30 grid shrink-0 place-items-center rounded-full border border-dashed {cls}"
		aria-hidden="true"
	>
		<UserRoundPlusIcon class="size-[45%]" />
	</span>
{:else if total <= 2}
	<SenderAvatar from={participants[0]} class={cls} />
{:else}
	<!-- Group: primary fills the slot (rows stay aligned, the select-check overlay
	     still covers it); a count badge peeks over the bottom-right. -->
	<span class="relative block shrink-0 {cls}">
		<SenderAvatar from={participants[0]} class="absolute inset-0 size-full" />
		<span
			class="ring-background bg-foreground text-background absolute -right-px -bottom-px grid h-[52%] min-w-[52%] place-items-center rounded-full px-0.5 text-[8px] leading-none font-semibold tabular-nums ring-2"
			aria-label={`${total} people`}
		>
			{total > 9 ? '9+' : total}
		</span>
	</span>
{/if}
