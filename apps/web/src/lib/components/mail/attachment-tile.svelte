<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Hallmark · component: attachment tile · genre: inherited (app system)
     states: default · hover · focus · active · loading (pdf render) · error (fallback icon)
     Visual preview for any attachment type: real pixels where the browser can
     (images, video first frame, PDF page 1 via lazy pdfjs), typed icon tile
     otherwise. Three voices: grid (WhatsApp media), row (WhatsApp document),
     strip (Gmail attachment card). -->
<script lang="ts">
	import { onMount } from 'svelte';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
	import FileArchiveIcon from '@lucide/svelte/icons/file-archive';
	import FileAudioIcon from '@lucide/svelte/icons/file-audio';
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import { Button } from '$lib/components/ui/button/index.js';
	import { pdfThumb } from '$lib/client/pdf-thumb';
	import { sanitizeFilename, splitExt } from '$lib/utils/filename';
	import { fmtSize } from '$lib/mail/format';
	import { openAttachment, downloadAttachment, tileVerdict, prefetchVerdict } from '$lib/client/attachment-gate.svelte';
	import { isViewable } from '$lib/client/attachment-viewable';

	type Att = { id: string; filename: string | null; contentType: string | null; size: number | null };
	let {
		att,
		variant,
		tone = 'default'
	}: {
		att: Att;
		variant: 'grid' | 'row' | 'strip';
		/** inverse = inside the dark outbound bubble */
		tone?: 'default' | 'inverse';
	} = $props();


	const href = $derived(`/api/attachments/${att.id}`);
	const ct = $derived(att.contentType ?? '');
	const kind = $derived(
		ct.startsWith('image/') ? 'image'
		: ct.startsWith('video/') ? 'video'
		: ct === 'application/pdf' ? 'pdf'
		: ct.startsWith('audio/') ? 'audio'
		: 'file'
	);

	const EXT_ICON: Record<string, typeof FileIcon> = {
		pdf: FileTextIcon,
		doc: FileTextIcon, docx: FileTextIcon, txt: FileTextIcon, rtf: FileTextIcon,
		xls: FileSpreadsheetIcon, xlsx: FileSpreadsheetIcon, csv: FileSpreadsheetIcon,
		zip: FileArchiveIcon, rar: FileArchiveIcon, gz: FileArchiveIcon, tar: FileArchiveIcon, '7z': FileArchiveIcon,
		mp3: FileAudioIcon, wav: FileAudioIcon, m4a: FileAudioIcon, ogg: FileAudioIcon,
		js: FileCodeIcon, ts: FileCodeIcon, json: FileCodeIcon, html: FileCodeIcon, css: FileCodeIcon, py: FileCodeIcon
	};
	const rawExt = $derived((att.filename?.includes('.') ? att.filename.split('.').pop()! : '').toLowerCase());
	// Friendly type label — the file extension when we have one, else a MIME map,
	// else a short subtype. (Slicing "text/calendar" → "CALEN" was the old bug.)
	const MIME_LABEL: Record<string, string> = {
		'application/pdf': 'PDF',
		'text/calendar': 'ICS', 'application/ics': 'ICS',
		'text/plain': 'TXT', 'text/html': 'HTML', 'application/json': 'JSON',
		'application/zip': 'ZIP', 'application/x-zip-compressed': 'ZIP',
		'application/msword': 'DOC',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
		'application/vnd.ms-excel': 'XLS',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
		'application/vnd.ms-powerpoint': 'PPT',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX'
	};
	const ext = $derived(
		(
			rawExt.toUpperCase() ||
			MIME_LABEL[ct] ||
			(ct.startsWith('image/') ? 'IMG' : ct.split('/')[1] || 'file').toUpperCase()
		).slice(0, 5)
	);
	const Icon = $derived(kind === 'audio' ? FileAudioIcon : (EXT_ICON[rawExt] ?? FileIcon));

	const name = $derived(sanitizeFilename(att.filename)); // strip bidi-override spoofing
	// Middle-truncation parts: the extension stays visible when the name clips.
	const nameParts = $derived(splitExt(name));

	// PDF page-1 thumb — lazy client render; rows keep the icon (cheap).
	let pdfUrl = $state<string | null>(null);
	let pdfLoading = $state(false);
	// Broken image/video sources fall back to the typed tile.
	let broken = $state(false);

	// Click → scan → then act. Every click routes through the gate: it scans, then
	// for a viewable type (image/text/pdf/svg) opens the in-house sandboxed viewer,
	// otherwise downloads. A clean verdict proceeds straight through; matched/
	// skipped/error fail open behind a confirm. The viewer never opens without a
	// verdict. The <a download> stays the real fallback so JS-off / middle-click
	// still work; we only intercept the primary click to interpose the check.
	const verdict = $derived(tileVerdict(att.id));
	// The tile's signifiers (title, corner badge) must promise the action the
	// primary click actually takes: preview for viewable types, download else.
	const viewable = $derived(isViewable(att.contentType, att.filename));
	const actionLabel = $derived(viewable ? 'Preview' : 'Download');
	// Scan-in-flight: the click already registered — show progress at the cursor
	// (the gate swallows re-entrant clicks meanwhile).
	const checking = $derived(verdict === 'checking');
	function onTileClick(e: MouseEvent) {
		e.preventDefault();
		void openAttachment(att, () => triggerDownload());
	}
	// Explicit per-tile download (the tile's primary click previews viewable
	// types) — same scan gate, never opens the viewer.
	function onDownloadClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		void downloadAttachment(att, () => triggerDownload());
	}
	function triggerDownload() {
		const anchor = document.createElement('a');
		anchor.href = href;
		anchor.download = name;
		anchor.rel = 'noopener';
		anchor.click();
	}
	onMount(() => {
		// Eager check: start the threat analysis when the tile appears (mail
		// opened), so the verdict is usually in before the user clicks.
		prefetchVerdict(att.id, att.size);
	});
	// PDF page-1 thumb only after a clean verdict: the thumb parses the PDF with
	// pdfjs in the app context (no sandbox) — exactly the surface the viewer
	// isolates. Unscanned/matched/skipped PDFs keep the typed icon tile.
	$effect(() => {
		if (verdict === 'clean' && kind === 'pdf' && variant !== 'row' && !pdfUrl && !pdfLoading) {
			pdfLoading = true;
			void pdfThumb(att.id).then((u) => {
				pdfUrl = u;
				pdfLoading = false;
			});
		}
	});

	const rowTone = $derived(
		tone === 'inverse'
			? 'bg-background/15 hover:bg-background/25 text-background'
			: 'bg-muted hover:bg-accent border'
	);
</script>

<!-- Advisory verdict indicator. Copy avoids "safe"/"virus-free": clean
     means "checked against known threat patterns", nothing more. -->
{#snippet verdictBadge()}
	{#if verdict === 'checking'}
		<span class="text-faint inline-flex items-center gap-1 text-[11px]" role="status" title="Checking…">
			<span class="border-muted-foreground/40 border-t-muted-foreground size-2.5 animate-spin rounded-full border motion-reduce:animate-none"></span>
			<span class="sr-only">Checking file</span>
		</span>
	{:else if verdict === 'clean'}
		<span class="text-muted-foreground inline-flex items-center gap-0.5 text-[11px]" title="Checked against known threat patterns">
			<CheckIcon class="size-3" /> Checked
		</span>
	{:else if verdict === 'matched'}
		<span class="text-destructive inline-flex items-center gap-0.5 text-[11px]" title="A threat was found in this file">
			<ShieldAlertIcon class="size-3" /> Threat found
		</span>
	{:else if verdict === 'skipped' || verdict === 'error'}
		<span class="text-warn inline-flex items-center gap-0.5 text-[11px]" title="Couldn't check against known threat patterns">
			<ShieldQuestionIcon class="size-3" /> Couldn't check
		</span>
	{/if}
{/snippet}

{#snippet iconFace(cls: string)}
	<span class="grid h-full w-full place-items-center {cls}">
		<span class="flex flex-col items-center gap-1">
			<Icon class="text-muted-foreground size-6" />
			<span class="text-faint font-mono text-[9px] font-semibold tracking-wide">{ext}</span>
		</span>
	</span>
{/snippet}

{#snippet previewFace()}
	{#if kind === 'image' && !broken}
		<img src={href} alt={name} loading="lazy" class="h-full w-full object-cover" onerror={() => (broken = true)} />
	{:else if kind === 'video' && !broken}
		<!-- preload=metadata paints the first frame — the file's own thumbnail. -->
		<video src={href} preload="metadata" muted playsinline tabindex="-1" class="pointer-events-none h-full w-full object-cover" onerror={() => (broken = true)}></video>
	{:else if kind === 'pdf' && pdfUrl}
		<img src={pdfUrl} alt={name} class="h-full w-full bg-white object-cover object-top" />
	{:else if kind === 'pdf' && pdfLoading}
		<span class="bg-muted h-full w-full animate-pulse motion-reduce:animate-none"></span>
	{:else}
		{@render iconFace('bg-muted')}
	{/if}
{/snippet}

{#if variant === 'row'}
	<!-- Wrapper so the explicit download control is a real sibling BUTTON, not an
	     interactive element nested inside the anchor (invalid + unreachable). -->
	<div class="relative">
		<a
			{href}
			download={name}
			target="_blank"
			rel="noopener"
			title="{actionLabel} {name}"
			onclick={onTileClick}
			aria-busy={checking}
			class="focus-visible:ring-ring/50 pointer-coarse:py-2.5 flex items-center gap-2 rounded-lg py-1.5 pr-10 pl-2 transition-colors outline-none focus-visible:ring-2 active:scale-[0.99] {rowTone} {checking ? 'cursor-progress opacity-70' : ''}"
		>
			<span class="{tone === 'inverse' ? 'bg-background/20' : 'bg-card border'} grid size-9 shrink-0 place-items-center overflow-hidden rounded-md">
				{#if kind === 'image' && !broken}
					<img src={href} alt="" loading="lazy" class="h-full w-full object-cover" onerror={() => (broken = true)} />
				{:else}
					<Icon class="{tone === 'inverse' ? 'text-background/80' : 'text-muted-foreground'} size-4" />
				{/if}
			</span>
			<span class="min-w-0 flex-1">
				<span class="flex min-w-0 text-xs font-medium">
					<span class="truncate">{nameParts.base}</span><span class="shrink-0">{nameParts.ext}</span>
				</span>
				<span class="{tone === 'inverse' ? 'text-background/70' : 'text-faint'} flex items-center gap-1.5 text-[10px]">
					<span>{ext}{att.size != null ? ` · ${fmtSize(att.size)}` : ''}</span>
					{@render verdictBadge()}
				</span>
			</span>
		</a>
		<Button
			variant="ghost"
			size="icon-sm"
			title="Download {name}"
			aria-label="Download {name}"
			onclick={onDownloadClick}
			class="{tone === 'inverse'
				? 'text-background/80 hover:bg-background/20 hover:text-background'
				: 'text-muted-foreground'} pointer-coarse:size-11 absolute top-1/2 right-1 -translate-y-1/2"
		>
			<DownloadIcon class="size-3.5" />
		</Button>
	</div>
{:else if variant === 'grid'}
	<div class="relative">
		<a
			{href}
			download={name}
			target="_blank"
			rel="noopener"
			title="{actionLabel} {name}"
			onclick={onTileClick}
			aria-busy={checking}
			class="focus-visible:ring-ring/50 bg-muted group/att relative block aspect-[4/3] overflow-hidden rounded-lg border outline-none focus-visible:ring-2 active:scale-[0.99] {checking ? 'cursor-progress opacity-70' : ''}"
		>
			{@render previewFace()}
			{#if verdict}
				<span class="bg-scrim/70 pointer-events-none absolute top-1 left-1 rounded-full px-1.5 py-0.5 text-white">
					{@render verdictBadge()}
				</span>
			{/if}
			<!-- name scrim, WhatsApp-style: only over real pixels -->
			{#if (kind === 'image' || kind === 'video' || (kind === 'pdf' && pdfUrl)) && !broken}
				<span class="from-scrim/60 pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t to-transparent px-2 pt-4 pb-1">
					<span class="block truncate text-[10px] font-medium text-white">{name}</span>
				</span>
			{/if}
		</a>
		<!-- explicit download; the tile itself previews viewable types -->
		<Button
			variant="ghost"
			size="icon-sm"
			title="Download {name}"
			aria-label="Download {name}"
			onclick={onDownloadClick}
			class="bg-scrim/55 hover:bg-scrim/75 pointer-coarse:size-11 absolute top-1 right-1 text-white hover:text-white"
		>
			<DownloadIcon class="size-3.5" />
		</Button>
	</div>
{:else}
	<!-- strip: Gmail attachment card -->
	<div class="relative w-36 shrink-0">
		<a
			{href}
			download={name}
			target="_blank"
			rel="noopener"
			title="{actionLabel} {name}"
			onclick={onTileClick}
			aria-busy={checking}
			class="focus-visible:ring-ring/50 bg-card hover:bg-muted/60 block w-full overflow-hidden rounded-lg border transition-colors outline-none focus-visible:ring-2 active:scale-[0.99] {checking ? 'cursor-progress opacity-70' : ''}"
		>
			<span class="bg-muted relative block h-20 w-full overflow-hidden border-b">
				{@render previewFace()}
			</span>
			<span class="block px-2 py-1.5">
				<span class="flex min-w-0 text-[11px] font-medium">
					<span class="truncate">{nameParts.base}</span><span class="shrink-0">{nameParts.ext}</span>
				</span>
				<span class="text-faint flex items-center gap-1.5 text-[10px]">
					<span>{ext}{att.size != null ? ` · ${fmtSize(att.size)}` : ''}</span>
					{@render verdictBadge()}
				</span>
			</span>
		</a>
		<!-- explicit download; the card itself previews viewable types -->
		<Button
			variant="ghost"
			size="icon-sm"
			title="Download {name}"
			aria-label="Download {name}"
			onclick={onDownloadClick}
			class="bg-scrim/55 hover:bg-scrim/75 pointer-coarse:size-11 absolute top-1 right-1 text-white hover:text-white"
		>
			<DownloadIcon class="size-3.5" />
		</Button>
	</div>
{/if}
