<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

	let { ...restProps }: DropdownMenuPrimitive.PortalProps = $props();
</script>

<DropdownMenuPrimitive.Portal {...restProps} />
