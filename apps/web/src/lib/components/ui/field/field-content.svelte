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
	data-slot="field-content"
	class={cn("gap-1 group/field-content flex flex-1 flex-col leading-snug", className)}
	{...restProps}
>
	{@render children?.()}
</div>
