<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// The DESKTOP composer: Gmail-style docked window (bottom-right), minimize
	// bar, full-screen bigMode overlay, attachments rail, drag-drop, lightbox.
	// All compose behavior (draft lifecycle, autosave, mirror, attachments,
	// send/undo/discard) lives in ComposeSession — shared with the mobile
	// /app/compose page. Below `md` the layout routes compose to that page, so
	// this panel no longer carries drawer or iOS keyboard modes at all.
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { fmtSize, isImage } from '$lib/mail/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FromSelector from './from-selector.svelte';
	import RecipientInput from './recipient-input.svelte';
	import TiptapEditor from './tiptap-editor.svelte';
	import SchedulePicker from './schedule-picker.svelte';
	import SendIcon from '@lucide/svelte/icons/send';
	import { portal } from '$lib/client/portal';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FileArchiveIcon from '@lucide/svelte/icons/file-archive';
	import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
	import FileVideoIcon from '@lucide/svelte/icons/file-video';
	import FileAudioIcon from '@lucide/svelte/icons/file-audio';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import Minimize2Icon from '@lucide/svelte/icons/minimize-2';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import MailFrame from './mail-frame.svelte';
	import type { AttachmentRef } from '@doota/mail-core/drafts';
	import {
		ComposeSession,
		presetTomorrow,
		presetMonday,
		attachmentExt
	} from './compose-session.svelte.js';
	import type { ComposePrefill } from '$lib/client/compose.svelte.js';

	let {
		open = $bindable(false),
		prefill = undefined,
		resumeDraftId = undefined,
		// Pre-fill the schedule picker (epoch ms) — set when editing a scheduled send.
		scheduleAt: scheduleAtMs = undefined
	}: {
		open?: boolean;
		prefill?: ComposePrefill;
		resumeDraftId?: string;
		scheduleAt?: number;
	} = $props();

	// The layout remounts this panel per compose via {#key compose.nonce}, so the
	// entry props are fixed for the life of one session — reading their initial
	// values here is the intended semantic, not a lost-reactivity bug.
	/* svelte-ignore state_referenced_locally */
	const session = new ComposeSession({
		prefill,
		resumeDraftId,
		scheduleAtMs,
		requestClose: () => (open = false),
		requestReopen: () => (open = true)
	});
	onMount(() => void session.init());

	let minimized = $state(false);
	let maximized = $state(false);
	let fileInput = $state<HTMLInputElement>();
	// Full-screen centered overlay vs the docked bottom-right popup.
	const bigMode = $derived(maximized && !minimized);

	function onWindowKey(e: KeyboardEvent) {
		if (preview) {
			if (e.key === 'Escape') preview = null;
			return;
		}
		if (!open || minimized) return;
		session.handleSendShortcut(e);
	}

	function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		void session.uploadFiles(files);
	}

	// Drag-and-drop files anywhere on the composer uploads them as attachments.
	let dragging = $state(false);
	function onDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging = true;
	}
	function onDragLeave(e: DragEvent) {
		if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) dragging = false;
	}
	function onDrop(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging = false;
		void session.uploadFiles([...e.dataTransfer.files]);
	}

	// Click an attachment → images preview in a lightbox, everything else downloads.
	let preview = $state<AttachmentRef | null>(null);

	// Color-coded file-type tile (icon + tint) for non-image attachments.
	function fileMeta(attachment: AttachmentRef): { icon: typeof FileIcon; bg: string; fg: string } {
		const e = (attachment.filename.split('.').pop() ?? '').toLowerCase();
		const t = attachment.contentType;
		if (t.includes('pdf') || e === 'pdf')
			return { icon: FileTextIcon, bg: 'bg-destructive/10', fg: 'text-destructive' };
		if (['zip', 'rar', '7z', 'gz', 'tar'].includes(e))
			return { icon: FileArchiveIcon, bg: 'bg-p1/10', fg: 'text-p1' };
		if (['doc', 'docx'].includes(e))
			return { icon: FileTextIcon, bg: 'bg-brand/10', fg: 'text-brand' };
		if (['xls', 'xlsx', 'csv'].includes(e))
			return { icon: FileSpreadsheetIcon, bg: 'bg-ok/10', fg: 'text-ok' };
		if (['ppt', 'pptx'].includes(e))
			return { icon: FileTextIcon, bg: 'bg-warn/10', fg: 'text-warn' };
		if (t.startsWith('video/'))
			return { icon: FileVideoIcon, bg: 'bg-p3/10', fg: 'text-p3' };
		if (t.startsWith('audio/'))
			return { icon: FileAudioIcon, bg: 'bg-p2/10', fg: 'text-p2' };
		return { icon: FileIcon, bg: 'bg-muted', fg: 'text-muted-foreground' };
	}
	// Private, owner-only preview (streamed from R2 by the API) — never a public URL.
	const previewUrl = (attachment: AttachmentRef) =>
		session.draftId
			? `/api/drafts/attachments?draftId=${session.draftId}&key=${encodeURIComponent(attachment.r2Key)}`
			: '';
	function downloadAttachment(attachment: AttachmentRef) {
		const link = document.createElement('a');
		link.href = `${previewUrl(attachment)}&download=1`;
		link.download = attachment.filename;
		link.click();
	}
	function openAttachment(attachment: AttachmentRef) {
		if (isImage(attachment)) preview = attachment;
		else downloadAttachment(attachment);
	}
</script>

<svelte:window onkeydown={onWindowKey} />
<!-- Tab going hidden is the last reliable moment to reach the network, so flush
     immediately instead of waiting out the debounce (best-effort; the local
     mirror covers whatever doesn't make it). -->
<svelte:document
	onvisibilitychange={() => {
		if (open && document.visibilityState === 'hidden') void session.flushSave();
	}}
/>

<AlertDialog.Root bind:open={session.confirmNoSubject}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Send without a subject?</AlertDialog.Title>
			<AlertDialog.Description>This message has no subject line.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Add subject</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => session.send(true)}>Send anyway</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

{#if open}
	{#if bigMode}
		<!-- Dim the mail view behind; clicking it closes (keeps the draft). -->
		<button type="button" class="bg-scrim/30 absolute inset-0 z-20" aria-label="Close composer" onclick={session.close}></button>
	{/if}
	<!-- Docked, non-modal composer (Gmail-style) — or a full-screen centered overlay. -->
	<div class={bigMode ? 'absolute inset-0 z-30 flex p-2' : 'fixed inset-x-0 bottom-0 z-40 md:inset-x-auto md:right-6'}>
		<!-- One panel, two columns: an attachments rail that extends from the composer
		     (shared border/shadow, matched height) and slides in when files exist. -->
		<div
			class="bg-background flex items-stretch overflow-hidden border shadow-2xl {bigMode
				? 'h-full w-full rounded-xl'
				: !minimized
					? 'h-[min(80vh,34rem)] rounded-t-xl'
					: 'rounded-t-xl'}"
		>
			<!-- Expanded mode keeps the rail mounted even when empty, so the first
			     attachment doesn't reflow the editor column. -->
			{#if !minimized && (bigMode || session.attachments.length)}
				<aside
					transition:fade={{ duration: 120 }}
					class="bg-muted/20 hidden flex-col border-r md:flex {bigMode ? 'w-64' : 'w-48'}"
				>
					<!-- h-10 matches the composer header so both bottom borders align. -->
					<div class="text-muted-foreground flex h-10 shrink-0 items-center gap-1.5 border-b px-3 text-xs font-medium">
						<PaperclipIcon class="size-3.5" />
						{session.attachments.length ? `${session.attachments.length} attachment${session.attachments.length > 1 ? 's' : ''}` : 'Attachments'}
					</div>
					{#if !session.attachments.length}
						<!-- Empty state: same slot the tiles fill, doubles as a picker target. -->
						<button
							type="button"
							onclick={() => fileInput?.click()}
							class="text-muted-foreground hover:border-brand/40 hover:text-foreground focus-visible:ring-ring/50 m-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-xs transition-colors outline-none focus-visible:ring-2"
						>
							<PaperclipIcon class="size-5" />
							<span>Drop files here<br />or click to attach</span>
						</button>
					{/if}
					<div class="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto p-2 {session.attachments.length ? '' : 'hidden'}">
						{#each session.attachments as attachment (attachment.r2Key)}
							<div class="group bg-background relative overflow-hidden rounded-lg border shadow-sm">
								<button type="button" class="block w-full text-left" title={isImage(attachment) ? 'Preview' : 'Download'} onclick={() => openAttachment(attachment)}>
									{#if isImage(attachment)}
										<div class="bg-muted aspect-[4/3] w-full">
											<img src={previewUrl(attachment)} alt={attachment.filename} loading="lazy" class="size-full object-cover" />
										</div>
									{:else}
										{@const m = fileMeta(attachment)}
										{@const Icon = m.icon}
										<div class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 {m.bg}">
											<Icon class="size-6 {m.fg}" />
											<span class="text-[10px] font-semibold tracking-wide {m.fg}">{attachmentExt(attachment)}</span>
										</div>
									{/if}
									<div class="flex flex-col gap-0.5 p-2">
										<span class="truncate text-xs font-medium">{attachment.filename}</span>
										<span class="text-faint text-[10px] tabular-nums">{fmtSize(attachment.size)}</span>
									</div>
								</button>
								<button
									type="button"
									title="Download"
									class="bg-background/85 text-muted-foreground hover:text-foreground pointer-coarse:opacity-100 absolute top-1.5 right-9 grid size-6 place-items-center rounded-full border opacity-0 transition-opacity group-hover:opacity-100"
									onclick={() => downloadAttachment(attachment)}
								>
									<DownloadIcon class="size-3.5" />
								</button>
								<button
									type="button"
									title="Remove"
									class="bg-background/85 text-muted-foreground hover:text-destructive pointer-coarse:opacity-100 absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full border opacity-0 transition-opacity group-hover:opacity-100"
									onclick={() => session.removeAttachment(attachment.r2Key)}
								>
									<XIcon class="size-3.5" />
								</button>
							</div>
						{/each}
					</div>
				</aside>
			{/if}

			<div
				class="relative flex flex-col {bigMode ? 'min-w-0 flex-1' : 'w-full md:w-[min(94vw,30rem)]'}"
				role="group"
				ondragover={onDragOver}
				ondragleave={onDragLeave}
				ondrop={onDrop}
			>
				{#if dragging && !minimized}
					<div class="border-accent bg-background/85 pointer-events-none absolute inset-0 z-10 m-2 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed">
						<PaperclipIcon class="text-muted-foreground size-6" />
						<span class="text-sm font-medium">Drop files to attach</span>
					</div>
				{/if}
				<!-- Title bar: click to minimize/restore -->
				<div class="bg-muted/60 text-foreground flex h-10 items-center justify-between gap-2 border-b px-3">
					<button type="button" class="min-w-0 flex-1 text-left" onclick={() => (minimized = !minimized)}>
						<span class="font-heading truncate text-sm font-medium">{session.title}</span>
					</button>
					<div class="text-muted-foreground flex items-center gap-0.5">
						{#if !minimized}
							<button type="button" class="hover:bg-foreground/10 hover:text-foreground grid size-6 place-items-center rounded transition-colors" title={maximized ? 'Exit full screen' : 'Full screen'} onclick={() => (maximized = !maximized)}>
								{#if maximized}<Minimize2Icon class="size-3.5" />{:else}<Maximize2Icon class="size-3.5" />{/if}
							</button>
						{/if}
						<button type="button" class="hover:bg-foreground/10 hover:text-foreground grid size-6 place-items-center rounded transition-colors" title={minimized ? 'Expand' : 'Minimize'} onclick={() => (minimized = !minimized)}>
							{#if minimized}<ChevronUpIcon class="size-4" />{:else}<MinusIcon class="size-4" />{/if}
						</button>
						<button type="button" class="hover:bg-destructive/10 hover:text-destructive grid size-6 place-items-center rounded transition-colors" title="Close (keeps draft)" onclick={session.close}>
							<XIcon class="size-4" />
						</button>
					</div>
				</div>

				{#if minimized}
					<button type="button" class="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2 text-left" onclick={() => (minimized = false)}>
						<span class="truncate text-sm font-medium">{session.subject || 'New message'}</span>
						{#if session.recipientNames}
							<span class="text-muted-foreground truncate text-xs">· {session.recipientNames}</span>
						{/if}
						{#if session.attachments.length}
							<span class="text-faint ml-auto shrink-0 text-xs">
								{session.attachments.length} file{session.attachments.length > 1 ? 's' : ''}
							</span>
						{/if}
					</button>
				{/if}

				{#if !minimized}
					<!-- Body fills the fixed-height panel; the editor flexes so nothing
					     shifts. overflow-y-auto is the small-window escape valve. -->
					<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-3">
						<div class="flex shrink-0 flex-col gap-2">
							<div class="flex items-center gap-2">
								<span class="text-muted-foreground w-10 shrink-0 text-xs">From</span>
								<FromSelector identities={session.identities} bind:mailboxId={session.mailboxId} bind:aliasId={session.aliasId} />
							</div>
							<div class="flex items-start gap-2">
								<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">To</span>
								<div class="min-w-0 flex-1"><RecipientInput bind:value={session.to} onchange={session.scheduleSave} /></div>
								<div class="flex shrink-0 items-center gap-1.5 pt-2 text-xs font-medium">
									{#if !session.showCc}
										<button type="button" class="text-muted-foreground hover:text-brand" onclick={() => (session.showCc = true)}>Cc</button>
									{/if}
									{#if !session.showBcc}
										<button type="button" class="text-muted-foreground hover:text-brand" onclick={() => (session.showBcc = true)}>Bcc</button>
									{/if}
								</div>
							</div>
							{#if session.showCc}
								<div class="flex items-start gap-2">
									<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">Cc</span>
									<div class="min-w-0 flex-1"><RecipientInput bind:value={session.cc} onchange={session.scheduleSave} /></div>
									<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 pt-2" title="Remove Cc" onclick={() => { session.showCc = false; session.cc = []; session.scheduleSave(); }}>
										<XIcon class="size-3.5" />
									</button>
								</div>
							{/if}
							{#if session.showBcc}
								<div class="flex items-start gap-2">
									<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">Bcc</span>
									<div class="min-w-0 flex-1"><RecipientInput bind:value={session.bcc} onchange={session.scheduleSave} /></div>
									<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 pt-2" title="Remove Bcc" onclick={() => { session.showBcc = false; session.bcc = []; session.scheduleSave(); }}>
										<XIcon class="size-3.5" />
									</button>
								</div>
							{/if}
						</div>

						<Input
							class="h-8 shrink-0"
							placeholder="Subject"
							aria-label="Subject"
							bind:value={session.subject}
							oninput={session.scheduleSave}
							onblur={session.flushSave}
						/>

						<!-- min-h-36 is the typing-area floor: the editor still flexes to
						     fill spare height but can't be crushed to nothing; the body
						     scrolls instead (container above). -->
						<div class="min-h-36 flex-1 pb-2">
							{#key session.editorKey}
								<TiptapEditor
									fill
									focusStart
									initial={session.body}
									oninput={(html) => {
										session.body = html;
										session.scheduleSave();
									}}
									onattach={() => fileInput?.click()}
									onsend={() => session.send()}
								/>
							{/key}
						</div>

						{#if session.forwardMessageIds.length}
							<!-- Forwarded messages — read-only preview via the same sandboxed
							     renderer used to read mail, so the template shows as it'll
							     send. Composed for real (from R2) server-side at Send. -->
							<div class="mt-1 max-h-64 shrink-0 overflow-y-auto rounded-md border">
								<div class="text-muted-foreground bg-muted/40 sticky top-0 border-b px-2 py-1 text-xs">
									Forwarding {session.forwardMessageIds.length}
									{session.forwardMessageIds.length === 1 ? 'message' : 'messages'} · original formatting kept
								</div>
								<div class="flex flex-col gap-2 p-2">
									{#each session.forwardMessageIds as messageId (messageId)}
										<MailFrame src={`/api/messages/${messageId}/body`} collapse fadeClass="from-background" />
									{/each}
								</div>
							</div>
						{/if}
					</div>

					<div class="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
						<div class="flex items-center gap-1">
							<Button variant="ghost" size="icon" class="size-8 text-muted-foreground hover:text-destructive" title="Discard draft" onclick={session.discard}>
								<Trash2Icon class="size-4" />
							</Button>
							<SchedulePicker bind:value={session.scheduleAt} bind:open={session.schedulePickerOpen} />
							{#if session.uploading}
								<span class="text-muted-foreground text-xs">Uploading…</span>
							{:else if session.saved && session.draftId}
								<span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
									<CheckIcon class="text-ok size-3.5" /> Draft saved
								</span>
							{/if}
						</div>
						<!-- Split send: primary sends now (⌘↵); caret opens schedule presets. -->
						<div class="inline-flex">
							<Button variant="brand" size="sm" class="gap-1.5 rounded-r-none" disabled={!session.canSend || session.phase === 'sending'} title={session.sendHint} onclick={() => session.send()}>
								{#if session.phase === 'sending'}
									<Spinner class="size-4" /> Sending…
								{:else}
									<SendIcon class="size-4" /> {session.scheduleAt ? 'Schedule' : 'Send'}
								{/if}
							</Button>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="brand" size="sm" class="border-brand-foreground/25 rounded-l-none border-l px-1.5" disabled={!session.canSend || session.phase === 'sending'} title="Schedule send" aria-label="Schedule send">
											<ChevronDownIcon class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-56">
									<DropdownMenu.Label class="text-muted-foreground text-xs">Send later</DropdownMenu.Label>
									<DropdownMenu.Item onSelect={() => session.armSchedule(presetTomorrow())}>Tomorrow, 8:00 AM</DropdownMenu.Item>
									<DropdownMenu.Item onSelect={() => session.armSchedule(presetMonday())}>Monday, 8:00 AM</DropdownMenu.Item>
									<DropdownMenu.Item onSelect={() => (session.schedulePickerOpen = true)}>Pick date &amp; time…</DropdownMenu.Item>
									{#if session.scheduleAt}
										<DropdownMenu.Separator />
										<DropdownMenu.Item onSelect={session.clearSchedule}>Send now instead</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
					</div>
				{/if}
				<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
			</div>
		</div>
	</div>
{/if}

<!-- Image preview lightbox (Gmail-style): click backdrop or Esc to close. -->
{#if preview}
	<div use:portal class="bg-scrim/80 fixed inset-0 z-50 flex flex-col" role="dialog" aria-modal="true" aria-label="Attachment preview">
		<div class="flex items-center justify-between gap-3 px-4 py-3 text-white">
			<span class="truncate text-sm font-medium">{preview.filename}</span>
			<div class="flex items-center gap-1">
				<button type="button" class="grid size-9 place-items-center rounded-full hover:bg-white/15" title="Download" onclick={() => preview && downloadAttachment(preview)}>
					<DownloadIcon class="size-5" />
				</button>
				<button type="button" class="grid size-9 place-items-center rounded-full hover:bg-white/15" title="Close" onclick={() => (preview = null)}>
					<XIcon class="size-5" />
				</button>
			</div>
		</div>
		<button type="button" class="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center p-4" aria-label="Close preview" onclick={() => (preview = null)}>
			<img src={previewUrl(preview)} alt={preview.filename} class="max-h-full max-w-full object-contain" />
		</button>
	</div>
{/if}
