<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Calendar as CalendarPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CalendarPrimitive.GridBodyProps = $props();
</script>

<CalendarPrimitive.GridBody bind:ref class={cn(className)} {...restProps} />
