<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { LinkPreview as HoverCardPrimitive } from "bits-ui";

	let { ref = $bindable(null), ...restProps }: HoverCardPrimitive.TriggerProps = $props();
</script>

<HoverCardPrimitive.Trigger bind:ref data-slot="hover-card-trigger" {...restProps} />
