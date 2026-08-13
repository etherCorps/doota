// SPDX-License-Identifier: Apache-2.0
// The compose engine, extracted from compose-panel so two surfaces can share it:
// the desktop docked panel and the mobile /app/compose page. Owns every piece of
// state and behavior that isn't presentation — draft lifecycle (single-flight
// create, serialized autosave chain, crash mirror), attachments, signatures,
// scheduling, and the send/undo/discard flows. Surfaces own only markup and
// call requestClose/requestReopen through the callbacks they pass in.
//
// Instantiate during component init (the signature-swap $effect needs an effect
// context), then call `await session.init()` from onMount.
import { untrack } from 'svelte';
import { useDebounce } from 'runed';
import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { sendToast } from '$lib/utils/send-toast';
import { compose, type ComposePrefill } from '$lib/client/compose.svelte.js';
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
import { myMailboxSignatures } from '$lib/rpc/signature.remote';
import { withSignature, swapSignature } from '$lib/mail/signature';
import { mirrorDraft, readMirror, clearMirror, sweepMirrors } from '$lib/client/local-draft';
import { toLocalDatetime } from '$lib/utils/parse-when';
import type { SendIdentity } from '@doota/mail-core/identities';
import type { AttachmentRef } from '@doota/mail-core/drafts';

export const UNDO_SECONDS = 10;

// Schedule-send presets (shared by both surfaces' "Send later" menus).
export function presetTomorrow(): Date {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(8, 0, 0, 0);
	return d;
}
export function presetMonday(): Date {
	const d = new Date();
	const add = ((1 - d.getDay() + 7) % 7) || 7; // next Monday (never today)
	d.setDate(d.getDate() + add);
	d.setHours(8, 0, 0, 0);
	return d;
}

// Color-coded file-type meta for non-image attachment tiles (shared surfaces).
export function attachmentExt(attachment: AttachmentRef): string {
	return (attachment.filename.split('.').pop() ?? 'file').toUpperCase().slice(0, 4);
}

export type ComposeSessionOptions = {
	prefill?: ComposePrefill;
	resumeDraftId?: string;
	/** Pre-fill the schedule picker (epoch ms) — editing a scheduled send. */
	scheduleAtMs?: number;
	/** Hide the surface (X/Esc, and the optimistic close on send). State survives
	 *  until reset() so in-flight saves keep valid refs. */
	requestClose: () => void;
	/** Bring the surface back (a send with nothing persisted reopens instead of
	 *  losing the draft). */
	requestReopen: () => void;
};

export class ComposeSession {
	// ---- state (all $state — surfaces bind/read directly) --------------------
	identities = $state<SendIdentity[]>([]);
	mailboxId = $state<string | undefined>(undefined);
	aliasId = $state<string | null | undefined>(undefined);

	to = $state<string[]>([]);
	cc = $state<string[]>([]);
	bcc = $state<string[]>([]);
	showCc = $state(false);
	showBcc = $state(false);
	subject = $state('');
	body = $state('');
	attachments = $state<AttachmentRef[]>([]);
	editorKey = $state(0);
	// Forwarded messages are referenced by id, not baked into the body. Raw email
	// HTML never reaches the client, so the server composes the real HTML at
	// Send, keeping template fidelity. Surfaces show a read-only preview.
	forwardMessageIds = $state<string[]>([]);
	// Signature-per-mailbox, and the exact signature currently in the editor, so
	// a From change can swap it out. sigReady gates the swap off until the
	// initial seed is in, so the init identity pick doesn't trip it.
	signatures = $state<Map<string, string>>(new Map());
	appliedSig = $state('');
	sigReady = $state(false);

	draftId = $state<string | null>(null);
	clientRevision = $state(0);
	phase = $state<'editing' | 'sending'>('editing');
	saved = $state(false);
	uploading = $state(false);
	scheduleAt = $state('');
	schedulePickerOpen = $state(false);
	// Gmail-style: an empty subject doesn't block the send, it asks first.
	confirmNoSubject = $state(false);

	private readonly options: ComposeSessionOptions;
	readonly title: string;

	constructor(options: ComposeSessionOptions) {
		this.options = options;
		this.title = options.resumeDraftId
			? 'Draft'
			: options.prefill?.kind === 'forward'
				? 'Forward'
				: 'New message';

		// Swap the signature when the From mailbox changes (alias-only changes keep
		// the same mailbox signature, so they no-op). untrack: this reads/writes
		// body + appliedSig but must only re-run on mailboxId.
		$effect(() => {
			const id = this.mailboxId;
			untrack(() => {
				if (!this.sigReady || !id) return;
				const rebuilt = swapSignature(this.body, this.appliedSig, this.signatures.get(id) ?? '');
				if (rebuilt === null || rebuilt === this.body) return;
				this.body = rebuilt;
				this.appliedSig = this.signatures.get(id) ?? '';
				this.editorKey++;
				this.scheduleSave();
			});
		});
	}

	// ---- derived-ish reads (methods — $derived can't live on class fields that
	// close over `this` cleanly across surfaces, and these are cheap) ----------
	get canSend(): boolean {
		return this.phase === 'editing' && !!this.mailboxId && this.to.length + this.cc.length + this.bcc.length > 0;
	}
	/** Why the primary action is blocked — the button's title so a disabled Send
	 *  explains itself instead of just greying out. */
	get sendHint(): string {
		return !this.mailboxId
			? 'Choose a sender first'
			: this.to.length + this.cc.length + this.bcc.length === 0
				? 'Add at least one recipient'
				: this.scheduleAt
					? 'Schedule send'
					: 'Send  (⌘↵)';
	}
	/** The bar for "this is a draft": meaningful content only. Below it nothing
	 *  is persisted (open+close must not mint empty draft rows). Prefilled
	 *  forward content counts — it's resumable state the user chose to start. */
	get hasContent(): boolean {
		return (
			this.subject.trim().length > 0 ||
			this.to.length + this.cc.length + this.bcc.length > 0 ||
			this.attachments.length > 0 ||
			this.body.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0 ||
			this.forwardMessageIds.length > 0
		);
	}
	/** Compact recipient names (the minimized bar / page subtitle). */
	get recipientNames(): string {
		return [...this.to, ...this.cc, ...this.bcc].map((addr) => addr.split('@')[0]).join(', ');
	}

	// ---- init ----------------------------------------------------------------
	init = async (): Promise<void> => {
		sweepMirrors();
		// `?? []`: an awaited remote query can resolve undefined mid-hydration
		// (see mailbox-switcher) — a blank identity list beats a crashed surface.
		const [ids, sigRows] = await Promise.all([sendIdentities(), myMailboxSignatures()]);
		this.identities = ids ?? [];
		this.signatures = new Map((sigRows ?? []).map((row) => [row.mailboxId, row.bodyHtml]));
		const { resumeDraftId, prefill, scheduleAtMs } = this.options;
		if (resumeDraftId) {
			const d = await draftById({ draftId: resumeDraftId });
			this.draftId = d.id;
			this.clientRevision = d.clientRevision;
			this.mailboxId = d.mailboxId;
			this.aliasId = d.fromAliasId;
			this.to = d.to;
			this.cc = d.cc;
			this.bcc = d.bcc;
			this.subject = d.subject ?? '';
			this.body = d.body ?? '';
			this.forwardMessageIds = d.forwardMessageIds ?? [];
			this.attachments = d.attachments;
			this.showCc = d.cc.length > 0;
			this.showBcc = d.bcc.length > 0;
			this.editorKey++;
			// Editing a scheduled send: keep its original time in the picker.
			if (scheduleAtMs) this.armSchedule(new Date(scheduleAtMs));
			this.restoreMirror();
			return;
		}
		if (prefill) {
			this.to = prefill.to ? [prefill.to.toLowerCase()] : [];
			this.subject = prefill.subject ?? '';
			this.body = prefill.body ?? '';
			this.forwardMessageIds = prefill.forwardMessageIds ?? [];
			// The editor only reads `initial` on mount — remount it so a forwarded
			// body actually renders (resume path already does this above).
			this.editorKey++;
		}
		// Default From: the mailbox in context (prefill = the current view/
		// switcher), else the user's personal inbox, else the first available
		// identity. The list is oldest→newest, so without the personal preference
		// a shared/service mailbox could win on age.
		const chosen =
			(prefill?.mailboxId &&
				this.identities.find(
					(identity) =>
						identity.mailboxId === prefill.mailboxId &&
						(identity.aliasId ?? null) === (prefill.fromAliasId ?? null)
				)) ||
			this.identities.find((identity) => identity.available && identity.isPersonal) ||
			this.identities.find((identity) => identity.available);
		if (chosen) {
			this.mailboxId = chosen.mailboxId;
			this.aliasId = chosen.aliasId;
		}
		// Fresh compose only (resume returned early above): append the sender's
		// signature for the chosen mailbox, then remount the editor so it renders.
		if (this.mailboxId) {
			const sig = this.signatures.get(this.mailboxId) ?? '';
			if (sig) {
				this.body = withSignature(this.body, sig);
				this.editorKey++;
			}
			this.appliedSig = sig;
		}
		this.restoreMirror();
		this.sigReady = true; // fresh compose is seeded — a later From change may now swap.
	};

	// ---- crash mirror ----------------------------------------------------------
	// Local-first crash buffer: every edit mirrors synchronously to localStorage
	// (cleared on server ack), so the 800ms debounce window can't lose text.
	// ponytail: key 'new' is shared by concurrent new composes across tabs —
	// last writer wins; key by a session nonce if that ever bites.
	private get mirrorKey(): string {
		return this.options.resumeDraftId ?? 'new';
	}
	private snapshot = () => JSON.stringify([this.body, this.subject, this.to, this.cc, this.bcc]);

	/** A surviving mirror is text the server never acked (tab died / offline
	 *  before the debounce flushed). Pull it back over whatever loaded. */
	private restoreMirror(): void {
		const local = readMirror(this.mirrorKey);
		if (!local) return;
		const text = (local.body ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
		const meaningful =
			text.length > 0 ||
			(local.subject ?? '').trim().length > 0 ||
			(local.to?.length ?? 0) + (local.cc?.length ?? 0) + (local.bcc?.length ?? 0) > 0;
		if (!meaningful) return;
		if (local.body !== undefined) this.body = local.body;
		if (local.subject !== undefined) this.subject = local.subject;
		if (local.to) this.to = local.to;
		if (local.cc) this.cc = local.cc;
		if (local.bcc) this.bcc = local.bcc;
		this.showCc = this.showCc || this.cc.length > 0;
		this.showBcc = this.showBcc || this.bcc.length > 0;
		this.editorKey++;
		toast('Restored unsaved draft');
		this.scheduleSave();
	}

	// ---- autosave --------------------------------------------------------------
	private debouncedSave = useDebounce(() => this.flushSave(), 800);

	scheduleSave = (): void => {
		if (this.phase !== 'editing') return;
		this.saved = false;
		mirrorDraft(this.mirrorKey, {
			body: this.body,
			subject: this.subject,
			to: this.to,
			cc: this.cc,
			bcc: this.bcc
		});
		this.debouncedSave();
	};

	// Single-flight: debounce flush, blur flush, visibilitychange flush, Send and
	// attachment upload can all race here — two concurrent startDraft calls would
	// mint two draft rows and clobber draftId with a stale-content snapshot.
	private draftPending: Promise<string | null> | null = null;
	private ensureDraft(): Promise<string | null> {
		if (this.draftId || !this.mailboxId) return Promise.resolve(this.draftId);
		this.draftPending ??= this.createDraftRow().finally(() => (this.draftPending = null));
		return this.draftPending;
	}
	private async createDraftRow(): Promise<string | null> {
		if (!this.mailboxId) return null;
		const sent = this.snapshot();
		const d = await startDraft({
			mailboxId: this.mailboxId,
			kind: this.options.prefill?.kind === 'forward' ? 'forward' : 'new',
			threadId: this.options.prefill?.threadId ?? null,
			inReplyToMessageId: this.options.prefill?.inReplyToMessageId ?? null,
			to: this.to,
			cc: this.cc,
			bcc: this.bcc,
			subject: this.subject,
			body: this.body,
			forwardMessageIds: this.forwardMessageIds,
			fromAliasId: this.aliasId ?? null
		});
		this.draftId = d.id;
		this.clientRevision = d.clientRevision;
		// Server has this content now, so drop the crash buffer (unless more was
		// typed while the request was in flight).
		if (this.snapshot() === sent) clearMirror(this.mirrorKey);
		return this.draftId;
	}

	// Serialize saves so a debounce-flush, a visibility save, and the send's own
	// flush can't race the same clientRevision (the loser would false-warn
	// "updated in another tab"). Each queued save sees the previous revision.
	private saveChain: Promise<void> = Promise.resolve();
	private enqueueSave(): Promise<void> {
		const run = () => this.doSave();
		this.saveChain = this.saveChain.then(run, run);
		return this.saveChain;
	}
	flushSave = (): Promise<void> => {
		this.debouncedSave.cancel();
		// Don't autosave once we're sending/sent; send() drives its own final save.
		if (this.phase !== 'editing' || !this.mailboxId) return this.saveChain;
		return this.enqueueSave();
	};

	private async doSave(): Promise<void> {
		if (!this.mailboxId) return;
		if (!this.draftId) {
			if (!this.hasContent) return;
			// A create may be in flight — ensure it, then autosave current content.
			await this.ensureDraft();
			if (!this.draftId) return;
		}
		const sent = this.snapshot();
		const res = await autosaveDraft({
			draftId: this.draftId,
			clientRevision: this.clientRevision,
			to: this.to,
			cc: this.cc,
			bcc: this.bcc,
			subject: this.subject,
			body: this.body,
			fromAliasId: this.aliasId ?? null
		});
		if (res.ok) {
			this.clientRevision = res.clientRevision;
			this.saved = true;
			if (this.snapshot() === sent) clearMirror(this.mirrorKey);
		} else {
			// Adopt the winning revision. Mid-send this is our own flush racing a
			// pending autosave (same tab), not a real cross-tab edit, so adopt
			// silently. Otherwise a genuine other-tab edit: swap in the server copy
			// (never overwrite it) and say so — a silent swap reads as data loss.
			const d = res.draft;
			this.clientRevision = d.clientRevision;
			if (this.phase !== 'sending') {
				this.to = d.to;
				this.cc = d.cc;
				this.bcc = d.bcc;
				this.subject = d.subject ?? '';
				this.body = d.body ?? '';
				this.editorKey++;
				toast.warning('Draft updated in another tab — loaded the latest version.');
			}
		}
	}

	// ---- attachments -----------------------------------------------------------
	uploadFiles = async (files: File[]): Promise<void> => {
		if (!files.length) return;
		const id = await this.ensureDraft();
		if (!id) return;
		this.uploading = true;
		try {
			for (const file of files) {
				const fd = new FormData();
				fd.append('draftId', id);
				fd.append('file', file);
				const res = await fetch('/api/drafts/attachments', { method: 'POST', body: fd });
				if (res.ok) this.attachments = ((await res.json()) as { attachments: AttachmentRef[] }).attachments;
			}
		} finally {
			this.uploading = false;
		}
	};

	removeAttachment = async (r2Key: string): Promise<void> => {
		if (!this.draftId) return;
		const res = await detachDraftAttachment({ draftId: this.draftId, r2Key });
		this.attachments = res.attachments;
	};

	// ---- scheduling ------------------------------------------------------------
	// Arming a preset fills the datetime input (reviewable) and flips the primary
	// button to “Schedule”; it doesn't fire immediately.
	armSchedule = (date: Date): void => {
		this.scheduleAt = toLocalDatetime(date);
	};
	clearSchedule = (): void => {
		this.scheduleAt = '';
	};

	// ---- send / undo / close / discard ----------------------------------------
	send = async (force = false): Promise<void> => {
		if (!this.canSend) return;
		// Empty subject: confirm once (Gmail-style), then proceed on the retry.
		if (!force && this.subject.trim().length === 0) {
			this.confirmNoSubject = true;
			return;
		}
		this.phase = 'sending';
		const sendAt = this.scheduleAt ? new Date(this.scheduleAt).getTime() : null;
		// One toast for the whole send, morphing on a single id: Sending… →
		// Queued… → sent (or Scheduling… → scheduled), or an error.
		const sendProgress = sendToast(sendAt ? 'Scheduling…' : 'Sending…');
		// Close the surface immediately (state survives until reset() below), then
		// persist + send in the background — Gmail/Superhuman optimistic close.
		this.options.requestClose();
		// Real final save (enqueueSave bypasses flushSave's editing-only guard);
		// ensures the draft even if its create is still in flight (fast forward+send).
		await this.enqueueSave();
		const id = this.draftId;
		if (!id) {
			// No draft persisted (empty / create failed): reopen so nothing is lost.
			this.phase = 'editing';
			this.options.requestReopen();
			sendProgress.dismiss();
			return;
		}
		const scheduled = sendAt != null && sendAt > Date.now() + UNDO_SECONDS * 1000;
		const whenLabel = scheduled
			? new Date(sendAt!).toLocaleString(undefined, {
					weekday: 'short',
					month: 'short',
					day: 'numeric',
					hour: 'numeric',
					minute: '2-digit'
				})
			: '';
		this.reset();
		try {
			if (!scheduled) sendProgress.queued(); // draft persisted; delivery request in flight
			const res = await sendDraftById({ draftId: id, sendAt, undoSeconds: UNDO_SECONDS });
			if (scheduled) {
				// Scheduled sends have no undo countdown — they sit in Scheduled.
				sendProgress.note(`Scheduled for ${whenLabel}`, {
					label: 'View',
					onClick: () => goto('/app?folder=scheduled')
				});
			} else {
				sendProgress.sent(
					'Message sent',
					{ label: 'Undo', onClick: () => this.undoSend(res.submissionId) },
					UNDO_SECONDS * 1000
				);
			}
		} catch {
			sendProgress.fail('Send failed — your draft is saved in Drafts.');
		}
	};

	private async undoSend(submissionId: string): Promise<void> {
		const res = await undoDraftById({ submissionId });
		if (res.restored && res.draft) {
			compose.start({ resumeDraftId: res.draft.id });
		} else {
			toast.error('Too late to undo — the message already left.');
		}
	}

	/** Esc / ✕: close but keep the draft (autosaved — find it in Drafts). Closing
	 *  is instant: the save/discard runs in the background so the surface doesn't
	 *  hang on a network round-trip. */
	close = (): void => {
		this.debouncedSave.cancel();
		if (this.draftId && !this.hasContent) {
			// Emptied-out draft is no longer a draft: delete the husk.
			clearMirror(this.mirrorKey);
			const id = this.draftId;
			this.draftId = null;
			void discardDraftById({ draftId: id }).catch(() => {});
		} else {
			void this.flushSave();
		}
		this.options.requestClose();
	};

	discard = async (): Promise<void> => {
		this.debouncedSave.cancel();
		if (this.draftId) await discardDraftById({ draftId: this.draftId });
		this.reset();
		this.options.requestClose();
	};

	reset = (): void => {
		clearMirror(this.mirrorKey);
		this.draftId = null;
		this.clientRevision = 0;
		this.phase = 'editing';
		this.to = [];
		this.cc = [];
		this.bcc = [];
		this.subject = '';
		this.body = '';
		this.forwardMessageIds = [];
		this.attachments = [];
		this.showCc = false;
		this.showBcc = false;
		this.saved = false;
		this.scheduleAt = '';
		this.schedulePickerOpen = false;
		this.editorKey++;
	};

	/** ⌘/Ctrl+Enter sends from anywhere in the composer (the editor handles it
	 *  only while focused; this covers To/subject too). The surface decides when
	 *  it's eligible (open, not minimized). */
	handleSendShortcut = (e: KeyboardEvent): boolean => {
		if (this.phase !== 'editing') return false;
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.canSend) {
			e.preventDefault();
			void this.send();
			return true;
		}
		return false;
	};
}
