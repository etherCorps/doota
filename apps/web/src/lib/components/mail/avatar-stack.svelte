<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Leading row avatar (also the select-toggle target):
	//  · 0 people → a dashed "add a recipient" glyph (a draft with no To yet)
	//  · else     → the primary sender avatar
	// The group signal (who + how many) lives inline beside the name — see
	// avatar-row.svelte — so this slot stays a single, clean avatar.
	import SenderAvatar from './sender-avatar.svelte';
	import UserRoundPlusIcon from '@lucide/svelte/icons/user-round-plus';

	let { participants, class: cls = '' }: { participants: string[]; class?: string } = $props();
</script>

{#if participants.length === 0}
	<span
		class="text-muted-foreground/70 border-muted-foreground/30 grid shrink-0 place-items-center rounded-full border border-dashed {cls}"
		aria-hidden="true"
	>
		<UserRoundPlusIcon class="size-[45%]" />
	</span>
{:else}
	<SenderAvatar from={participants[0]} class={cls} />
{/if}
