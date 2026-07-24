<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from "$lib/utils/ui.js";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';

	let {
		ref = $bindable(null),
		class: className,
		value = $bindable(""),
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<div data-slot="command-input-wrapper" class="p-1 pb-0">
	<InputGroup.Root class="bg-input/50 h-9">
		<CommandPrimitive.Input
			{value}
			data-slot="command-input"
			class={cn(
				"w-full text-base outline-hidden disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				className
			)}
			{...restProps}
		>
			{#snippet child({ props })}
				<InputGroup.Input {...props} bind:value bind:ref />
			{/snippet}
		</CommandPrimitive.Input>
		<InputGroup.Addon>
			<MagnifyingGlassIcon class="size-4 shrink-0 opacity-50" />
		</InputGroup.Addon>
	</InputGroup.Root>
</div>
