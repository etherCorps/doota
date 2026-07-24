<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { HTMLLiAttributes } from "svelte/elements";
	import type { WithElementRef } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithElementRef<HTMLLiAttributes> = $props();
</script>

<li bind:this={ref} data-slot="pagination-item" {...restProps}>
	{@render children?.()}
</li>
