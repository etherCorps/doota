<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Drawer as DrawerPrimitive } from "vaul-svelte";

	let {
		shouldScaleBackground = true,
		open = $bindable(false),
		activeSnapPoint = $bindable(null),
		...restProps
	}: DrawerPrimitive.RootProps = $props();
</script>

<DrawerPrimitive.NestedRoot {shouldScaleBackground} bind:open bind:activeSnapPoint {...restProps} />
