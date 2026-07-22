<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Toggle } from '$lib/components/ui/toggle/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import UnderlineIcon from '@lucide/svelte/icons/underline';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import RemoveFormattingIcon from '@lucide/svelte/icons/remove-formatting';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import Link2OffIcon from '@lucide/svelte/icons/link-2-off';

	// Rich-text body: contentEditable + execCommand (no editor dependency). Emits
	// HTML on input; the send path derives a text fallback. Links are edited via an
	// inline popover (never a native prompt); the toolbar reflects the caret's
	// current formatting. Pasted images embed inline as data-URIs; the paperclip
	// delegates to the parent for real R2 attachments.
	let {
		initial = '',
		placeholder = 'Write your message…',
		oninput,
		onattach,
		onkeydown
	}: {
		initial?: string;
		placeholder?: string;
		oninput?: (html: string) => void;
		onattach?: () => void;
		onkeydown?: (e: KeyboardEvent) => void;
	} = $props();

	let el = $state<HTMLDivElement>();
	let active = $state({ bold: false, italic: false, underline: false, ul: false, ol: false });

	// Link popover.
	let linkOpen = $state(false);
	let linkUrl = $state('');
	let editingLink = $state(false);
	// Last selection Range inside the editor — restored before applying a link,
	// since opening the popover moves focus out of the contenteditable.
	let savedRange: Range | null = null;

	function selectionInEditor(): boolean {
		const sel = window.getSelection();
		if (!sel || !sel.anchorNode || !el) return false;
		return el.contains(sel.anchorNode);
	}
	function refresh() {
		if (!el || !selectionInEditor()) return;
		savedRange = window.getSelection()?.getRangeAt(0).cloneRange() ?? savedRange;
		active = {
			bold: document.queryCommandState('bold'),
			italic: document.queryCommandState('italic'),
			underline: document.queryCommandState('underline'),
			ul: document.queryCommandState('insertUnorderedList'),
			ol: document.queryCommandState('insertOrderedList')
		};
	}

	onMount(() => {
		if (el && initial) el.innerHTML = initial;
		document.addEventListener('selectionchange', refresh);
	});
	onDestroy(() => document.removeEventListener('selectionchange', refresh));

	function emit() {
		if (el) oninput?.(el.innerHTML);
	}
	function exec(cmd: string, val?: string) {
		el?.focus();
		document.execCommand(cmd, false, val);
		emit();
		refresh();
	}

	function restoreSelection() {
		if (!savedRange || !el) return;
		el.focus();
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(savedRange);
	}
	function anchorInSaved(): HTMLAnchorElement | null {
		let node: Node | null = savedRange?.commonAncestorContainer ?? null;
		while (node && node !== el) {
			if (node instanceof HTMLAnchorElement) return node;
			node = node.parentNode;
		}
		return null;
	}
	function onLinkOpen(open: boolean) {
		if (!open) return;
		const a = anchorInSaved();
		editingLink = !!a;
		linkUrl = a?.getAttribute('href') ?? '';
	}
	function normalize(u: string): string {
		const t = u.trim();
		if (!t) return '';
		if (/^(https?:|mailto:|tel:)/i.test(t)) return t;
		if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
		return `https://${t}`;
	}
	const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	function applyLink() {
		const url = normalize(linkUrl);
		if (!url) return;
		restoreSelection();
		const sel = window.getSelection();
		if (sel && sel.isCollapsed) {
			document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(linkUrl.trim())}</a>&nbsp;`);
		} else {
			document.execCommand('createLink', false, url);
		}
		linkOpen = false;
		linkUrl = '';
		emit();
		refresh();
	}
	function removeLink() {
		restoreSelection();
		document.execCommand('unlink');
		linkOpen = false;
		linkUrl = '';
		emit();
		refresh();
	}

	function onEditorKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			savedRange = selectionInEditor()
				? (window.getSelection()?.getRangeAt(0).cloneRange() ?? savedRange)
				: savedRange;
			linkOpen = true;
			return;
		}
		onkeydown?.(e);
	}

	function onPaste(e: ClipboardEvent) {
		for (const item of e.clipboardData?.items ?? []) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				const reader = new FileReader();
				reader.onload = () => {
					document.execCommand('insertHTML', false, `<img src="${reader.result}" style="max-width:100%" />`);
					emit();
				};
				reader.readAsDataURL(file);
			}
		}
	}
</script>

<div class="focus-within:ring-ring/40 rounded-md border focus-within:ring-2">
	<!-- Single row, formatting group scrolls sideways when narrow (wrap rows used
	     to paint over the text area); attach pinned outside the scroll region. -->
	<div class="text-muted-foreground flex shrink-0 items-center border-b">
		<div class="scrollbar-thin flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 py-1 *:shrink-0">
		<Toggle size="sm" class="size-7 p-0" pressed={active.bold} title="Bold (⌘B)" onPressedChange={() => exec('bold')}>
			<BoldIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-7 p-0" pressed={active.italic} title="Italic (⌘I)" onPressedChange={() => exec('italic')}>
			<ItalicIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-7 p-0" pressed={active.underline} title="Underline (⌘U)" onPressedChange={() => exec('underline')}>
			<UnderlineIcon class="size-4" />
		</Toggle>

		<Separator orientation="vertical" class="mx-1 h-5" />

		<Toggle size="sm" class="size-7 p-0" pressed={active.ul} title="Bulleted list" onPressedChange={() => exec('insertUnorderedList')}>
			<ListIcon class="size-4" />
		</Toggle>
		<Toggle size="sm" class="size-7 p-0" pressed={active.ol} title="Numbered list" onPressedChange={() => exec('insertOrderedList')}>
			<ListOrderedIcon class="size-4" />
		</Toggle>
		<Button variant="ghost" size="icon" class="size-7" title="Quote" onclick={() => exec('formatBlock', 'blockquote')}>
			<QuoteIcon class="size-4" />
		</Button>

		<Separator orientation="vertical" class="mx-1 h-5" />

		<Popover.Root bind:open={linkOpen} onOpenChange={onLinkOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button variant="ghost" size="icon" class="size-7" title="Insert link (⌘K)" {...props}>
						<LinkIcon class="size-4" />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content class="w-80 max-w-[calc(100vw-1rem)] p-2" align="start">
				<form
					class="flex flex-col gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						applyLink();
					}}
				>
					<label for="rich-link-url" class="text-muted-foreground text-xs font-medium">
						{editingLink ? 'Edit link' : 'Link URL'}
					</label>
					<div class="flex items-center gap-1.5">
						<Input
							id="rich-link-url"
							bind:value={linkUrl}
							placeholder="example.com"
							autocomplete="off"
							class="h-8 flex-1"
						/>
						<Button type="submit" size="sm" disabled={!linkUrl.trim()}>Apply</Button>
					</div>
					<div class="flex items-center gap-3">
						{#if editingLink}
							<button
								type="button"
								class="text-muted-foreground hover:text-destructive inline-flex items-center gap-1 text-xs"
								onclick={removeLink}
							>
								<Link2OffIcon class="size-3.5" /> Remove
							</button>
						{/if}
						{#if linkUrl.trim()}
							<a
								href={normalize(linkUrl)}
								target="_blank"
								rel="noopener noreferrer"
								class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
							>
								<ExternalLinkIcon class="size-3.5" /> Open
							</a>
						{/if}
					</div>
				</form>
			</Popover.Content>
		</Popover.Root>

		<Button variant="ghost" size="icon" class="size-7" title="Clear formatting" onclick={() => exec('removeFormat')}>
			<RemoveFormattingIcon class="size-4" />
		</Button>
		</div>

		{#if onattach}
			<Button variant="ghost" size="icon" class="mx-1 size-7 shrink-0" title="Attach file" onclick={onattach}>
				<PaperclipIcon class="size-4" />
			</Button>
		{/if}
	</div>
	<div
		bind:this={el}
		contenteditable="true"
		role="textbox"
		tabindex="0"
		aria-label="Message body"
		data-placeholder={placeholder}
		oninput={() => {
			emit();
			refresh();
		}}
		onpaste={onPaste}
		onkeydown={onEditorKeydown}
		class="prose-sm min-h-[200px] max-w-none overflow-auto px-3 py-2 text-sm outline-none
			[&:empty]:before:text-muted-foreground [&:empty]:before:content-[attr(data-placeholder)]
			[&_a]:text-brand [&_a]:underline
			[&_blockquote]:border-muted-foreground/30 [&_blockquote]:text-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-3"
	></div>
</div>
