<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import { ResizableImage } from './resizable-image.js';
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

	// TipTap (ProseMirror) rich-text body — real document model, proper a11y, no
	// execCommand. Titled links, pasted/inserted inline images (base64), live
	// toolbar state. The paperclip delegates real attachments to the parent.
	let {
		initial = '',
		placeholder = 'Write your message…',
		oninput,
		onattach,
		onsend
	}: {
		initial?: string;
		placeholder?: string;
		oninput?: (html: string) => void;
		onattach?: () => void;
		/** ⌘/Ctrl+Enter inside the editor. */
		onsend?: () => void;
	} = $props();

	let element = $state<HTMLDivElement>();
	let editor = $state<Editor>();
	let imageInput = $state<HTMLInputElement>();
	let tick = $state(0);

	let linkOpen = $state(false);
	let linkUrl = $state('');
	let linkText = $state('');
	let editingLink = $state(false);

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
				ResizableImage.configure({ inline: true, allowBase64: true })
			],
			content: initial,
			editorProps: {
				attributes: {
					role: 'textbox',
					'aria-multiline': 'true',
					'aria-label': 'Message body',
					class:
						'tiptap prose-sm min-h-[200px] max-w-none px-3 py-2 text-sm outline-none focus:outline-none'
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
			onUpdate: ({ editor }) => oninput?.(editor.getHTML()),
			onTransaction: () => (tick += 1)
		});
	});
	onDestroy(() => editor?.destroy());
</script>

<div class="focus-within:ring-ring/40 flex h-full min-h-[180px] flex-col rounded-lg border focus-within:ring-2">
	<div class="text-muted-foreground flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1">
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
			<Popover.Content class="w-80 p-2" align="start">
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

		{#if onattach}
			<Button variant="ghost" size="icon" class="ml-auto size-8" title="Attach file" onclick={onattach}>
				<PaperclipIcon class="size-4" />
			</Button>
		{/if}
	</div>

	<div bind:this={element} class="scrollbar-thin min-h-0 flex-1 overflow-auto"></div>
	<input bind:this={imageInput} type="file" accept="image/*" multiple class="hidden" onchange={onImageFiles} />
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
