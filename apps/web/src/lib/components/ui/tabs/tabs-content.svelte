<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: TabsPrimitive.ContentProps = $props();
</script>

<TabsPrimitive.Content
	bind:ref
	data-slot="tabs-content"
	class={cn("text-sm flex-1 outline-none", className)}
	{...restProps}
/>
