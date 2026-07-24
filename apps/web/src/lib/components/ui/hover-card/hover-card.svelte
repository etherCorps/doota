<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { LinkPreview as HoverCardPrimitive } from "bits-ui";

	let { open = $bindable(false), ...restProps }: HoverCardPrimitive.RootProps = $props();
</script>

<HoverCardPrimitive.Root bind:open {...restProps} />
