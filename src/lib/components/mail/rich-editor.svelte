<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ListIcon from '@lucide/svelte/icons/list';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';

	// Minimal rich-text body: contentEditable + execCommand (no dependency). Emits
	// HTML on input; the send path derives a text fallback. Pasted images embed
	// inline as data-URIs ("file upload as string"); the paperclip delegates to
	// the parent for real R2 attachments.
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

	// Set the initial HTML once — never reactively overwrite (would move the caret).
	onMount(() => {
		if (el && initial) el.innerHTML = initial;
	});

	function emit() {
		if (el) oninput?.(el.innerHTML);
	}
	function exec(cmd: string, val?: string) {
		document.execCommand(cmd, false, val);
		el?.focus();
		emit();
	}
	function link() {
		const url = prompt('Link URL');
		if (url) exec('createLink', url);
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
	<div class="text-muted-foreground flex items-center gap-0.5 border-b px-1 py-1">
		<Button variant="ghost" size="icon" class="size-7" title="Bold" onclick={() => exec('bold')}>
			<BoldIcon class="size-4" />
		</Button>
		<Button variant="ghost" size="icon" class="size-7" title="Italic" onclick={() => exec('italic')}>
			<ItalicIcon class="size-4" />
		</Button>
		<Button variant="ghost" size="icon" class="size-7" title="Bulleted list" onclick={() => exec('insertUnorderedList')}>
			<ListIcon class="size-4" />
		</Button>
		<Button variant="ghost" size="icon" class="size-7" title="Link" onclick={link}>
			<LinkIcon class="size-4" />
		</Button>
		{#if onattach}
			<Button variant="ghost" size="icon" class="ml-auto size-7" title="Attach file" onclick={onattach}>
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
		oninput={emit}
		onpaste={onPaste}
		{onkeydown}
		class="prose-sm min-h-[200px] max-w-none overflow-auto px-3 py-2 text-sm outline-none
			[&:empty]:before:text-muted-foreground [&:empty]:before:content-[attr(data-placeholder)]"
	></div>
</div>
