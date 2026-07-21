<script lang="ts">
	import { DecorIcon } from '$lib/components/ui/decor-icon';
	import { cn } from '$lib/utils/ui.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props = HTMLAttributes<HTMLDivElement> & {
		title: string;
		description: string;
		children: Snippet;
	};

	let { title, description, children, class: className, ...restProps }: Props = $props();
</script>

<div
	class={cn(
		'relative flex h-screen w-full items-center justify-center overflow-hidden px-6 md:px-8',
		className
	)}
	{...restProps}
>
	<div
		class={cn(
			'relative flex w-full max-w-sm flex-col justify-between p-6 md:p-8',
			'dark:bg-[radial-gradient(50%_80%_at_20%_0%,--theme(--color-foreground/.1),transparent)]'
		)}
	>
		<div class="absolute -inset-y-6 -left-px w-px bg-border"></div>
		<div class="absolute -inset-y-6 -right-px w-px bg-border"></div>
		<div class="absolute -inset-x-6 -top-px h-px bg-border"></div>
		<div class="absolute -inset-x-6 -bottom-px h-px bg-border"></div>

		<DecorIcon position="top-left" />
		<DecorIcon position="bottom-right" />

		<div class="w-full max-w-sm animate-in space-y-8">
			<div class="flex flex-col space-y-1">
				<h1 class="text-2xl font-bold tracking-wide">{title}</h1>
			<p class="text-base text-muted-foreground">{description}</p>
			</div>

			<div class="space-y-4">
				{@render children()}
			</div>
		</div>
	</div>
</div>
