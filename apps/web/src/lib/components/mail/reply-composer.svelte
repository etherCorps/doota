<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount, onDestroy, untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import { useDebounce } from 'runed';
	import { Button } from '$lib/components/ui/button/index.js';
	import FromSelector from './from-selector.svelte';
	import RecipientInput from './recipient-input.svelte';
	import TiptapEditor from './tiptap-editor.svelte';
	import SendIcon from '@lucide/svelte/icons/send';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { toast } from 'svelte-sonner';
	import { sendToast } from '$lib/utils/send-toast';
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
		discardDraftById,
		detachDraftAttachment
	} from '$lib/rpc/draft.remote';
	import { myMailboxSignatures } from '$lib/rpc/signature.remote';
	import { withSignature, swapSignature } from '$lib/mail/signature';
	import type { SendIdentity } from '@doota/mail-core/identities';
	import type { AttachmentRef } from '@doota/mail-core/drafts';
	import { fmtSize } from '$lib/mail/format';
	import { replySubject } from '@doota/mail-core/mail-thread-contract';
	import { mirrorDraft, readMirror, clearMirror, sweepMirrors } from '$lib/client/local-draft';

	// Inline reply docked at the bottom of an open thread — the primary compose
	// surface, and the one that should feel like a chat input. Replies default
	// their From to the identity the mail was addressed to (an alias, if any), so
	// hide-my-email doesn't leak the real address on the first reply.
	let {
		mailboxId,
		threadId,
		parentMessageId,
		toAddress,
		subject = null,
		to,
		toAll,
		ccAll,
		initialScope = 'reply',
		autoOpen = false,
		expandKey = 0,
		defaultAliasId = null,
		identities,
		onchange,
		onsent
	}: {
		mailboxId: string;
		threadId: string;
		parentMessageId: string | null;
		/** Display label (the reply target). */
		toAddress: string;
		/** Thread subject — replies leave with a proper `Re:` (no stacking). */
		subject?: string | null;
		/** Opening scope: a per-message "Reply all" click starts in reply_all. */
		initialScope?: 'reply' | 'reply_all';
		/** Expand immediately (user explicitly picked a message to reply to). */
		autoOpen?: boolean;
		/** Bumped by the parent on every per-message Reply click — re-expands the
		 *  composer even when it's already mounted for that message (and collapsed). */
		expandKey?: number;
		/** Reply recipient set (just the target). */
		to: string[];
		/** Reply-all recipient sets (self already excluded, computed by the page). */
		toAll: string[];
		ccAll: string[];
		defaultAliasId?: string | null;
		identities: SendIdentity[];
		onchange?: () => void;
		/** Fired only on a successful send (not undo) — the parent clears its
		 *  per-message reply target so the next reply defaults to latest again. */
		onsent?: () => void;
	} = $props();

	// Gmail model: an explicit Reply / Reply all switch so the sender always knows
	// the scope — one person vs everyone on the thread. The switch drives the
	// recipient fields (Reply all pre-fills To with everyone and Cc from the
	// conversation), and those fields stay editable underneath for fine-tuning.
	let replyAll = $state(false);
	let toList = $state<string[]>([]);
	let ccList = $state<string[]>([]);
	let showCc = $state(false);
	const recips = $derived({ to: toList, cc: ccList });
	// Offer the switch only when reply-all would actually reach more people.
	const canReplyAll = $derived(toAll.length + ccAll.length > to.length);
	// A mail needs a To; Cc is optional. Send stays disabled until a To exists,
	// but you can edit down to empty and re-type — not a dead end.
	const hasRecipient = $derived(toList.length > 0);

	const lc = (addr: string) => addr.toLowerCase();
	const uniqLc = (xs: string[]) => {
		const seen = new Set<string>();
		return xs.filter((addr) => (seen.has(lc(addr)) ? false : (seen.add(lc(addr)), true)));
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
	let subjectText = $state('');
	let body = $state('');
	let editorKey = $state(0);
	// Signature-per-mailbox + the signature currently in the editor, so changing
	// the From mailbox swaps it (see the $effect below). sigReady gates the swap
	// until the fresh reply has been seeded.
	let sigByMailbox = $state<Map<string, string>>(new Map());
	let appliedSig = $state('');
	let sigReady = $state(false);
	let attachments = $state<AttachmentRef[]>([]);
	let fileInput = $state<HTMLInputElement>();
	let sending = $state(false);
	let uploading = $state(false);
	// The body is HTML; "has content" ignores tags/whitespace — an empty editor
	// serializes to "<p></p>", a non-empty string but no real text.
	const htmlHasText = (html: string) =>
		html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0;
	// A reply is sendable with an inline image and no text (Gmail/Superhuman
	// allow it), so "has content" is real text or an embedded image.
	const htmlHasContent = (html: string) => htmlHasText(html) || /<img\b/i.test(html);
	const hasBody = $derived(htmlHasContent(body));

	// Collapsible: on phones the full composer eats most of the thread view, so
	// it starts as a one-row "Reply…" bar; desktop starts open and can collapse
	// too. Collapsing only CSS-hides the body — the editor stays mounted, so an
	// in-progress draft survives the round-trip.
	const isMobile = new IsMobile();
	let collapsed = $state(false);

	// Re-expand when the user taps a message's Reply while this composer is already
	// mounted for that target but collapsed. The first effect run snapshots the tick
	// (so a plain mount / thread open never expands); only a later increment does.
	let firstExpandRun = true;
	let seenExpand = 0;
	$effect(() => {
		const t = expandKey;
		if (firstExpandRun) {
			firstExpandRun = false;
			seenExpand = t;
			return;
		}
		if (t > seenExpand) {
			seenExpand = t;
			collapsed = false;
		}
	});

	// Local-first crash buffer: every keystroke mirrors to localStorage; the
	// mirror is cleared once the server acks, so on mount its presence means
	// unsaved text — restore it. Keyed by thread (draftId doesn't exist yet
	// while the loss window is open).
	const mirrorKey = $derived(`reply:${threadId}`);

	// Seed the sending identity from the parent thread (remounted per {#key}).
	onMount(() => {
		sendMailboxId = mailboxId;
		aliasId = defaultAliasId;
		subjectText = replySubject(subject, initialScope);
		if (initialScope === 'reply_all') {
			replyAll = true;
			toList = uniqLc([...to, ...toAll]);
			ccList = uniqLc([...ccAll]);
			showCc = ccList.length > 0;
		} else {
			replyAll = false;
			toList = uniqLc([...to]);
			ccList = [];
			showCc = false;
		}
		collapsed = !autoOpen;
		sweepMirrors();
		const local = readMirror(mirrorKey);
		// Only a mirror with real text is a restore — an empty editor mirrors
		// "<p></p>", which must not resurface as a phantom "Restored" toast.
		if (local?.body && htmlHasContent(local.body)) {
			body = local.body;
			editorKey++;
			collapsed = false;
			toast('Restored unsaved reply');
			scheduleSave();
		} else {
			if (local) clearMirror(mirrorKey); // sweep the empty husk
			void applySignature(); // fresh reply → seed the sender's signature
		}
	});

	// Append the sender's signature to a fresh (non-restored) reply. Async, so
	// guarded by htmlHasContent — a concurrent restore or typing wins over it.
	// Reply context: the 'reply' signature wins, empty falls back to the
	// new-message one. The map already holds the resolved value, so the
	// From-switch swap below uses the same context for free.
	async function applySignature() {
		const rows = (await myMailboxSignatures()) ?? [];
		sigByMailbox = new Map(rows.map((row) => [row.mailboxId, row.replyBodyHtml || row.bodyHtml]));
		const sig = sigByMailbox.get(sendMailboxId) ?? '';
		if (sig && !htmlHasContent(body)) {
			body = withSignature(body, sig);
			editorKey++;
		}
		appliedSig = sig;
		sigReady = true; // fresh reply seeded — a later From change may now swap.
	}

	// Swap the signature when the From mailbox changes. untrack: reads/writes body
	// + appliedSig, must only re-run on sendMailboxId.
	$effect(() => {
		const id = sendMailboxId;
		untrack(() => {
			if (!sigReady || !id) return;
			const rebuilt = swapSignature(body, appliedSig, sigByMailbox.get(id) ?? '');
			if (rebuilt === null || rebuilt === body) return;
			body = rebuilt;
			appliedSig = sigByMailbox.get(id) ?? '';
			editorKey++;
			scheduleSave();
		});
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
			subject: subjectText,
			body
		});
		draftId = d.id;
		clientRevision = d.clientRevision;
		// Server has this text now, so drop the crash buffer (unless more was
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

	// Serialize saves: two concurrent autosaves (debounce flush + visibilitychange
	// + Send all race here) would send the same clientRevision. The loser reads as
	// an optimistic-concurrency miss and falsely warns "updated in another tab",
	// reloading the body mid-type. Chaining makes each save see the bumped revision.
	let saveChain: Promise<void> = Promise.resolve();
	function flushSave(): Promise<void> {
		scheduleSave.cancel();
		saveChain = saveChain.then(doSave, doSave);
		return saveChain;
	}

	async function doSave() {
		// Cleared out → an empty reply is not a draft. Delete the row if one exists
		// (Gmail/Superhuman/Fastmail all discard an emptied draft) so it can't linger
		// in Drafts with stale text. Recipients are auto-filled, so they don't count.
		if (!hasBody && attachments.length === 0) {
			if (draftId) {
				const id = draftId;
				draftId = null;
				clientRevision = 0;
				clearMirror(mirrorKey);
				await discardDraftById({ draftId: id });
			}
			return;
		}
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
			subject: subjectText,
			to: recips.to,
			cc: recips.cc,
			fromAliasId: aliasId ?? null
		});
		if (res.ok) {
			clientRevision = res.clientRevision;
			if (body === sentBody) clearMirror(mirrorKey);
		} else {
			// Adopt the winning revision. But if we're mid-send, this is the send's
			// own flushSave racing a pending autosave (same draft, same tab), not a
			// real cross-tab edit, so adopt silently: no body reload, no false toast.
			clientRevision = res.draft.clientRevision;
			if (!sending) {
				body = res.draft.body ?? body;
				subjectText = res.draft.subject ?? subjectText;
				editorKey++;
				toast.warning('Draft updated in another tab — loaded the latest version.');
			}
		}
	}

	// Safety net for the race where the reply is cleared then the thread is switched
	// (this component unmounts) before the debounced flushSave fires — don't strand
	// an empty husk in Drafts. Best-effort; the component is going away.
	onDestroy(() => {
		if (draftId && !hasBody && attachments.length === 0) void discardDraftById({ draftId });
	});

	const canSend = $derived((hasBody || attachments.length > 0) && hasRecipient);

	async function send() {
		if (!canSend || sending) return;
		sending = true;
		// One toast that carries the whole send: Sending… → Queued… → sent·Undo (or
		// an error), morphing on a single id so it reads as one acknowledgement.
		const sendProgress = sendToast();
		// Fold the docked composer immediately — the editor stays mounted under the
		// grid-collapse, so flushSave below still reads the body. This is what makes
		// the close feel instant instead of waiting on the save round-trips.
		collapsed = true;
		// Persist the latest text; the send then flies in the background. On failure
		// the (already-saved) draft stays in Drafts.
		await flushSave();
		await ensureDraft();
		const id = draftId;
		sending = false;
		if (!id) {
			sendProgress.dismiss();
			return;
		}
		clearMirror(mirrorKey);
		draftId = null;
		clientRevision = 0;
		body = '';
		attachments = []; // clear the chips — they belonged to the sent draft
		editorKey++;
		onsent?.(); // clear the parent's reply target → next reply defaults to latest
		try {
			sendProgress.queued(); // draft persisted; delivery request now in flight
			const res = await sendDraftById({ draftId: id, undoSeconds: UNDO_SECONDS });
			onchange?.(); // the sent bubble now exists in this mailbox's timeline
			sendProgress.sent(
				'Reply sent',
				{ label: 'Undo', onClick: () => undoSend(res.submissionId) },
				UNDO_SECONDS * 1000
			);
		} catch {
			sendProgress.fail('Send failed — your draft is saved in Drafts.');
		}
	}

	async function undoSend(submissionId: string) {
		const res = await undoDraftById({ submissionId });
		if (res.restored && res.draft) {
			draftId = res.draft.id;
			clientRevision = res.draft.clientRevision;
			body = res.draft.body ?? '';
			subjectText = res.draft.subject ?? subjectText;
			aliasId = res.draft.fromAliasId;
			editorKey++;
		} else {
			toast.error('Too late to undo — the reply already left.');
		}
		onchange?.(); // the timeline bubble was removed (undo) — refresh
	}

</script>

<!-- Tab going hidden is the last reliable moment to reach the network, so flush
     immediately instead of waiting out the debounce (best-effort; the local
     mirror covers whatever doesn't make it). -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void flushSave();
	}}
/>

<div
	class="bg-card border-t shadow-[0_-6px_20px_-12px_oklch(0.2_0.02_285/0.15)] transition-[padding] duration-200 motion-reduce:transition-none {collapsed
		? 'px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]'
		: 'px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]'}"
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
				<!-- From + selector: own full-width line under the scope row on mobile
				     (order-2), inline and flex-1 on desktop. With no scope switch it is
				     the sole line, so it just grows. -->
				<div
					class="flex min-w-0 items-center gap-2 {canReplyAll
						? 'order-2 w-full sm:order-none sm:w-auto sm:flex-1'
						: 'flex-1'}"
				>
					<span class="text-muted-foreground shrink-0 text-xs">From</span>
					<div class="min-w-0 flex-1">
						<FromSelector {identities} bind:mailboxId={sendMailboxId} bind:aliasId />
					</div>
				</div>
				{#if canReplyAll}
					<!-- Explicit scope switch (Gmail's Reply / Reply all): the sender
					     always sees whether this goes to one person or everyone. Picking
					     a side repopulates the fields below — Reply all pre-fills Cc from
					     the thread. Own full-width row on top on mobile, inline at sm. -->
					<div
						role="group"
						aria-label="Reply scope"
						class="border-border bg-muted order-1 flex flex-1 items-center gap-1 rounded-lg border p-1 sm:order-none sm:w-auto sm:flex-none"
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
				<!-- With a scope switch present, the chevron rides its top row (order-1)
				     so it lands top-right; otherwise it trails the From line inline. -->
				<Button
					variant="ghost"
					size="icon"
					class="text-muted-foreground size-7 shrink-0 {canReplyAll ? 'order-1 sm:order-none' : ''}"
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
			<!-- Subject stays editable (Outlook/Apple style). Safe to change: Doota
			     threads on References/In-Reply-To headers, not the subject line. -->
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground w-6 shrink-0 text-xs">Re</span>
				<input
					type="text"
					bind:value={subjectText}
					oninput={scheduleSave}
					placeholder="Subject"
					class="focus-visible:ring-ring/40 min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2"
				/>
			</div>
			{#key editorKey}
				<TiptapEditor
					focusStart
					initial={body}
					placeholder="Reply to {toAddress}…"
					bodyClass="max-h-[45svh]"
					oninput={(html) => {
						body = html;
						// Don't mirror an empty editor ("<p></p>"); clear any prior husk so
						// emptying a reply doesn't leave a phantom to "restore" next open.
						if (htmlHasContent(html)) mirrorDraft(mirrorKey, { body: html });
						else clearMirror(mirrorKey);
						scheduleSave();
					}}
					onattach={() => fileInput?.click()}
					onsend={send}
				/>
			{/key}
			{#if attachments.length}
				<!-- Cap the chip list so many files scroll instead of pushing the Send
				     button off-screen. -->
				<div class="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
					{#each attachments as attachment (attachment.r2Key)}
						<span class="bg-muted flex items-center gap-2 rounded-lg border px-2 py-1 text-xs">
							<PaperclipIcon class="text-muted-foreground size-3" />
							<span class="max-w-[14ch] truncate">{attachment.filename}</span>
							<span class="text-faint">{fmtSize(attachment.size)}</span>
							<button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => removeAttachment(attachment.r2Key)}>
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
						<SendIcon class="size-3.5" /> Reply
					{/if}
				</Button>
			</div>
			<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
	</div>
	</div>
	</div>
</div>
