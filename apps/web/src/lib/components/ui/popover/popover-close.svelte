<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Popover as PopoverPrimitive } from "bits-ui";

	let { ref = $bindable(null), ...restProps }: PopoverPrimitive.CloseProps = $props();
</script>

<PopoverPrimitive.Close bind:ref data-slot="popover-close" {...restProps} />
