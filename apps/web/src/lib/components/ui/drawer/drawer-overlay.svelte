<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Drawer as DrawerPrimitive } from "vaul-svelte";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DrawerPrimitive.OverlayProps = $props();
</script>

<DrawerPrimitive.Overlay
	bind:ref
	data-slot="drawer-overlay"
	class={cn("data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-scrim/45 supports-backdrop-filter:bg-scrim/30 supports-backdrop-filter:backdrop-blur-md fixed inset-0 z-50 touch-none", className)}
	{...restProps}
/>
