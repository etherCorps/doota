<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: shared collapsed-by-default card shell (Hick's law — five
	// always-open forms become one-line summaries). The whole header is the
	// disclosure button (real <button>, aria-expanded from bits-ui); `summary`
	// is a live one-liner fed by data the card already loads. The long
	// CardDescription belongs inside `children`, visible only once open.
	import type { Snippet } from 'svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Collapsible from '$lib/components/ui/collapsible/index.js';

	let {
		title,
		summary,
		children,
		contentClass = 'flex flex-col gap-5'
	}: {
		title: Snippet;
		summary: Snippet;
		children: Snippet;
		contentClass?: string;
	} = $props();
</script>

<Collapsible.Root>
	<Card.Card>
		<Card.CardHeader>
			<Collapsible.Trigger
				class="group/settings-collapse focus-visible:ring-ring -mx-2 -my-1 flex w-full flex-col gap-1.5 rounded-md px-2 py-1 text-left focus-visible:ring-2 focus-visible:outline-none"
			>
				<span class="flex w-full items-center justify-between gap-2">
					<!-- Mirrors Card.CardTitle's classes — the title must live inside the
					     button so the whole header row is one click target. -->
					<span class="font-heading flex min-w-0 items-center gap-2 text-base font-medium">
						{@render title()}
					</span>
					<ChevronDownIcon
						class="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]/settings-collapse:rotate-180"
					/>
				</span>
				<span class="text-muted-foreground min-w-0 truncate text-sm">
					{@render summary()}
				</span>
			</Collapsible.Trigger>
		</Card.CardHeader>
		<Collapsible.Content>
			<Card.CardContent class={contentClass}>
				{@render children()}
			</Card.CardContent>
		</Collapsible.Content>
	</Card.Card>
</Collapsible.Root>
