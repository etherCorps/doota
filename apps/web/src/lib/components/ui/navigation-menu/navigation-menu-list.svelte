<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { NavigationMenu as NavigationMenuPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: NavigationMenuPrimitive.ListProps = $props();
</script>

<NavigationMenuPrimitive.List
	bind:ref
	data-slot="navigation-menu-list"
	class={cn(
		"gap-0 group flex flex-1 list-none items-center justify-center",
		className
	)}
	{...restProps}
/>
