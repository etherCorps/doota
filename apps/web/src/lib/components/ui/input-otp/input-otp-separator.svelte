<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { HTMLAttributes } from "svelte/elements";
	import type { WithElementRef } from "$lib/utils/ui.js";
	import { cn } from "$lib/utils/ui.js";
	import MinusIcon from 'phosphor-svelte/lib/Minus';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="input-otp-separator"
	role="separator"
	class={cn("[&_svg:not([class*='size-'])]:size-4 flex items-center", className)}
	{...restProps}
>
	{#if children}
		{@render children?.()}
	{:else}
		<MinusIcon  />
	{/if}
</div>
