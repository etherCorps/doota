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
	data-slot="sidebar-group-content"
	data-sidebar="group-content"
	class={cn("text-sm w-full", className)}
	{...restProps}
>
	{@render children?.()}
</div>
