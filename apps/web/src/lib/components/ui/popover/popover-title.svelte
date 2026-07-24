<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="popover-title"
	class={cn("font-heading text-base font-medium", className)}
	{...restProps}
>
	{@render children?.()}
</div>
