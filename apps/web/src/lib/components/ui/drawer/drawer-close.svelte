<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Drawer as DrawerPrimitive } from "vaul-svelte";

	let { ref = $bindable(null), ...restProps }: DrawerPrimitive.CloseProps = $props();
</script>

<DrawerPrimitive.Close bind:ref data-slot="drawer-close" {...restProps} />
