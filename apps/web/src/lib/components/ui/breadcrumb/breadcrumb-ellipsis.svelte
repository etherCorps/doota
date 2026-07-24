<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef, type WithoutChildren } from "$lib/utils/ui.js";
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLSpanElement>>> = $props();
</script>

<span
	bind:this={ref}
	data-slot="breadcrumb-ellipsis"
	role="presentation"
	aria-hidden="true"
	class={cn("size-5 [&>svg]:size-4 flex items-center justify-center", className)}
	{...restProps}
>
	<DotsThreeIcon  />
	<span class="sr-only">More</span>
</span>
