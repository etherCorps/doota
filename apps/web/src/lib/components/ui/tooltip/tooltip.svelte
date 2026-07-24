<script lang="ts" generics="T = never">
	// SPDX-License-Identifier: Apache-2.0
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	let { open = $bindable(false), ...restProps }: TooltipPrimitive.RootProps<T> = $props();
</script>

<TooltipPrimitive.Root bind:open {...restProps} />
