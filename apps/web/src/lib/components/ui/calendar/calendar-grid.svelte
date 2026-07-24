<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Calendar as CalendarPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CalendarPrimitive.GridProps = $props();
</script>

<CalendarPrimitive.Grid
	bind:ref
	class={cn("flex w-full border-collapse flex-col", className)}
	{...restProps}
/>
