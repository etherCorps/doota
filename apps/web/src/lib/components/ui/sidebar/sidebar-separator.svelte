<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Separator } from "$lib/components/ui/separator/index.js";
	import { cn } from "$lib/utils/ui.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ComponentProps<typeof Separator> = $props();
</script>

<Separator
	bind:ref
	data-slot="sidebar-separator"
	data-sidebar="separator"
	class={cn("bg-sidebar-border mx-2 w-auto", className)}
	{...restProps}
/>
