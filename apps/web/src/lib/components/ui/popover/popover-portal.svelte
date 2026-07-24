<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Popover as PopoverPrimitive } from "bits-ui";

	let { ...restProps }: PopoverPrimitive.PortalProps = $props();
</script>

<PopoverPrimitive.Portal {...restProps} />
