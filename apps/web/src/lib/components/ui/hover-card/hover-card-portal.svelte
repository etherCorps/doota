<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { LinkPreview as HoverCardPrimitive } from "bits-ui";

	let { ...restProps }: HoverCardPrimitive.PortalProps = $props();
</script>

<HoverCardPrimitive.Portal {...restProps} />
