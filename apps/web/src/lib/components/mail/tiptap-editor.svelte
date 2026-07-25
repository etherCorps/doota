<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import { ResizableImage } from './resizable-image.js';
	import { HarperGrammar, applyHarperFix, type ActiveLint, type HarperSuggestion } from './harper-extension.js';
	import { portal } from '$lib/client/portal';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toggle } from '$lib/components/ui/toggle/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import UnderlineIcon from '@lucide/svelte/icons/underline';
	import StrikethroughIcon from '@lucide/svelte/icons/strikethrough';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import ImageIcon from '@lucide/svelte/icons/image';
	import RemoveFormattingIcon from '@lucide/svelte/icons/remove-formatting';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import Link2OffIcon from '@lucide/svelte/icons/link-2-off';
	import SpellCheckIcon from '@lucide/svelte/icons/spell-check';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';

	// TipTap (ProseMirror) rich-text body — real document model, proper a11y, no
	// execCommand. Titled links, pasted/inserted inline images (base64), live
	// toolbar state. The paperclip delegates real attachments to the parent.
	let {
		initial = '',
		placeholder = 'Write your message…',
		oninput,
		onattach,
		onsend,
		bodyClass = ''
	}: {
		initial?: string;
		placeholder?: string;
		oninput?: (html: string) => void;
		onattach?: () => void;
		/** ⌘/Ctrl+Enter inside the editor. */
		onsend?: () => void;
		/** Extra classes for the scrollable body — e.g. a max-height cap when inlined. */
		bodyClass?: string;
	} = $props();

	let element = $state<HTMLDivElement>();
	let editor = $state<Editor>();
	let imageInput = $state<HTMLInputElement>();
	let tick = $state(0);

	let linkOpen = $state(false);
	let linkUrl = $state('');
	let linkText = $state('');
	let editingLink = $state(false);

	// Harper grammar check (lazy WASM). Underlines flag issues; clicking an
	// underlined word opens a suggestion menu — pick one to apply + flash green.
	let harperStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let harperCount = $state(0);
	let activeLint = $state<ActiveLint | null>(null);
	// Only surface the grammar pill once there's text — a spinner on an empty
	// composer is meaningless.
	let hasContent = $state(false);

	function pickSuggestion(s: HarperSuggestion) {
		if (editor && activeLint) applyHarperFix(editor.view, activeLint.lint, s);
		activeLint = null;
	}
	function suggestionLabel(s: HarperSuggestion): string {
		if (s.kind === 'remove') return 'Remove';
		if (s.kind === 'insert') return `Insert “${s.text}”`;
		return s.text;
	}

	$effect(() => {
		if (!activeLint) return;
		const close = () => (activeLint = null);
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
		const onDown = (e: PointerEvent) => {
			if (!(e.target as Element)?.closest?.('[data-harper-menu]')) close();
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('resize', close);
		// Capture scrolls anywhere (composer body scrolls) so the menu can't float away.
		window.addEventListener('scroll', close, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('resize', close);
			window.removeEventListener('scroll', close, true);
		};
	});

	const active = (name: string, attrs?: Record<string, unknown>) => {
		void tick;
		return editor?.isActive(name, attrs) ?? false;
	};

	function normalize(u: string): string {
		const t = u.trim();
		if (!t) return '';
		if (/^(https?:|mailto:|tel:)/i.test(t)) return t;
		if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
		return `https://${t}`;
	}
	function selectionText(): string {
		if (!editor) return '';
		const { from, to } = editor.state.selection;
		return editor.state.doc.textBetween(from, to, ' ');
	}
	function openLink() {
		if (!editor) return;
		editingLink = editor.isActive('link');
		linkUrl = (editor.getAttributes('link').href as string) ?? '';
		// Prefill display text: an existing link's text (extend the range), else the
		// current selection.
		if (editingLink) {
			editor.chain().extendMarkRange('link').run();
		}
		linkText = selectionText();
		linkOpen = true;
	}
	function applyLink() {
		const href = normalize(linkUrl);
		if (!href || !editor) return;
		const label = linkText.trim() || linkUrl.trim();
		const chain = editor.chain().focus().extendMarkRange('link');
		const selEmpty = editor.state.selection.empty;
		// Insert titled text when there's a custom label, an empty selection, or we're
		// editing an existing link; otherwise just wrap the current selection.
		if (editingLink || selEmpty || label !== selectionText()) {
			chain.insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }).run();
		} else {
			chain.setLink({ href }).run();
		}
		linkOpen = false;
		linkUrl = '';
		linkText = '';
	}
	function removeLink() {
		editor?.chain().focus().extendMarkRange('link').unsetLink().run();
		linkOpen = false;
		linkUrl = '';
		linkText = '';
	}

	function insertImageFile(file: File) {
		if (!file.type.startsWith('image/')) return;
		const reader = new FileReader();
		reader.onload = () => editor?.chain().focus().setImage({ src: String(reader.result) }).run();
		reader.readAsDataURL(file);
	}
	function onImageFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		for (const f of input.files ?? []) insertImageFile(f);
		input.value = '';
	}

	onMount(() => {
		editor = new Editor({
			element,
			extensions: [
				StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
				Placeholder.configure({ placeholder }),
				ResizableImage.configure({ inline: true, allowBase64: true }),
				HarperGrammar.configure({
					debounceMs: 600,
					onStatus: (s) => (harperStatus = s),
					onCount: (n) => (harperCount = n),
					onActiveLint: (p) => (activeLint = p)
				})
			],
			content: initial,
			editorProps: {
				attributes: {
					role: 'textbox',
					'aria-multiline': 'true',
					'aria-label': 'Message body',
					// Harper owns the squiggles; native spellcheck would draw its own
					// (unhookable) red underlines over the same words.
					spellcheck: 'false',
					class:
						'tiptap prose-sm min-h-[200px] max-w-none px-3 py-2 text-base outline-none focus:outline-none md:text-sm'
				},
				handleKeyDown: (_view, event) => {
					const mod = event.metaKey || event.ctrlKey;
					if (mod && event.key === 'Enter') {
						onsend?.();
						return true;
					}
					if (mod && event.key.toLowerCase() === 'k') {
						event.preventDefault();
						openLink();
						return true;
					}
					return false;
				},
				handlePaste: (_view, event) => {
					const imgs = [...(event.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/'));
					if (!imgs.length) return false;
					event.preventDefault();
					for (const item of imgs) {
						const file = item.getAsFile();
						if (file) insertImageFile(file);
					}
					return true;
				}
			},
			onUpdate: ({ editor }) => {
				oninput?.(editor.getHTML());
				hasContent = editor.getText().trim().length > 0;
			},
			onTransaction: () => (tick += 1)
		});
		hasContent = editor.getText().trim().length > 0; // seed (a reply prefills quoted text)
	});
	onDestroy(() => editor?.destroy());
</script>

<div class="focus-within:ring-ring/40 flex h-full min-h-[180px] flex-col rounded-lg border focus-within:ring-2">
	<!-- Single row that never wraps: the formatting group scrolls horizontally
	     when the composer is narrow — wrapped toolbar rows painted over the text
	     area (flex computes a wrapping row's min height as one line). The attach
	     button stays pinned outside the scroll region. -->
	<div class="text-muted-foreground flex shrink-0 items-center border-b">
		<div class="scrollbar-thin flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5 py-1 *:shrink-0">
		<Toggle size="sm" class="size-8 p-0" pressed={active('bold')} title="Bold (⌘B)" onPressedChange={() => editor?.chain().focus().toggleBold().run()}>
			<BoldIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-8 p-0" pressed={active('italic')} title="Italic (⌘I)" onPressedChange={() => editor?.chain().focus().toggleItalic().run()}>
			<ItalicIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-8 p-0" pressed={active('underline')} title="Underline (⌘U)" onPressedChange={() => editor?.chain().focus().toggleUnderline().run()}>
			<UnderlineIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-8 p-0" pressed={active('strike')} title="Strikethrough" onPressedChange={() => editor?.chain().focus().toggleStrike().run()}>
			<StrikethroughIcon class="size-4" />
		</Toggle>

		<Separator orientation="vertical" class="mx-1 h-5" />

		<Toggle size="sm" class="size-8 p-0" pressed={active('bulletList')} title="Bulleted list" onPressedChange={() => editor?.chain().focus().toggleBulletList().run()}>
			<ListIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-8 p-0" pressed={active('orderedList')} title="Numbered list" onPressedChange={() => editor?.chain().focus().toggleOrderedList().run()}>
			<ListOrderedIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-8 p-0" pressed={active('blockquote')} title="Quote" onPressedChange={() => editor?.chain().focus().toggleBlockquote().run()}>
			<QuoteIcon class="size-4" />
		</Toggle>

		<Separator orientation="vertical" class="mx-1 h-5" />

		<Popover.Root bind:open={linkOpen} onOpenChange={(o) => o && openLink()}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Toggle size="sm" class="size-8 p-0" pressed={active('link')} title="Link (⌘K)" {...props}>
						<LinkIcon class="size-4" />
					</Toggle>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-80 max-w-[calc(100vw-1rem)] p-2" align="start">
				<form class="flex flex-col gap-2" onsubmit={(e) => { e.preventDefault(); applyLink(); }}>
					<div class="flex flex-col gap-1">
						<label for="tiptap-link-text" class="text-muted-foreground text-xs font-medium">Text</label>
						<Input id="tiptap-link-text" bind:value={linkText} placeholder="Display text (optional)" autocomplete="off" class="h-8" />
					</div>
					<div class="flex flex-col gap-1">
						<label for="tiptap-link-url" class="text-muted-foreground text-xs font-medium">
							{editingLink ? 'Edit link' : 'URL'}
						</label>
						<div class="flex items-center gap-1.5">
							<Input id="tiptap-link-url" bind:value={linkUrl} placeholder="example.com" autocomplete="off" class="h-8 flex-1" />
							<Button type="submit" size="sm" disabled={!linkUrl.trim()}>Apply</Button>
						</div>
					</div>
					<div class="flex items-center gap-3">
						{#if editingLink}
							<button type="button" class="text-muted-foreground hover:text-destructive inline-flex items-center gap-1 text-xs" onclick={removeLink}>
								<Link2OffIcon class="size-3.5" /> Remove
							</button>
						{/if}
						{#if linkUrl.trim()}
							<a href={normalize(linkUrl)} target="_blank" rel="noopener noreferrer" class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs">
								<ExternalLinkIcon class="size-3.5" /> Open
							</a>
						{/if}
					</div>
				</form>
			</Popover.Content>
		</Popover.Root>

		<Button variant="ghost" size="icon" class="size-8" title="Insert image" onclick={() => imageInput?.click()}>
			<ImageIcon class="size-4" />
		</Button>
		<Button variant="ghost" size="icon" class="size-8" title="Clear formatting" onclick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}>
			<RemoveFormattingIcon class="size-4" />
		</Button>
		</div>

		{#if hasContent && harperStatus !== 'idle'}
			<div class="text-muted-foreground mr-0.5 flex shrink-0 items-center gap-1 text-xs" title="Grammar check runs on-device (Harper)">
				{#if harperStatus === 'loading'}
					<Loader2Icon class="size-3.5 animate-spin" />
				{:else if harperStatus === 'error'}
					<SpellCheckIcon class="text-destructive size-3.5" />
				{:else}
					<SpellCheckIcon class="size-3.5 {harperCount ? 'text-amber-500' : 'text-emerald-500'}" />
					{#if harperCount}<span class="tabular-nums">{harperCount}</span>{/if}
				{/if}
			</div>
		{/if}

		{#if onattach}
			<Button variant="ghost" size="icon" class="mx-1 size-8 shrink-0" title="Attach file" onclick={onattach}>
				<PaperclipIcon class="size-4" />
			</Button>
		{/if}
	</div>

	<div bind:this={element} class="scrollbar-thin min-h-0 flex-1 overflow-auto {bodyClass}"></div>
	<input bind:this={imageInput} type="file" accept="image/*" multiple class="hidden" onchange={onImageFiles} />

	{#if activeLint}
		<!-- Portaled to <body>: the compose drawer is transformed, which would make a
		     fixed element position against the drawer box instead of the viewport. -->
		<div
			use:portal
			data-harper-menu
			role="menu"
			tabindex="-1"
			class="bg-popover text-popover-foreground fixed z-50 max-h-64 w-56 max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border p-1 shadow-md"
			style="left:{Math.min(activeLint.left, window.innerWidth - 232)}px; top:{activeLint.bottom + 6}px"
		>
			<p class="text-muted-foreground px-2 pt-1 pb-1.5 text-xs">{activeLint.lint.message}</p>
			{#each activeLint.lint.suggestions.slice(0, 6) as s (s.kind + s.text)}
				<button
					type="button"
					role="menuitem"
					class="hover:bg-accent hover:text-accent-foreground flex w-full items-center rounded px-2 py-1.5 text-left text-sm"
					onclick={() => pickSuggestion(s)}
				>
					{suggestionLabel(s)}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* Zero the default block margins so the content aligns with the px-4 py-3
	   padding; keep breathing room between blocks only. */
	:global(.tiptap > *) {
		margin: 0;
	}
	:global(.tiptap > * + *) {
		margin-top: 0.5rem;
	}
	:global(.tiptap p.is-empty:first-child::before) {
		content: attr(data-placeholder);
		color: var(--muted-foreground);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.tiptap a) {
		color: var(--accent);
		text-decoration: underline;
	}
	/* Harper grammar underlines. Spelling/typos red; everything else amber. */
	:global(.tiptap .harper-underline) {
		text-decoration: underline wavy #eab308;
		text-decoration-skip-ink: none;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	:global(.tiptap .harper-spelling),
	:global(.tiptap .harper-typo),
	:global(.tiptap .harper-malapropism) {
		text-decoration-color: var(--destructive);
	}
	/* Transient green flash after an auto-fix, then fades out. */
	:global(.tiptap .harper-fixed) {
		border-radius: 3px;
		background-color: color-mix(in oklch, var(--color-emerald-500, #22c55e) 32%, transparent);
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--color-emerald-500, #22c55e) 22%, transparent);
		animation: harper-fix-fade 1.1s ease-out forwards;
	}
	@keyframes harper-fix-fade {
		0% {
			background-color: color-mix(in oklch, var(--color-emerald-500, #22c55e) 45%, transparent);
		}
		100% {
			background-color: transparent;
			box-shadow: none;
		}
	}
	:global(.tiptap .img-resizer) {
		position: relative;
		display: inline-block;
		line-height: 0;
	}
	:global(.tiptap .img-resizer img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.375rem;
	}
	:global(.tiptap .img-resizer.ProseMirror-selectednode img) {
		outline: 2px solid var(--accent);
	}
	:global(.tiptap .img-resize-handle) {
		position: absolute;
		right: 4px;
		bottom: 4px;
		width: 12px;
		height: 12px;
		border: 2px solid var(--background);
		border-radius: 3px;
		background: var(--accent);
		cursor: nwse-resize;
		opacity: 0;
		transition: opacity 120ms ease-out;
	}
	:global(.tiptap .img-resizer:hover .img-resize-handle),
	:global(.tiptap .img-resizer.ProseMirror-selectednode .img-resize-handle) {
		opacity: 1;
	}
	:global(.tiptap blockquote) {
		border-left: 2px solid color-mix(in oklch, var(--muted-foreground) 30%, transparent);
		padding-left: 0.75rem;
		color: var(--muted-foreground);
	}
	:global(.tiptap ul) {
		list-style: disc;
		padding-left: 1.25rem;
	}
	:global(.tiptap ol) {
		list-style: decimal;
		padding-left: 1.25rem;
	}
</style>
