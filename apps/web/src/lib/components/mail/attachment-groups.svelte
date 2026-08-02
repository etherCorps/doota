<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// The thread attachments panel body — every file in the open thread grouped by
	// day, each row a download link with an image thumb or a type-tinted icon.
	// Shared by the docked aside (≥ md) and the mobile drawer. Pure display: the
	// only page dependency is the jump-to-message callback.
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import type { MessageDTO } from '@doota/mail-core/mail-thread-contract';
	import { senderName, senderEmail, fmtTime, isImage, fileExt, fmtSize } from '$lib/mail/format';

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
						<a
							href={resolve('/api/attachments/[id]', { id: att.id })}
							download={att.filename ?? 'file'}
							class="group hover:bg-muted/60 focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-lg p-1 transition-colors outline-none focus-visible:ring-2"
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
								<span class="text-faint block text-[11px]">{fileExt(att.filename)}{att.size != null ? ` · ${fmtSize(att.size)}` : ''}</span>
							</span>
							<DownloadIcon class="text-muted-foreground pointer-coarse:opacity-100 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
						</a>
					{/each}
				</div>
			</div>
		{/each}
	</div>
{/each}
