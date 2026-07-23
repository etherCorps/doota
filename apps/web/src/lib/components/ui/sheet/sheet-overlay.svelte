<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: SheetPrimitive.OverlayProps = $props();
</script>

<SheetPrimitive.Overlay
	bind:ref
	data-slot="sheet-overlay"
	class={cn("bg-scrim/45 supports-backdrop-filter:bg-scrim/30 supports-backdrop-filter:backdrop-blur-md fixed inset-0 z-50 touch-none", className)}
	{...restProps}
/>
