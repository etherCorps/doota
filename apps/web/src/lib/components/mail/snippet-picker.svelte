<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Canned-response picker for the composer toolbar: lists the user's snippets
	// (filter-as-you-type on the title) and hands the chosen body back to the
	// editor, which inserts it at the caret. Deliberately dumb — no editing here;
	// that lives in Account → Mail. The list is fetched on first open, not on
	// composer mount: most messages never reach for a snippet.
	import * as Popover from '$lib/components/ui/popover/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { resolve } from '$app/paths';
	import { mySnippets, type Snippet } from '$lib/rpc/snippet.remote';
	import TextQuoteIcon from '@lucide/svelte/icons/text-quote';

	let { oninsert }: { oninsert: (html: string) => void } = $props();

	const isMobile = new IsMobile();
	let open = $state(false);
	let q = $state('');
	// Armed on first open and never disarmed, so the remote query (cached by
	// SvelteKit) is created once and later opens are instant.
	let armed = $state(false);
	const snippetsQ = $derived(armed ? mySnippets() : null);
	const shown = $derived.by(() => {
		const all = snippetsQ?.current ?? [];
		const needle = q.trim().toLowerCase();
		return needle ? all.filter((snippet) => snippet.title.toLowerCase().includes(needle)) : all;
	});

	function onOpenChange(value: boolean) {
		if (value) {
			armed = true;
			q = '';
		}
	}

	function pick(snippet: Snippet) {
		open = false;
		oninsert(snippet.bodyHtml); // after close: the editor keeps the caret (see onCloseAutoFocus)
	}

	/** One-line plain-text teaser under the title. */
	function preview(html: string): string {
		return html
			.replace(/<[^>]*>/g, ' ')
			.replace(/&nbsp;/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	const rowCls =
		'hover:bg-muted focus-visible:ring-ring/50 flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2';
	const title = 'Insert snippet';
</script>

{#snippet body()}
	<div class="border-b p-2">
		<Input
			class="h-8 text-xs pointer-coarse:text-base"
			placeholder="Search snippets…"
			aria-label="Search snippets"
			bind:value={q}
			onkeydown={(event) => {
				// Enter picks the first match — type a few letters, hit Enter, done.
				if (event.key === 'Enter' && shown[0]) {
					event.preventDefault();
					pick(shown[0]);
				}
			}}
		/>
	</div>
	<div class="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
		{#if !snippetsQ || snippetsQ.current === undefined}
			<div class="flex flex-col gap-2 p-2">
				<Skeleton class="h-4 w-32 rounded-md" />
				<Skeleton class="h-4 w-44 rounded-md" />
			</div>
		{:else}
			{#each shown as snippet (snippet.id)}
				<button type="button" class={rowCls} onclick={() => pick(snippet)}>
					<span class="w-full truncate font-medium">{snippet.title}</span>
					<span class="text-muted-foreground w-full truncate text-xs">{preview(snippet.bodyHtml)}</span>
				</button>
			{:else}
				{#if q.trim()}
					<p class="text-muted-foreground px-2 py-3 text-center text-xs">No snippet matches.</p>
				{:else}
					<p class="text-muted-foreground px-2 py-3 text-center text-xs">
						No snippets yet. Create canned responses in
						<a href={resolve('/account/mail')} class="text-foreground underline underline-offset-2">Account → Mail</a>.
					</p>
				{/if}
			{/each}
		{/if}
	</div>
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open {onOpenChange}>
		<Drawer.Trigger>
			{#snippet child({ props })}
				<Button variant="ghost" size="icon" class="size-8" {title} aria-label={title} {...props}>
					<TextQuoteIcon class="size-4" />
				</Button>
			{/snippet}
		</Drawer.Trigger>
		<Drawer.Content
			class="p-0"
			onOpenAutoFocus={(event) => event.preventDefault()}
			onCloseAutoFocus={(event) => event.preventDefault()}
		>
			<Drawer.Header class="pb-2">
				<Drawer.Title class="text-sm">Insert snippet</Drawer.Title>
			</Drawer.Header>
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Popover.Root bind:open {onOpenChange}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Button variant="ghost" size="icon" class="size-8" {title} aria-label={title} {...props}>
					<TextQuoteIcon class="size-4" />
				</Button>
			{/snippet}
		</Popover.Trigger>
		<!-- onCloseAutoFocus prevented: the insert already put the caret in the
		     editor right after the new text; the default focus-return to the
		     toolbar button would yank it back out. -->
		<Popover.Content
			align="start"
			class="w-72 max-w-[calc(100vw-1rem)] p-0"
			onCloseAutoFocus={(event) => event.preventDefault()}
		>
			{@render body()}
		</Popover.Content>
	</Popover.Root>
{/if}
