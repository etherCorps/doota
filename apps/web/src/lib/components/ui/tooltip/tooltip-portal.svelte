<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	let { ...restProps }: TooltipPrimitive.PortalProps = $props();
</script>

<TooltipPrimitive.Portal {...restProps} />
