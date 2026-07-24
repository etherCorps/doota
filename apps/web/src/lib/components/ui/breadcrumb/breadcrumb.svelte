<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { WithElementRef } from "$lib/utils/ui.js";
	import type { HTMLAttributes } from "svelte/elements";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<nav
	bind:this={ref}
	data-slot="breadcrumb"
	aria-label="breadcrumb"
	class={cn("cn-breadcrumb", className)}
	{...restProps}
>
	{@render children?.()}
</nav>
