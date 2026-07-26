<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Bolds search-term matches in a plain string. Segment render (no {@html}) —
     terms can never inject markup. -->
<script lang="ts">
	import { highlightSegments } from '$lib/utils/highlight';
	let { text, terms }: { text: string | null | undefined; terms: string[] } = $props();
</script>
{#each highlightSegments(text, terms) as seg, i (i)}{#if seg.hit}<mark class="bg-brand/20 rounded-[2px] text-inherit">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
