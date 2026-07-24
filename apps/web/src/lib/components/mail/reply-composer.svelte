<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { useDebounce } from 'runed';
	import { Button } from '$lib/components/ui/button/index.js';
	import FromSelector from './from-selector.svelte';
	import RecipientInput from './recipient-input.svelte';
	import RichEditor from './rich-editor.svelte';
	import SendIcon from '@lucide/svelte/icons/send';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { toast } from 'svelte-sonner';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ReplyIcon from '@lucide/svelte/icons/reply';
	import ReplyAllIcon from '@lucide/svelte/icons/reply-all';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import {
		startDraft,
		autosaveDraft,
		sendDraftById,
		undoDraftById,
		detachDraftAttachment
	} from '$lib/rpc/draft.remote';
	import type { SendIdentity } from '@doota/mail-core/identities';
	import type { AttachmentRef } from '@doota/mail-core/drafts';
	import { mirrorDraft, readMirror, clearMirror, sweepMirrors } from '$lib/client/local-draft';

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

	// Gmail model: an explicit Reply / Reply all switch so the sender always KNOWS
	// the scope — one person vs everyone on the thread. The switch DRIVES the
	// recipient fields (Reply all pre-fills To with everyone AND Cc from the
	// conversation), and those fields stay editable underneath for fine-tuning.
	let replyAll = $state(false);
	let toList = $state<string[]>([]);
	let ccList = $state<string[]>([]);
	let showCc = $state(false);
	const recips = $derived({ to: toList, cc: ccList });
	// Offer the switch only when reply-all would actually reach more people.
	const canReplyAll = $derived(toAll.length + ccAll.length > to.length);
	// A mail needs a To; Cc is optional. Send stays disabled until a To exists,
	// but you can edit down to empty and re-type — never a dead end.
	const hasRecipient = $derived(toList.length > 0);

	const lc = (a: string) => a.toLowerCase();
	const uniqLc = (xs: string[]) => {
		const seen = new Set<string>();
		return xs.filter((a) => (seen.has(lc(a)) ? false : (seen.add(lc(a)), true)));
	};
	// Switching mode repopulates the fields (like picking Gmail's Reply vs Reply
	// all). Reply = just the target; Reply all = everyone + the thread's Cc.
	function pickReply() {
		if (!replyAll && toList.length) return;
		replyAll = false;
		toList = uniqLc([...to]);
		ccList = [];
		showCc = false;
		scheduleSave();
	}
	function pickReplyAll() {
		replyAll = true;
		toList = uniqLc([...to, ...toAll]);
		ccList = uniqLc([...ccAll]);
		showCc = ccList.length > 0;
		scheduleSave();
	}

	const UNDO_SECONDS = 10;

	let sendMailboxId = $state('');
	let aliasId = $state<string | null | undefined>(undefined);
	let body = $state('');
	let editorKey = $state(0);
	let attachments = $state<AttachmentRef[]>([]);
	let fileInput = $state<HTMLInputElement>();
	let sending = $state(false);
	let uploading = $state(false);
	const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
	// The body is HTML; "has content" ignores tags/whitespace.
	const hasBody = $derived(body.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0);

	// Collapsible: on phones the full composer eats most of the thread view, so
	// it starts as a one-row "Reply…" bar; desktop starts open and can collapse
	// too. Collapsing only CSS-hides the body — the editor stays mounted, so an
	// in-progress draft survives the round trip.
	const isMobile = new IsMobile();
	let collapsed = $state(false);

	// Local-first crash buffer: every keystroke mirrors to localStorage; the
	// mirror is cleared once the server acks, so on mount its presence means
	// unsaved text — restore it. Keyed by thread (draftId doesn't exist yet
	// while the loss window is open).
	const mirrorKey = $derived(`reply:${threadId}`);

	// Seed the sending identity from the parent thread (remounted per {#key}).
	onMount(() => {
		sendMailboxId = mailboxId;
		aliasId = defaultAliasId;
		replyAll = false;
		toList = uniqLc([...to]);
		ccList = [];
		showCc = false;
		collapsed = isMobile.current;
		sweepMirrors();
		const local = readMirror(mirrorKey);
		if (local?.body) {
			body = local.body;
			editorKey++;
			collapsed = false;
			toast('Restored unsaved reply');
			scheduleSave();
		}
	});
	let draftId = $state<string | null>(null);
	let clientRevision = $state(0);

	// Switching threads remounts this component via {#key thread.id} in the page,
	// so initial state above is always fresh for the current parent.

	const scheduleSave = useDebounce(() => flushSave(), 800);

	// Single-flight: the debounce flush, the visibilitychange flush, Send and
	// attachment upload can all race here. Two concurrent startDraft calls mint
	// two draft rows and the last resolver clobbers draftId — which is how a
	// stale-body snapshot once went out on the wire while the real text orphaned.
	let draftPending: Promise<string | null> | null = null;
	function ensureDraft(): Promise<string | null> {
		if (draftId) return Promise.resolve(draftId);
		draftPending ??= createDraftRow().finally(() => (draftPending = null));
		return draftPending;
	}
	async function createDraftRow(): Promise<string | null> {
		const sentBody = body;
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
		// Server has this text now — drop the crash buffer (unless more was
		// typed while the request was in flight).
		if (body === sentBody) clearMirror(mirrorKey);
		return draftId;
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
		attachments = (await detachDraftAttachment({ draftId, r2Key })).attachments;
	}

	async function flushSave() {
		scheduleSave.cancel();
		if (!hasBody) return;
		if (!draftId) {
			// The create may already be in flight carrying an older body snapshot —
			// fall through and autosave the current text instead of trusting it.
			await ensureDraft();
			if (!draftId) return;
		}
		const sentBody = body;
		const res = await autosaveDraft({
			draftId,
			clientRevision,
			body,
			to: recips.to,
			cc: recips.cc,
			fromAliasId: aliasId ?? null
		});
		if (res.ok) {
			clientRevision = res.clientRevision;
			if (body === sentBody) clearMirror(mirrorKey);
		} else {
			clientRevision = res.draft.clientRevision;
			body = res.draft.body ?? body;
		}
	}

	const canSend = $derived((hasBody || attachments.length > 0) && hasRecipient);

	async function send() {
		if (!canSend || sending) return;
		sending = true;
		let res!: Awaited<ReturnType<typeof sendDraftById>>;
		try {
			await flushSave();
			await ensureDraft();
			if (!draftId) return;
			res = await sendDraftById({ draftId, undoSeconds: UNDO_SECONDS });
		} catch {
			toast.error('Send failed — check your connection and try again.');
			return;
		} finally {
			sending = false;
		}
		// Gmail-style: the composer frees instantly; the toast carries Undo for
		// the send-delay window. Undo restores the draft back into the editor.
		clearMirror(mirrorKey);
		const submissionId = res.submissionId;
		draftId = null;
		clientRevision = 0;
		body = '';
		editorKey++;
		onchange?.(); // the sent bubble now exists in this mailbox's timeline
		toast('Reply sent', {
			duration: UNDO_SECONDS * 1000,
			action: { label: 'Undo', onClick: () => undoSend(submissionId) }
		});
	}

	async function undoSend(submissionId: string) {
		const res = await undoDraftById({ submissionId });
		if (res.restored && res.draft) {
			draftId = res.draft.id;
			clientRevision = res.draft.clientRevision;
			body = res.draft.body ?? '';
			aliasId = res.draft.fromAliasId;
			editorKey++;
		} else {
			toast.error('Too late to undo — the reply already left.');
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

<!-- Tab going hidden is the last reliable moment to reach the network — flush
     immediately instead of waiting out the debounce (best-effort; the local
     mirror covers whatever doesn't make it). -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void flushSave();
	}}
/>

<div
	class="bg-card border-t shadow-[0_-6px_20px_-12px_oklch(0.2_0.02_285/0.15)] transition-[padding] duration-200 motion-reduce:transition-none {collapsed
		? 'p-2'
		: 'p-3'}"
>
	{#if collapsed}
		<!-- Re-emerge bar: reads like a chat input; shows draft state so a
		     half-written reply isn't mistaken for empty. -->
		<button
			type="button"
			transition:slide={{ duration: 150 }}
			class="text-muted-foreground hover:border-ring/40 flex h-9 w-full items-center gap-2 rounded-full border bg-background px-3.5 text-sm transition-colors"
			onclick={() => (collapsed = false)}
		>
			<ReplyIcon class="size-4 shrink-0" />
			<span class="truncate">
				{#if hasBody || attachments.length}Continue draft…{:else}Reply to {toAddress}…{/if}
			</span>
		</button>
	{/if}
	<!-- 0fr/1fr grid trick: height animates while the editor stays mounted
	     (an {#if} + slide would unmount it and drop the draft). Popovers inside
	     survive the overflow-hidden because bits-ui portals them to body. -->
	<div
		class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none {collapsed
			? 'grid-rows-[0fr]'
			: 'grid-rows-[1fr]'}"
	>
	<div class="min-h-0 overflow-hidden">
	<div class="space-y-2">
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-muted-foreground shrink-0 text-xs">From</span>
				<div class="min-w-0 flex-1">
					<FromSelector {identities} bind:mailboxId={sendMailboxId} bind:aliasId />
				</div>
				{#if canReplyAll}
					<!-- Explicit scope switch (Gmail's Reply / Reply all): the sender
					     always sees whether this goes to one person or everyone. Picking
					     a side repopulates the fields below — Reply all pre-fills Cc from
					     the thread. Own full-width row on mobile, inline at sm. -->
					<div
						role="group"
						aria-label="Reply scope"
						class="border-border bg-muted order-last flex w-full items-center gap-1 rounded-lg border p-1 sm:order-none sm:w-auto"
					>
						<button
							type="button"
							aria-pressed={!replyAll}
							onclick={pickReply}
							class="focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 sm:flex-none {!replyAll
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							<ReplyIcon class="size-3.5 shrink-0" /> Reply
						</button>
						<button
							type="button"
							aria-pressed={replyAll}
							onclick={pickReplyAll}
							class="focus-visible:ring-ring flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap tabular-nums transition-colors outline-none focus-visible:ring-2 sm:flex-none {replyAll
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							<ReplyAllIcon class="size-3.5 shrink-0" /> Reply all · {toAll.length + ccAll.length}
						</button>
					</div>
				{/if}
				<Button
					variant="ghost"
					size="icon"
					class="text-muted-foreground size-7 shrink-0"
					title="Collapse reply"
					onclick={() => (collapsed = true)}
				>
					<ChevronDownIcon class="size-4" />
					<span class="sr-only">Collapse reply</span>
				</Button>
			</div>
			<!-- Recipient fields reflect the scope choice and stay editable for
			     fine-tuning: type anyone in, drop a chip, add/remove Cc. -->
			<div class="flex items-start gap-2">
				<span class="text-muted-foreground w-6 shrink-0 pt-2 text-xs">To</span>
				<div class="min-w-0 flex-1">
					<RecipientInput bind:value={toList} placeholder="Add recipients" onchange={scheduleSave} />
				</div>
				{#if !showCc}
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground shrink-0 pt-2 text-xs font-medium"
						onclick={() => (showCc = true)}>Cc</button
					>
				{/if}
			</div>
			{#if showCc}
				<div class="flex items-start gap-2">
					<span class="text-muted-foreground w-6 shrink-0 pt-2 text-xs">Cc</span>
					<div class="min-w-0 flex-1">
						<RecipientInput bind:value={ccList} placeholder="Cc recipients" onchange={scheduleSave} />
					</div>
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground shrink-0 pt-2"
						title="Remove Cc"
						onclick={() => {
							showCc = false;
							ccList = [];
							scheduleSave();
						}}
					>
						<XIcon class="size-3.5" />
					</button>
				</div>
			{/if}
			{#key editorKey}
				<RichEditor
					initial={body}
					placeholder="Reply to {toAddress}…"
					oninput={(html) => {
						body = html;
						mirrorDraft(mirrorKey, { body: html });
						scheduleSave();
					}}
					onattach={() => fileInput?.click()}
					onkeydown={onKeydown}
				/>
			{/key}
			{#if attachments.length}
				<div class="flex flex-wrap gap-2">
					{#each attachments as a (a.r2Key)}
						<span class="bg-muted flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
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
			<div class="flex items-center justify-end gap-2">
				{#if uploading}
					<span class="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
						<Spinner class="size-3" /> Uploading…
					</span>
				{:else}
					<span class="text-faint hidden text-[11px] sm:inline">⌘↵ to send</span>
				{/if}
				<Button variant="brand" size="sm" class="gap-1.5" disabled={!canSend || sending || uploading} onclick={send}>
					{#if sending}
						<Spinner class="size-3.5" /> Sending…
					{:else}
						<SendIcon class="size-3.5" /> Send
					{/if}
				</Button>
			</div>
			<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
	</div>
	</div>
	</div>
</div>
