<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	let { delayDuration = 0, ...restProps }: TooltipPrimitive.ProviderProps = $props();
</script>

<TooltipPrimitive.Provider {delayDuration} {...restProps} />
