<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import AliasesCard from '$lib/components/account/aliases-card.svelte';
	import RemoteImagesCard from '$lib/components/account/remote-images-card.svelte';
	import SignaturesCard from '$lib/components/account/signatures-card.svelte';
</script>

<!--
	Mail settings — three responsive bands so every width is used without a card
	ever getting cramped or stretched (verified 320 / 375 / 414 / 768):

	· phone (<md): one column — Signatures, Aliases, Remote images stacked.
	· tablet / small desktop (md–xl): Signatures full width on top; Aliases +
	  Remote images pair up in a 2-col row beneath, so the two short cards fill
	  the width instead of each stretching alone.
	· wide desktop (xl+): a 3-track grid — Signatures spans 2 tracks (rich-text
	  editors need horizontal room and it's the primary task, Von Restorff);
	  Aliases + Remote images stack in the 3rd track as a side rail, so the page
	  reads in one glance instead of a long scroll (Hick's).

	items-start keeps each card at its natural height (the short Remote-images
	toggle never stretches to match a taller neighbour). grid-cols use Tailwind's
	minmax(0,1fr) tracks, so long content truncates instead of forcing scroll.
-->
<div class="grid grid-cols-1 gap-6 xl:grid-cols-3 xl:items-start">
	<div class="xl:col-span-2">
		<SignaturesCard />
	</div>
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-1">
		<AliasesCard />
		<RemoteImagesCard />
	</div>
</div>
