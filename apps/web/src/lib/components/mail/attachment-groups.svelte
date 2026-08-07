<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// The thread attachments panel body — every file in the open thread grouped by
	// day, each row a download link with an image thumb or a type-tinted icon.
	// Shared by the docked aside (≥ md) and the mobile drawer. Pure display: the
	// only page dependency is the jump-to-message callback.
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldQuestionIcon from '@lucide/svelte/icons/shield-question';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { MessageDTO } from '@doota/mail-core/mail-thread-contract';
	import { senderName, senderEmail, fmtTime, isImage, fileExt, fmtSize } from '$lib/mail/format';
	import { openAttachment, downloadAttachment, tileVerdict, prefetchVerdict } from '$lib/client/attachment-gate.svelte';

	type Group = { day: string; entries: { msg: MessageDTO; atts: MessageDTO['attachments'] }[] };

	let {
		groups,
		msgs,
		onJump
	}: {
		groups: Group[];
		msgs: MessageDTO[];
		/** Jump to a message in the conversation (id + whether it's the newest). */
		onJump: (id: string, isLast: boolean) => void;
	} = $props();

	// Eager check: kick the threat analysis for every listed attachment when the
	// panel shows, so verdicts are usually in before a click (dedupes in the gate).
	// untrack: prefetch reads the verdict map — tracking it would re-run this
	// effect on every verdict update for nothing.
	$effect(() => {
		const all = groups.flatMap((group) => group.entries.flatMap((entry) => entry.atts));
		untrack(() => {
			for (const att of all) prefetchVerdict(att.id);
		});
	});

	// Click → scan → then act. Same gate as the tile: viewable types open the
	// sandboxed viewer after the verdict, everything else downloads; clean goes
	// straight through, matched/skipped/error fail OPEN behind a confirm.
	function triggerDownload(att: { id: string; filename: string | null }) {
		const anchor = document.createElement('a');
		anchor.href = resolve('/api/attachments/[id]', { id: att.id });
		anchor.download = att.filename ?? 'file';
		anchor.rel = 'noopener';
		anchor.click();
	}
	function onOpen(e: MouseEvent, att: { id: string; filename: string | null; contentType: string | null }) {
		e.preventDefault();
		void openAttachment(att, () => triggerDownload(att));
	}
	// Explicit download from the list — same gate, never opens the viewer.
	function onDownload(e: MouseEvent, att: { id: string; filename: string | null }) {
		e.preventDefault();
		e.stopPropagation();
		void downloadAttachment(att, () => triggerDownload(att));
	}

	// Type-tinted icon tile for non-image files (PDF reads red, archives amber, …).
	function fileTile(att: { contentType: string | null }) {
		const t = att.contentType ?? '';
		if (t === 'application/pdf') return { icon: FileTextIcon, cls: 'bg-destructive/10 text-destructive' };
		if (t.includes('zip') || t.includes('compressed') || t.includes('tar')) return { icon: ArchiveIcon, cls: 'bg-warn/10 text-warn' };
		if (t.startsWith('audio/')) return { icon: PaperclipIcon, cls: 'bg-p1/10 text-p1' };
		if (t.startsWith('video/')) return { icon: PaperclipIcon, cls: 'bg-p3/10 text-p3' };
		if (t.startsWith('text/') || t.includes('word') || t.includes('document') || t.includes('sheet')) return { icon: FileTextIcon, cls: 'bg-brand/10 text-brand' };
		return { icon: PaperclipIcon, cls: 'bg-muted text-muted-foreground' };
	}
</script>

{#if groups.length === 0}
	<p class="text-muted-foreground py-6 text-center text-sm">No attachments in this thread.</p>
{/if}
{#each groups as group (group.day)}
	<p class="text-faint px-1 pt-2 pb-1.5 text-[11px] font-medium first:pt-0">{group.day}</p>
	<div class="space-y-2">
		{#each group.entries as { msg, atts } (msg.id)}
			<div class="bg-background/60 rounded-xl border p-2">
				<!-- Sender header (once per message) → jump to the message -->
				<button
					type="button"
					title="Show in conversation"
					onclick={() => onJump(msg.id, msg.id === msgs.at(-1)?.id)}
					class="hover:text-brand focus-visible:ring-ring/50 mb-1.5 flex w-full items-baseline gap-1.5 rounded text-left outline-none focus-visible:ring-2"
				>
					<span class="text-foreground text-xs font-semibold">{msg.submission ? 'You' : senderName(msg.from)}</span>
					<span class="text-faint min-w-0 flex-1 truncate font-mono text-[10px]">{senderEmail(msg.from)}</span>
					<span class="text-faint shrink-0 text-[10px]">{fmtTime(msg.sentAt)}</span>
				</button>
				<!-- One row per file — thumb (image preview / type icon), name + size always
				     visible. Click downloads. -->
				<div class="space-y-1">
					{#each atts as att (att.id)}
						{@const tile = fileTile(att)}
						{@const verdict = tileVerdict(att.id)}
						<div class="group relative">
						<a
							href={resolve('/api/attachments/[id]', { id: att.id })}
							download={att.filename ?? 'file'}
							onclick={(e) => onOpen(e, att)}
							aria-busy={verdict === 'checking'}
							class="hover:bg-muted/60 focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-lg p-1 pr-10 transition-colors outline-none focus-visible:ring-2 {verdict === 'checking' ? 'cursor-progress opacity-70' : ''}"
						>
							<span class="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border {isImage(att) ? 'bg-muted' : tile.cls}">
								{#if isImage(att)}
									<img src={resolve('/api/attachments/[id]', { id: att.id })} alt={att.filename ?? 'attachment'} loading="lazy" class="h-full w-full object-cover" />
								{:else}
									<tile.icon class="size-4" />
								{/if}
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-medium">{att.filename ?? 'file'}</span>
								<span class="text-faint flex items-center gap-1.5 text-[11px]">
									<span>{fileExt(att.filename)}{att.size != null ? ` · ${fmtSize(att.size)}` : ''}</span>
									{#if verdict === 'checking'}
										<span role="status" title="Checking…" class="inline-flex items-center">
											<span class="border-muted-foreground/40 border-t-muted-foreground size-2.5 animate-spin rounded-full border motion-reduce:animate-none"></span>
											<span class="sr-only">Checking file</span>
										</span>
									{:else if verdict === 'clean'}
										<span class="text-muted-foreground inline-flex items-center gap-0.5" title="Checked against known threat patterns"><CheckIcon class="size-3" /> Checked</span>
									{:else if verdict === 'matched'}
										<span class="text-destructive inline-flex items-center gap-0.5" title="A threat was found in this file"><ShieldAlertIcon class="size-3" /> Threat found</span>
									{:else if verdict === 'skipped' || verdict === 'error'}
										<span class="text-warn inline-flex items-center gap-0.5" title="Couldn't check against known threat patterns"><ShieldQuestionIcon class="size-3" /> Couldn't check</span>
									{/if}
								</span>
							</span>
						</a>
						<!-- explicit download; the row itself previews viewable types -->
						<Button
							variant="ghost"
							size="icon-sm"
							title="Download {att.filename ?? 'file'}"
							aria-label="Download {att.filename ?? 'file'}"
							onclick={(e) => onDownload(e, att)}
							class="text-muted-foreground pointer-coarse:size-11 pointer-coarse:opacity-100 absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
						>
							<DownloadIcon class="size-3.5" />
						</Button>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
{/each}
