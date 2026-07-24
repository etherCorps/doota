<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { cn, type WithElementRef } from "$lib/utils/ui.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="empty-title"
	class={cn("font-heading text-lg font-medium tracking-tight", className)}
	{...restProps}
>
	{@render children?.()}
</div>
