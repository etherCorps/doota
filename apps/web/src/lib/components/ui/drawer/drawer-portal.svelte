<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Drawer as DrawerPrimitive } from "vaul-svelte";

	let { ...restProps }: DrawerPrimitive.PortalProps = $props();
</script>

<DrawerPrimitive.Portal {...restProps} />
