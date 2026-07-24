<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: SheetPrimitive.TitleProps = $props();
</script>

<SheetPrimitive.Title
	bind:ref
	data-slot="sheet-title"
	class={cn("font-heading text-foreground text-base font-medium", className)}
	{...restProps}
/>
