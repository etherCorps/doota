<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Keyboard-shortcut reference. Opened by `?` (guarded against typing contexts
     in the app layout) or the command palette's "Keyboard shortcuts" action.
     Modifier symbols are OS-aware (⌘ on Mac, Ctrl elsewhere) — the handlers
     themselves accept metaKey||ctrlKey either way. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';
	import { MOD, SHIFT } from '$lib/utils/platform';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	// Each shortcut: label + the keys to render (already OS-resolved).
	type Row = { keys: string[]; label: string };
	const groups: { heading: string; rows: Row[] }[] = [
		{
			heading: 'General',
			rows: [
				{ keys: [MOD, 'K'], label: 'Search / command palette' },
				{ keys: [MOD, 'B'], label: 'Toggle sidebar' },
				{ keys: ['C'], label: 'Compose new message' },
				{ keys: ['?'], label: 'Show this help' }
			]
		},
		{
			heading: 'Conversation list',
			rows: [
				{ keys: ['J'], label: 'Next conversation' },
				{ keys: ['K'], label: 'Previous conversation' },
				{ keys: ['E'], label: 'Archive' }
			]
		},
		{
			heading: 'Open conversation',
			rows: [
				{ keys: ['R'], label: 'Reply' },
				{ keys: ['A'], label: 'Reply all' },
				{ keys: ['F'], label: 'Forward' },
				{ keys: ['/'], label: 'Find in conversation' },
				{ keys: ['Esc'], label: 'Close / back' }
			]
		},
		{
			heading: 'Compose',
			rows: [
				{ keys: [MOD, 'Enter'], label: 'Send' },
				{ keys: ['Esc'], label: 'Close composer' }
			]
		},
		{
			heading: 'Find in conversation',
			rows: [
				{ keys: ['Enter'], label: 'Next match' },
				{ keys: [SHIFT, 'Enter'], label: 'Previous match' }
			]
		}
	];
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description>Work faster without leaving the keyboard.</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
			{#each groups as group (group.heading)}
				<section>
					<h3 class="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">{group.heading}</h3>
					<ul class="space-y-1.5">
						{#each group.rows as row (row.label)}
							<li class="flex items-center justify-between gap-4 text-sm">
								<span class="text-foreground">{row.label}</span>
								<span class="flex shrink-0 items-center gap-1">
									{#each row.keys as key (key)}
										<Kbd>{key}</Kbd>
									{/each}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>
