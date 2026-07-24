<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Calendar as CalendarPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CalendarPrimitive.HeadingProps = $props();
</script>

<CalendarPrimitive.Heading
	bind:ref
	class={cn("px-(--cell-size) text-sm font-medium", className)}
	{...restProps}
/>
