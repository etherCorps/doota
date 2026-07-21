<script lang="ts">
	import { Pagination as PaginationPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";
	import { buttonVariants } from "$lib/components/ui/button/index.js";
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: PaginationPrimitive.NextButtonProps = $props();
</script>

<PaginationPrimitive.NextButton
	bind:ref
	aria-label="Go to next page"
	class={cn(
		buttonVariants({ variant: "ghost", size: "default" }),
		"pr-2!",
		className
	)}
	{...restProps}
>
	<span class="cn-pagination-next-text hidden sm:block">Next</span>
	<CaretRightIcon data-icon="inline-end" />
</PaginationPrimitive.NextButton>
