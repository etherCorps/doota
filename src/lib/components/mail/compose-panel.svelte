<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { onMount } from 'svelte';
	import FromSelector from './from-selector.svelte';
	import RecipientInput from './recipient-input.svelte';
	import RichEditor from './rich-editor.svelte';
	import SendIcon from '@lucide/svelte/icons/send';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import XIcon from '@lucide/svelte/icons/x';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import ClockIcon from '@lucide/svelte/icons/clock';
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
	import type { SendIdentity } from '$lib/server/mail/identities';
	import type { AttachmentRef } from '$lib/server/mail/drafts';

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

	const UNDO_SECONDS = 30;
	const title = $derived(
		resumeDraftId ? 'Draft' : prefill?.kind === 'forward' ? 'Forward' : 'New message'
	);

	let scheduleAt = $state('');
	let showSchedule = $state(false);

	let identities = $state<SendIdentity[]>([]);
	let mailboxId = $state<string | undefined>(undefined);
	let aliasId = $state<string | null | undefined>(undefined);

	let to = $state<string[]>([]);
	let cc = $state<string[]>([]);
	let bcc = $state<string[]>([]);
	let showCc = $state(false);
	let subject = $state('');
	let body = $state('');
	let attachments = $state<AttachmentRef[]>([]);
	let editorKey = $state(0);
	let minimized = $state(false);
	let fileInput = $state<HTMLInputElement>();

	let draftId = $state<string | null>(null);
	let clientRevision = $state(0);
	let phase = $state<'editing' | 'sending' | 'sent'>('editing');
	let sentSubmissionId = $state<string | null>(null);
	let undoLeft = $state(0);
	let uploading = $state(false);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let undoTimer: ReturnType<typeof setInterval> | undefined;

	onMount(async () => {
		identities = await sendIdentities();
		// Resume an existing draft (from the Drafts list).
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
			showCc = d.cc.length > 0 || d.bcc.length > 0;
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

	function scheduleSave() {
		if (phase !== 'editing') return;
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
		if (res.ok) clientRevision = res.clientRevision;
		else {
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

	async function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
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
		// A far-future scheduled send has no live undo — manage it from Scheduled.
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

	// Header X: close but KEEP the draft (it's autosaved — find it in Drafts later).
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
		minimized = false;
		scheduleAt = '';
		showSchedule = false;
		editorKey++;
	}

	const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
</script>

<!-- Docked, non-modal composer (Gmail-style) — the inbox stays visible + usable. -->
{#if open}
	<div
		class="bg-background fixed right-2 bottom-0 z-40 flex w-[min(94vw,30rem)] flex-col overflow-hidden rounded-t-xl border shadow-2xl md:right-6"
	>
		<!-- Title bar: click to minimize/restore -->
		<div class="bg-foreground text-background flex items-center justify-between gap-2 px-3 py-2">
			<button type="button" class="min-w-0 flex-1 text-left" onclick={() => (minimized = !minimized)}>
				<span class="font-heading truncate text-sm font-medium">{title}</span>
			</button>
			<div class="flex items-center gap-0.5">
				<button
					type="button"
					class="hover:bg-background/15 grid size-6 place-items-center rounded"
					title={minimized ? 'Expand' : 'Minimize'}
					onclick={() => (minimized = !minimized)}
				>
					{#if minimized}<Maximize2Icon class="size-3.5" />{:else}<MinusIcon class="size-4" />{/if}
				</button>
				<button
					type="button"
					class="hover:bg-background/15 grid size-6 place-items-center rounded"
					title="Close (keeps draft)"
					onclick={close}
				>
					<XIcon class="size-4" />
				</button>
			</div>
		</div>

		{#if !minimized}
			{#if phase === 'sent'}
				<div class="m-3 flex items-center justify-between rounded-lg border bg-card px-4 py-3">
					<span class="text-sm">Message sent.</span>
					<Button variant="outline" size="sm" class="gap-1.5" onclick={undo}>
						<Undo2Icon class="size-3.5" /> Undo ({undoLeft})
					</Button>
				</div>
			{:else}
				<div class="max-h-[min(60vh,32rem)] space-y-2.5 overflow-auto px-3 py-3">
					<div class="flex items-center gap-2">
						<span class="text-muted-foreground w-10 text-xs">From</span>
						<FromSelector {identities} bind:mailboxId bind:aliasId />
					</div>
					<div class="flex items-start gap-2">
						<span class="text-muted-foreground w-10 pt-2 text-xs">To</span>
						<div class="min-w-0 flex-1">
							<RecipientInput bind:value={to} onchange={scheduleSave} />
							{#if !showCc}
								<button type="button" class="text-muted-foreground hover:text-foreground mt-1 text-xs" onclick={() => (showCc = true)}>
									Add Cc/Bcc
								</button>
							{/if}
						</div>
					</div>
					{#if showCc}
						<div class="flex items-center gap-2">
							<span class="text-muted-foreground w-10 text-xs">Cc</span>
							<div class="min-w-0 flex-1"><RecipientInput bind:value={cc} onchange={scheduleSave} /></div>
						</div>
						<div class="flex items-center gap-2">
							<span class="text-muted-foreground w-10 text-xs">Bcc</span>
							<div class="min-w-0 flex-1"><RecipientInput bind:value={bcc} onchange={scheduleSave} /></div>
						</div>
					{/if}
					<div class="flex items-center gap-2">
						<span class="text-muted-foreground w-10 text-xs">Subj</span>
						<Input class="h-8 flex-1" placeholder="Subject" bind:value={subject} oninput={scheduleSave} onblur={flushSave} />
					</div>

					{#key editorKey}
						<RichEditor
							initial={body}
							oninput={(html) => {
								body = html;
								scheduleSave();
							}}
							onattach={() => fileInput?.click()}
						/>
					{/key}

					{#if attachments.length}
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
					{/if}
				</div>

				{#if showSchedule}
					<div class="flex items-center gap-2 border-t px-3 py-2">
						<ClockIcon class="text-muted-foreground size-4" />
						<input
							type="datetime-local"
							class="bg-background flex-1 rounded-md border px-2 py-1 text-xs"
							bind:value={scheduleAt}
						/>
						<button type="button" class="text-muted-foreground hover:text-foreground text-xs" onclick={() => { showSchedule = false; scheduleAt = ''; }}>
							Clear
						</button>
					</div>
				{/if}
				<div class="flex items-center justify-between gap-2 border-t px-3 py-2">
					<div class="flex items-center gap-1">
						<Button variant="ghost" size="icon" class="size-8" title="Schedule send" onclick={() => (showSchedule = !showSchedule)}>
							<ClockIcon class="size-4" />
						</Button>
						<span class="text-muted-foreground text-xs">{uploading ? 'Uploading…' : ''}</span>
					</div>
					<div class="flex gap-2">
						<Button variant="ghost" size="sm" onclick={discard}>Discard</Button>
						<Button size="sm" class="gap-1.5" disabled={!canSend} onclick={send}>
							<SendIcon class="size-4" /> {scheduleAt ? 'Schedule' : 'Send'}
						</Button>
					</div>
				</div>
			{/if}
		{/if}
		<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
	</div>
{/if}
