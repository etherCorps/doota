<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FromSelector from './from-selector.svelte';
	import RecipientInput from './recipient-input.svelte';
	import TiptapEditor from './tiptap-editor.svelte';
	import SchedulePicker from './schedule-picker.svelte';
	import { toLocalDatetime } from '$lib/utils/parse-when';
	import SendIcon from '@lucide/svelte/icons/send';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
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
	import {
		sendIdentities,
		startDraft,
		autosaveDraft,
		sendDraftById,
		discardDraftById,
		undoDraftById,
		detachDraftAttachment,
		draftById
	} from '$lib/rpc/draft.remote';
	import type { SendIdentity } from '@doota/mail-core/identities';
	import type { AttachmentRef } from '@doota/mail-core/drafts';

	type Prefill = {
		kind?: 'new' | 'forward';
		mailboxId?: string;
		fromAliasId?: string | null;
		threadId?: string | null;
		inReplyToMessageId?: string | null;
		to?: string;
		subject?: string;
		body?: string;
	};
	let {
		open = $bindable(false),
		prefill = undefined,
		resumeDraftId = undefined
	}: { open?: boolean; prefill?: Prefill; resumeDraftId?: string } = $props();

	const UNDO_SECONDS = 10;
	const title = $derived(
		resumeDraftId ? 'Draft' : prefill?.kind === 'forward' ? 'Forward' : 'New message'
	);

	let scheduleAt = $state('');
	let schedulePickerOpen = $state(false);

	let identities = $state<SendIdentity[]>([]);
	let mailboxId = $state<string | undefined>(undefined);
	let aliasId = $state<string | null | undefined>(undefined);

	let to = $state<string[]>([]);
	let cc = $state<string[]>([]);
	let bcc = $state<string[]>([]);
	let showCc = $state(false);
	let showBcc = $state(false);
	let subject = $state('');
	let body = $state('');
	let attachments = $state<AttachmentRef[]>([]);
	let editorKey = $state(0);
	let minimized = $state(false);
	let maximized = $state(false);
	let fileInput = $state<HTMLInputElement>();

	let draftId = $state<string | null>(null);
	let clientRevision = $state(0);
	let phase = $state<'editing' | 'sending' | 'sent'>('editing');
	// Full-screen centered overlay vs the docked bottom-right popup.
	const bigMode = $derived(maximized && !minimized && phase !== 'sent');
	let sentSubmissionId = $state<string | null>(null);
	let undoLeft = $state(0);
	let uploading = $state(false);
	let saved = $state(false);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let undoTimer: ReturnType<typeof setInterval> | undefined;

	onMount(async () => {
		identities = await sendIdentities();
		if (resumeDraftId) {
			const d = await draftById({ draftId: resumeDraftId });
			draftId = d.id;
			clientRevision = d.clientRevision;
			mailboxId = d.mailboxId;
			aliasId = d.fromAliasId;
			to = d.to;
			cc = d.cc;
			bcc = d.bcc;
			subject = d.subject ?? '';
			body = d.body ?? '';
			attachments = d.attachments;
			showCc = d.cc.length > 0;
			showBcc = d.bcc.length > 0;
			editorKey++;
			return;
		}
		if (prefill) {
			to = prefill.to ? [prefill.to.toLowerCase()] : [];
			subject = prefill.subject ?? '';
			body = prefill.body ?? '';
		}
		const chosen =
			(prefill?.mailboxId &&
				identities.find(
					(i) => i.mailboxId === prefill.mailboxId && (i.aliasId ?? null) === (prefill.fromAliasId ?? null)
				)) ||
			identities.find((i) => i.available);
		if (chosen) {
			mailboxId = chosen.mailboxId;
			aliasId = chosen.aliasId;
		}
	});

	const canSend = $derived(phase === 'editing' && !!mailboxId && to.length + cc.length + bcc.length > 0);
	// Why the primary action is blocked — surfaced as the button's title so a
	// disabled Send explains itself instead of just greying out.
	const sendHint = $derived(
		!mailboxId
			? 'Choose a sender first'
			: to.length + cc.length + bcc.length === 0
				? 'Add at least one recipient'
				: scheduleAt
					? 'Schedule send'
					: 'Send  (⌘↵)'
	);

	// Schedule-send presets. Arming one fills the datetime input (reviewable) and
	// flips the primary button to “Schedule” — it does NOT fire immediately.
	function armSchedule(d: Date) {
		scheduleAt = toLocalDatetime(d);
	}
	function presetTomorrow(): Date {
		const d = new Date();
		d.setDate(d.getDate() + 1);
		d.setHours(8, 0, 0, 0);
		return d;
	}
	function presetMonday(): Date {
		const d = new Date();
		const add = ((1 - d.getDay() + 7) % 7) || 7; // next Monday (never today)
		d.setDate(d.getDate() + add);
		d.setHours(8, 0, 0, 0);
		return d;
	}
	function clearSchedule() {
		scheduleAt = '';
	}

	// ⌘/Ctrl+Enter sends from anywhere in the composer (the editor handles it only
	// while focused; this covers the To / subject fields too). Esc stays owned by
	// the image-preview lightbox.
	function onWindowKey(e: KeyboardEvent) {
		if (preview) {
			if (e.key === 'Escape') preview = null;
			return;
		}
		if (!open || minimized || phase !== 'editing') return;
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
			e.preventDefault();
			send();
		}
	}

	function scheduleSave() {
		if (phase !== 'editing') return;
		saved = false;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(flushSave, 800);
	}

	async function ensureDraft(): Promise<string | null> {
		if (draftId || !mailboxId) return draftId;
		const d = await startDraft({
			mailboxId,
			kind: prefill?.kind === 'forward' ? 'forward' : 'new',
			threadId: prefill?.threadId ?? null,
			inReplyToMessageId: prefill?.inReplyToMessageId ?? null,
			to,
			cc,
			bcc,
			subject,
			body,
			fromAliasId: aliasId ?? null
		});
		draftId = d.id;
		clientRevision = d.clientRevision;
		return draftId;
	}

	async function flushSave() {
		clearTimeout(saveTimer);
		if (phase !== 'editing' || !mailboxId) return;
		if (!draftId) {
			await ensureDraft();
			return;
		}
		const res = await autosaveDraft({
			draftId,
			clientRevision,
			to,
			cc,
			bcc,
			subject,
			body,
			fromAliasId: aliasId ?? null
		});
		if (res.ok) {
			clientRevision = res.clientRevision;
			saved = true;
		} else {
			const d = res.draft;
			clientRevision = d.clientRevision;
			to = d.to;
			cc = d.cc;
			bcc = d.bcc;
			subject = d.subject ?? '';
			body = d.body ?? '';
			editorKey++;
		}
	}

	async function uploadFiles(files: File[]) {
		if (!files.length) return;
		const id = await ensureDraft();
		if (!id) return;
		uploading = true;
		try {
			for (const file of files) {
				const fd = new FormData();
				fd.append('draftId', id);
				fd.append('file', file);
				const res = await fetch('/api/drafts/attachments', { method: 'POST', body: fd });
				if (res.ok) attachments = ((await res.json()) as { attachments: AttachmentRef[] }).attachments;
			}
		} finally {
			uploading = false;
		}
	}
	function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		uploadFiles(files);
	}

	// Drag-and-drop files anywhere on the composer → upload as attachments.
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
		uploadFiles([...e.dataTransfer.files]);
	}

	async function removeAttachment(r2Key: string) {
		if (!draftId) return;
		const res = await detachDraftAttachment({ draftId, r2Key });
		attachments = res.attachments;
	}

	async function send() {
		if (!canSend) return;
		phase = 'sending';
		await flushSave();
		if (!draftId) {
			phase = 'editing';
			return;
		}
		const sendAt = scheduleAt ? new Date(scheduleAt).getTime() : null;
		const res = await sendDraftById({ draftId, sendAt, undoSeconds: UNDO_SECONDS });
		if (sendAt && sendAt > Date.now() + UNDO_SECONDS * 1000) {
			reset();
			open = false;
			return;
		}
		sentSubmissionId = res.submissionId;
		phase = 'sent';
		minimized = false;
		undoLeft = UNDO_SECONDS;
		undoTimer = setInterval(() => {
			undoLeft -= 1;
			if (undoLeft <= 0) finishSent();
		}, 1000);
	}

	function finishSent() {
		clearInterval(undoTimer);
		reset();
		open = false;
	}

	async function undo() {
		if (!sentSubmissionId) return;
		clearInterval(undoTimer);
		const res = await undoDraftById({ submissionId: sentSubmissionId });
		if (res.restored && res.draft) {
			const d = res.draft;
			draftId = d.id;
			clientRevision = d.clientRevision;
			mailboxId = d.mailboxId;
			aliasId = d.fromAliasId;
			to = d.to;
			cc = d.cc;
			bcc = d.bcc;
			subject = d.subject ?? '';
			body = d.body ?? '';
			attachments = d.attachments;
			editorKey++;
			phase = 'editing';
			sentSubmissionId = null;
		} else {
			finishSent();
		}
	}

	// Esc / X / overlay: close but KEEP the draft (autosaved — find it in Drafts).
	async function close() {
		clearTimeout(saveTimer);
		await flushSave();
		open = false;
	}

	async function discard() {
		clearTimeout(saveTimer);
		if (draftId) await discardDraftById({ draftId });
		reset();
		open = false;
	}

	function reset() {
		draftId = null;
		clientRevision = 0;
		phase = 'editing';
		sentSubmissionId = null;
		to = [];
		cc = [];
		bcc = [];
		subject = '';
		body = '';
		attachments = [];
		showCc = false;
		showBcc = false;
		minimized = false;
		maximized = false;
		saved = false;
		scheduleAt = '';
		schedulePickerOpen = false;
		editorKey++;
	}

	const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
	// Click an attachment → images preview in a lightbox, everything else downloads.
	let preview = $state<AttachmentRef | null>(null);
	const isImage = (a: AttachmentRef) => a.contentType.startsWith('image/');
	const ext = (a: AttachmentRef) => (a.filename.split('.').pop() ?? 'file').toUpperCase().slice(0, 4);

	// Color-coded file-type tile (icon + tint) for non-image attachments.
	function fileMeta(a: AttachmentRef): { icon: typeof FileIcon; bg: string; fg: string } {
		const e = (a.filename.split('.').pop() ?? '').toLowerCase();
		const t = a.contentType;
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
	const previewUrl = (a: AttachmentRef) =>
		draftId ? `/api/drafts/attachments?draftId=${draftId}&key=${encodeURIComponent(a.r2Key)}` : '';
	function downloadAttachment(a: AttachmentRef) {
		const link = document.createElement('a');
		link.href = `${previewUrl(a)}&download=1`;
		link.download = a.filename;
		link.click();
	}
	function openAttachment(a: AttachmentRef) {
		if (isImage(a)) preview = a;
		else downloadAttachment(a);
	}

	// Compact recipient names for the minimized bar.
	const recipientNames = $derived(
		[...to, ...cc, ...bcc].map((a) => a.split('@')[0]).join(', ')
	);
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- Docked, non-modal composer (Gmail-style) — or a full-screen centered overlay. -->
{#if open}
	{#if bigMode}
		<!-- Dim the mail view behind; clicking it closes (keeps the draft). -->
		<button type="button" class="bg-scrim/30 absolute inset-0 z-20" aria-label="Close composer" onclick={close}></button>
	{/if}
	<!-- Small mode: full-width bottom sheet on phones, floating window ≥ md. -->
	<div class={bigMode ? 'absolute inset-0 z-30 flex p-2' : 'fixed inset-x-0 bottom-0 z-40 md:inset-x-auto md:right-6'}>
		<!-- One panel, two columns: an attachments rail that extends from the composer
		     (shared border/shadow, matched height) and slides in when files exist. -->
		<div
			class="bg-background flex items-stretch overflow-hidden border shadow-2xl {bigMode
				? 'h-full w-full rounded-xl'
				: !minimized && phase !== 'sent'
					? 'h-[min(80vh,34rem)] rounded-t-xl'
					: 'rounded-t-xl'}"
		>
			<!-- Expanded mode keeps the rail mounted even when empty, so the first
			     attachment doesn't reflow the editor column. -->
			{#if !minimized && phase !== 'sent' && (bigMode || attachments.length)}
				<aside
					transition:fade={{ duration: 120 }}
					class="bg-muted/20 hidden flex-col border-r md:flex {bigMode ? 'w-64' : 'w-48'}"
				>
					<!-- h-10 matches the composer header so both bottom borders align. -->
					<div class="text-muted-foreground flex h-10 shrink-0 items-center gap-1.5 border-b px-3 text-xs font-medium">
						<PaperclipIcon class="size-3.5" />
						{attachments.length ? `${attachments.length} attachment${attachments.length > 1 ? 's' : ''}` : 'Attachments'}
					</div>
					{#if !attachments.length}
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
					<div class="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto p-2 {attachments.length ? '' : 'hidden'}">
						{#each attachments as a (a.r2Key)}
							<div class="group bg-background relative overflow-hidden rounded-lg border shadow-sm">
								<button type="button" class="block w-full text-left" title={isImage(a) ? 'Preview' : 'Download'} onclick={() => openAttachment(a)}>
									{#if isImage(a)}
										<div class="bg-muted aspect-[4/3] w-full">
											<img src={previewUrl(a)} alt={a.filename} loading="lazy" class="size-full object-cover" />
										</div>
									{:else}
										{@const m = fileMeta(a)}
										{@const Icon = m.icon}
										<div class="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 {m.bg}">
											<Icon class="size-6 {m.fg}" />
											<span class="text-[10px] font-semibold tracking-wide {m.fg}">{ext(a)}</span>
										</div>
									{/if}
									<div class="flex flex-col gap-0.5 p-2">
										<span class="truncate text-xs font-medium">{a.filename}</span>
										<span class="text-faint text-[10px] tabular-nums">{fmtSize(a.size)}</span>
									</div>
								</button>
								<button
									type="button"
									title="Download"
									class="bg-background/85 text-muted-foreground hover:text-foreground absolute top-1.5 right-9 grid size-6 place-items-center rounded-full border opacity-0 transition-opacity group-hover:opacity-100"
									onclick={() => downloadAttachment(a)}
								>
									<DownloadIcon class="size-3.5" />
								</button>
								<button
									type="button"
									title="Remove"
									class="bg-background/85 text-muted-foreground hover:text-destructive absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full border opacity-0 transition-opacity group-hover:opacity-100"
									onclick={() => removeAttachment(a.r2Key)}
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
				<span class="font-heading truncate text-sm font-medium">{title}</span>
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
				<button type="button" class="hover:bg-destructive/10 hover:text-destructive grid size-6 place-items-center rounded transition-colors" title="Close (keeps draft)" onclick={close}>
					<XIcon class="size-4" />
				</button>
			</div>
		</div>

		{#if minimized}
			<button type="button" class="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2 text-left" onclick={() => (minimized = false)}>
				<span class="truncate text-sm font-medium">{subject || 'New message'}</span>
				{#if recipientNames}
					<span class="text-muted-foreground truncate text-xs">· {recipientNames}</span>
				{/if}
				{#if attachments.length}
					<span class="text-faint ml-auto shrink-0 text-xs">
						{attachments.length} file{attachments.length > 1 ? 's' : ''}
					</span>
				{/if}
			</button>
		{/if}

		{#if !minimized}
			{#if phase === 'sent'}
				<div class="m-3 flex items-center justify-between rounded-lg border bg-card px-4 py-3">
					<span class="text-sm">Message sent.</span>
					<Button variant="outline" size="sm" class="gap-1.5" onclick={undo}>
						<Undo2Icon class="size-3.5" /> Undo ({undoLeft})
					</Button>
				</div>
			{:else}
				<!-- Body fills the fixed-height panel; the editor flexes so nothing shifts. -->
				<div class="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-3">
					<div class="flex shrink-0 flex-col gap-2">
						<div class="flex items-center gap-2">
							<span class="text-muted-foreground w-10 shrink-0 text-xs">From</span>
							<FromSelector {identities} bind:mailboxId bind:aliasId />
						</div>
						<div class="flex items-start gap-2">
							<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">To</span>
							<div class="min-w-0 flex-1"><RecipientInput bind:value={to} onchange={scheduleSave} /></div>
							<div class="flex shrink-0 items-center gap-1.5 pt-2 text-xs font-medium">
								{#if !showCc}
									<button type="button" class="text-muted-foreground hover:text-brand" onclick={() => (showCc = true)}>Cc</button>
								{/if}
								{#if !showBcc}
									<button type="button" class="text-muted-foreground hover:text-brand" onclick={() => (showBcc = true)}>Bcc</button>
								{/if}
							</div>
						</div>
						{#if showCc}
							<div class="flex items-start gap-2">
								<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">Cc</span>
								<div class="min-w-0 flex-1"><RecipientInput bind:value={cc} onchange={scheduleSave} /></div>
								<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 pt-2" title="Remove Cc" onclick={() => { showCc = false; cc = []; scheduleSave(); }}>
									<XIcon class="size-3.5" />
								</button>
							</div>
						{/if}
						{#if showBcc}
							<div class="flex items-start gap-2">
								<span class="text-muted-foreground w-10 shrink-0 pt-2 text-xs">Bcc</span>
								<div class="min-w-0 flex-1"><RecipientInput bind:value={bcc} onchange={scheduleSave} /></div>
								<button type="button" class="text-muted-foreground hover:text-foreground shrink-0 pt-2" title="Remove Bcc" onclick={() => { showBcc = false; bcc = []; scheduleSave(); }}>
									<XIcon class="size-3.5" />
								</button>
							</div>
						{/if}
					</div>

					<Input
						class="h-8 shrink-0"
						placeholder="Subject"
						aria-label="Subject"
						bind:value={subject}
						oninput={scheduleSave}
						onblur={flushSave}
					/>

					<div class="min-h-0 flex-1 pb-2">
						{#key editorKey}
							<TiptapEditor
								initial={body}
								oninput={(html) => {
									body = html;
									scheduleSave();
								}}
								onattach={() => fileInput?.click()}
								onsend={send}
							/>
						{/key}
					</div>

					{#if attachments.length}
						<!-- Mobile fallback: a rail won't fit at 94vw, so dock chips at the bottom. -->
						<div class="max-h-24 shrink-0 overflow-y-auto pb-1 md:hidden">
							<div class="flex flex-wrap gap-2">
								{#each attachments as a (a.r2Key)}
									<span class="bg-muted flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
										<PaperclipIcon class="text-muted-foreground size-3" />
										<span class="max-w-[14ch] truncate">{a.filename}</span>
										<span class="text-faint">{fmtSize(a.size)}</span>
										<button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => removeAttachment(a.r2Key)}>
											<XIcon class="size-3" />
										</button>
									</span>
								{/each}
							</div>
						</div>
					{/if}
				</div>

				<div class="flex items-center justify-between gap-2 border-t px-3 py-2">
					<div class="flex items-center gap-1">
						<Button variant="ghost" size="icon" class="size-8 text-muted-foreground hover:text-destructive" title="Discard draft" onclick={discard}>
							<Trash2Icon class="size-4" />
						</Button>
						<SchedulePicker bind:value={scheduleAt} bind:open={schedulePickerOpen} />
						{#if uploading}
							<span class="text-muted-foreground text-xs">Uploading…</span>
						{:else if saved && draftId}
							<span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
								<CheckIcon class="text-ok size-3.5" /> Draft saved
							</span>
						{/if}
					</div>
					<!-- Split send: primary sends now (⌘↵); caret opens schedule presets. -->
					<div class="inline-flex">
						<Button variant="brand" size="sm" class="gap-1.5 rounded-r-none" disabled={!canSend} title={sendHint} onclick={send}>
							<SendIcon class="size-4" /> {scheduleAt ? 'Schedule' : 'Send'}
						</Button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="brand" size="sm" class="border-brand-foreground/25 rounded-l-none border-l px-1.5" disabled={!canSend} title="Schedule send" aria-label="Schedule send">
										<ChevronDownIcon class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="w-56">
								<DropdownMenu.Label class="text-muted-foreground text-xs">Send later</DropdownMenu.Label>
								<DropdownMenu.Item onSelect={() => armSchedule(presetTomorrow())}>Tomorrow, 8:00 AM</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={() => armSchedule(presetMonday())}>Monday, 8:00 AM</DropdownMenu.Item>
								<DropdownMenu.Item onSelect={() => (schedulePickerOpen = true)}>Pick date &amp; time…</DropdownMenu.Item>
								{#if scheduleAt}
									<DropdownMenu.Separator />
									<DropdownMenu.Item onSelect={clearSchedule}>Send now instead</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</div>
				</div>
			{/if}
		{/if}
		<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
		</div>
	</div>
	</div>
{/if}

<!-- Image preview lightbox (Gmail-style): click backdrop or Esc to close. -->
{#if preview}
	<div class="bg-scrim/80 fixed inset-0 z-50 flex flex-col" role="dialog" aria-modal="true" aria-label="Attachment preview">
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
