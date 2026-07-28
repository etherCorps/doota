<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import AliasesCard from '$lib/components/account/aliases-card.svelte';
	import RemoteImagesCard from '$lib/components/account/remote-images-card.svelte';
	import SignaturesCard from '$lib/components/account/signatures-card.svelte';
</script>

<div class="flex flex-col gap-6">
	<SignaturesCard />
	<RemoteImagesCard />
	<AliasesCard />
</div>
