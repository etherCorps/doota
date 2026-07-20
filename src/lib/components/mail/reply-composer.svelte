<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import FromSelector from './from-selector.svelte';
	import RichEditor from './rich-editor.svelte';
	import SendIcon from '@lucide/svelte/icons/send';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		startDraft,
		autosaveDraft,
		sendDraftById,
		undoDraftById,
		detachDraftAttachment
	} from '$lib/rpc/draft.remote';
	import type { SendIdentity } from '$lib/server/mail/identities';
	import type { AttachmentRef } from '$lib/server/mail/drafts';

	// Inline reply docked at the bottom of an open thread — the primary compose
	// surface, and the one that should feel like a chat input. Replies default
	// their From to the identity the mail was addressed to (an alias, if any), so
	// hide-my-email never leaks the real address on the first reply.
	let {
		mailboxId,
		threadId,
		parentMessageId,
		toAddress,
		to,
		toAll,
		ccAll,
		defaultAliasId = null,
		identities,
		onchange
	}: {
		mailboxId: string;
		threadId: string;
		parentMessageId: string | null;
		/** Display label (the reply target). */
		toAddress: string;
		/** Reply recipient set (just the target). */
		to: string[];
		/** Reply-all recipient sets (self already excluded, computed by the page). */
		toAll: string[];
		ccAll: string[];
		defaultAliasId?: string | null;
		identities: SendIdentity[];
		onchange?: () => void;
	} = $props();

	let replyAll = $state(false);
	const recips = $derived(replyAll ? { to: toAll, cc: ccAll } : { to, cc: [] as string[] });
	// Offer reply-all only when it would actually add recipients.
	const canReplyAll = $derived(toAll.length + ccAll.length > to.length);

	const UNDO_SECONDS = 30;

	let sendMailboxId = $state('');
	let aliasId = $state<string | null | undefined>(undefined);
	let body = $state('');
	let editorKey = $state(0);
	let attachments = $state<AttachmentRef[]>([]);
	let fileInput = $state<HTMLInputElement>();
	const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
	// The body is HTML; "has content" ignores tags/whitespace.
	const hasBody = $derived(body.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0);

	// Seed the sending identity from the parent thread (remounted per {#key}).
	onMount(() => {
		sendMailboxId = mailboxId;
		aliasId = defaultAliasId;
	});
	let draftId = $state<string | null>(null);
	let clientRevision = $state(0);
	let phase = $state<'editing' | 'sent'>('editing');
	let sentSubmissionId = $state<string | null>(null);
	let undoLeft = $state(0);
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let undoTimer: ReturnType<typeof setInterval> | undefined;

	// Switching threads remounts this component via {#key thread.id} in the page,
	// so initial state above is always fresh for the current parent.

	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(flushSave, 800);
	}

	async function ensureDraft(): Promise<string | null> {
		if (draftId) return draftId;
		const d = await startDraft({
			mailboxId: sendMailboxId,
			kind: replyAll ? 'reply_all' : 'reply',
			threadId,
			inReplyToMessageId: parentMessageId,
			fromAliasId: aliasId ?? null,
			to: recips.to,
			cc: recips.cc,
			body
		});
		draftId = d.id;
		clientRevision = d.clientRevision;
		return draftId;
	}

	async function onFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (!files.length) return;
		const id = await ensureDraft();
		if (!id) return;
		for (const file of files) {
			const fd = new FormData();
			fd.append('draftId', id);
			fd.append('file', file);
			const res = await fetch('/api/drafts/attachments', { method: 'POST', body: fd });
			if (res.ok) attachments = ((await res.json()) as { attachments: AttachmentRef[] }).attachments;
		}
	}
	async function removeAttachment(r2Key: string) {
		if (!draftId) return;
		attachments = (await detachDraftAttachment({ draftId, r2Key })).attachments;
	}

	async function flushSave() {
		clearTimeout(saveTimer);
		if (phase !== 'editing' || !hasBody) return;
		if (!draftId) {
			await ensureDraft();
			return;
		}
		const res = await autosaveDraft({
			draftId,
			clientRevision,
			body,
			to: recips.to,
			cc: recips.cc,
			fromAliasId: aliasId ?? null
		});
		if (res.ok) clientRevision = res.clientRevision;
		else {
			clientRevision = res.draft.clientRevision;
			body = res.draft.body ?? body;
		}
	}

	const canSend = $derived(hasBody || attachments.length > 0);

	async function send() {
		if (!canSend) return;
		await flushSave();
		await ensureDraft();
		if (!draftId) return;
		const res = await sendDraftById({ draftId, undoSeconds: UNDO_SECONDS });
		sentSubmissionId = res.submissionId;
		phase = 'sent';
		undoLeft = UNDO_SECONDS;
		undoTimer = setInterval(() => {
			undoLeft -= 1;
			if (undoLeft <= 0) finishSent();
		}, 1000);
		onchange?.(); // the sent bubble now exists in this mailbox's timeline
	}

	function finishSent() {
		clearInterval(undoTimer);
		phase = 'editing';
		sentSubmissionId = null;
		draftId = null;
		clientRevision = 0;
		body = '';
	}

	async function undo() {
		if (!sentSubmissionId) return;
		clearInterval(undoTimer);
		const res = await undoDraftById({ submissionId: sentSubmissionId });
		if (res.restored && res.draft) {
			draftId = res.draft.id;
			clientRevision = res.draft.clientRevision;
			body = res.draft.body ?? '';
			aliasId = res.draft.fromAliasId;
			editorKey++;
			phase = 'editing';
			sentSubmissionId = null;
		} else {
			finishSent();
		}
		onchange?.(); // the timeline bubble was removed (undo) — refresh
	}

	function onKeydown(e: KeyboardEvent) {
		// Keyboard-first: ⌘/Ctrl+Enter sends.
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			send();
		}
	}
</script>

<div class="bg-card border-t p-3">
	{#if phase === 'sent'}
		<div class="flex items-center justify-between rounded-xl border px-4 py-2.5">
			<span class="text-muted-foreground text-sm">Reply sent.</span>
			<Button variant="outline" size="sm" class="gap-1.5" onclick={undo}>
				<Undo2Icon class="size-3.5" /> Undo ({undoLeft})
			</Button>
		</div>
	{:else}
		<div class="space-y-2">
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground text-xs">From</span>
				<FromSelector {identities} bind:mailboxId={sendMailboxId} bind:aliasId />
				{#if canReplyAll}
					<Button
						variant={replyAll ? 'secondary' : 'ghost'}
						size="sm"
						class="ml-auto h-7 text-xs"
						onclick={() => {
							replyAll = !replyAll;
							scheduleSave();
						}}
					>
						Reply all
					</Button>
				{/if}
			</div>
			{#if replyAll}
				<p class="text-muted-foreground font-mono text-[11px]">
					to {recips.to.join(', ')}{#if recips.cc.length} · cc {recips.cc.join(', ')}{/if}
				</p>
			{/if}
			{#key editorKey}
				<RichEditor
					initial={body}
					placeholder="Reply to {toAddress}…"
					oninput={(html) => {
						body = html;
						scheduleSave();
					}}
					onattach={() => fileInput?.click()}
					onkeydown={onKeydown}
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
			<div class="flex items-center justify-end">
				<Button size="sm" class="gap-1.5" disabled={!canSend} onclick={send}>
					<SendIcon class="size-3.5" /> Send
				</Button>
			</div>
			<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
		</div>
	{/if}
</div>
