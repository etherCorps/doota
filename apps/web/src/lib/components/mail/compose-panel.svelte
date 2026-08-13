<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount, untrack } from 'svelte';
	import { useDebounce } from 'runed';
	import { fade } from 'svelte/transition';
	import { fmtSize, isImage } from '$lib/mail/format';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FromSelector from './from-selector.svelte';
	import RecipientInput from './recipient-input.svelte';
	import TiptapEditor from './tiptap-editor.svelte';
	import SchedulePicker from './schedule-picker.svelte';
	import { toLocalDatetime } from '$lib/utils/parse-when';
	import SendIcon from '@lucide/svelte/icons/send';
	import { toast } from 'svelte-sonner';
	import { sendToast } from '$lib/utils/send-toast';
	import { goto } from '$app/navigation';
	import { compose } from '$lib/client/compose.svelte.js';
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
	import MailFrame from './mail-frame.svelte';
	import type { SendIdentity } from '@doota/mail-core/identities';
	import { mirrorDraft, readMirror, clearMirror, sweepMirrors } from '$lib/client/local-draft';
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
		forwardMessageIds?: string[];
	};
	let {
		open = $bindable(false),
		prefill = undefined,
		resumeDraftId = undefined,
		// Pre-fill the schedule picker (epoch ms) — set when editing a scheduled send.
		scheduleAt: scheduleAtMs = undefined,
		// Single-pane mail region (list OR thread): compose in a bottom drawer
		// instead of the docked window / overlay. Passed down from the layout,
		// which measures the content region (same 56rem line as the pane split).
		asDrawer = false,
		// iOS single-pane: a full-screen page sized to the visible viewport instead
		// of a bottom drawer, so the keyboard just shrinks the page (no drawer +
		// keyboard fight). The layout drives its history entry (back-gesture closes).
		iosPage = false
	}: {
		open?: boolean;
		prefill?: Prefill;
		resumeDraftId?: string;
		scheduleAt?: number;
		asDrawer?: boolean;
		iosPage?: boolean;
	} = $props();

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
	// Forwarded messages are referenced by id, not baked into the body. Raw email
	// HTML never reaches the client, so the server composes the real HTML at Send,
	// keeping template fidelity. The composer shows a read-only preview.
	let forwardMessageIds = $state<string[]>([]);
	// Signature-per-mailbox, and the exact signature currently in the editor, so a
	// From change can swap it out (see the $effect below). sigReady gates the swap
	// off until the initial seed is in, so the onMount identity pick doesn't trip it.
	let signatures = $state<Map<string, string>>(new Map());
	let appliedSig = $state('');
	let sigReady = $state(false);
	let minimized = $state(false);
	let maximized = $state(false);
	let fileInput = $state<HTMLInputElement>();

	let draftId = $state<string | null>(null);
	let clientRevision = $state(0);
	let phase = $state<'editing' | 'sending'>('editing');
	// Full-screen centered overlay vs the docked bottom-right popup.
	const bigMode = $derived(maximized && !minimized);
	let uploading = $state(false);
	let saved = $state(false);
	const debouncedSave = useDebounce(() => flushSave(), 800);

	// iOS keyboard. Vaul's own `repositionInputs` shrinks the sheet to
	// `visualViewport - offsetFromTop`, which collapses the editor to a thin strip
	// at the top of the screen. We turn it off (Drawer.Root below) and instead
	// size the sheet to the visible viewport: full height above the keyboard,
	// anchored just over it, so the editor keeps the leftover space.
	// visualViewport is the only signal that reflects the keyboard; rAF-batch its
	// resize/scroll bursts so we set style once per frame, not per event.
	let keyboardInset = $state(0);
	let viewportH = $state(0);
	let viewportTop = $state(0);
	$effect(() => {
		const vv = window.visualViewport;
		if (!vv || (!asDrawer && !iosPage)) return;
		let raf = 0;
		const measure = () => {
			keyboardInset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
			viewportH = Math.round(vv.height);
			viewportTop = Math.round(vv.offsetTop);
		};
		const update = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(measure);
		};
		update();
		vv.addEventListener('resize', update);
		vv.addEventListener('scroll', update);
		return () => {
			cancelAnimationFrame(raf);
			vv.removeEventListener('resize', update);
			vv.removeEventListener('scroll', update);
		};
	});
	// Only override the sheet box while the keyboard is up. `m-2` on the content
	// is 8px each side, so subtract 16 to fit the sheet + margins in the gap.
	const drawerStyle = $derived(
		keyboardInset > 0
			? `height:${Math.max(viewportH - 16, 160)}px;max-height:none;bottom:${keyboardInset}px`
			: undefined
	);
	// iOS page: pin the container to the visible viewport (top+height from
	// visualViewport) so the keyboard shrinks the page and the send bar stays put
	// above it. Before the first measure, fall back to full dynamic height.
	const iosPageStyle = $derived(
		viewportH > 0 ? `top:${viewportTop}px;height:${viewportH}px` : 'top:0;height:100dvh'
	);

	// A surviving mirror is text the server never acked (tab died / offline
	// before the debounce flushed). Pull it back over whatever loaded.
	function restoreMirror() {
		const local = readMirror(mirrorKey);
		if (!local) return;
		const text = (local.body ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
		const meaningful =
			text.length > 0 ||
			(local.subject ?? '').trim().length > 0 ||
			(local.to?.length ?? 0) + (local.cc?.length ?? 0) + (local.bcc?.length ?? 0) > 0;
		if (!meaningful) return;
		if (local.body !== undefined) body = local.body;
		if (local.subject !== undefined) subject = local.subject;
		if (local.to) to = local.to;
		if (local.cc) cc = local.cc;
		if (local.bcc) bcc = local.bcc;
		showCc = showCc || cc.length > 0;
		showBcc = showBcc || bcc.length > 0;
		editorKey++;
		toast('Restored unsaved draft');
		scheduleSave();
	}

	onMount(async () => {
		sweepMirrors();
		// `?? []`: an awaited remote query can resolve undefined mid-hydration
		// (see mailbox-switcher) — a blank identity list beats a crashed panel.
		const [ids, sigRows] = await Promise.all([sendIdentities(), myMailboxSignatures()]);
		identities = ids ?? [];
		signatures = new Map((sigRows ?? []).map((row) => [row.mailboxId, row.bodyHtml]));
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
			forwardMessageIds = d.forwardMessageIds ?? [];
			attachments = d.attachments;
			showCc = d.cc.length > 0;
			showBcc = d.bcc.length > 0;
			editorKey++;
			// Editing a scheduled send: keep its original time in the picker.
			if (scheduleAtMs) armSchedule(new Date(scheduleAtMs));
			restoreMirror();
			return;
		}
		if (prefill) {
			to = prefill.to ? [prefill.to.toLowerCase()] : [];
			subject = prefill.subject ?? '';
			body = prefill.body ?? '';
			forwardMessageIds = prefill.forwardMessageIds ?? [];
			// The editor only reads `initial` on mount — remount it so a forwarded
			// body actually renders (resume path already does this above).
			editorKey++;
		}
		// Default From: the mailbox in context (prefill = the current view/switcher),
		// else the user's personal inbox, else the first available identity. The list
		// is oldest→newest, so without the personal preference a shared/service
		// mailbox could win on age.
		const chosen =
			(prefill?.mailboxId &&
				identities.find(
					(identity) => identity.mailboxId === prefill.mailboxId && (identity.aliasId ?? null) === (prefill.fromAliasId ?? null)
				)) ||
			identities.find((identity) => identity.available && identity.isPersonal) ||
			identities.find((identity) => identity.available);
		if (chosen) {
			mailboxId = chosen.mailboxId;
			aliasId = chosen.aliasId;
		}
		// Fresh compose only (resume returned early above): append the sender's
		// signature for the chosen mailbox to the initial editor body, then remount
		// so it renders. Editing the identity later doesn't re-swap it (v1).
		if (mailboxId) {
			const sig = signatures.get(mailboxId) ?? '';
			if (sig) {
				body = withSignature(body, sig);
				editorKey++;
			}
			appliedSig = sig;
		}
		restoreMirror();
		sigReady = true; // fresh compose is seeded — a later From change may now swap.
	});

	// Swap the signature when the From mailbox changes (alias-only changes keep the
	// same mailbox signature, so they no-op). untrack: this reads/writes body +
	// appliedSig but must only re-run on mailboxId.
	$effect(() => {
		const id = mailboxId;
		untrack(() => {
			if (!sigReady || !id) return;
			const rebuilt = swapSignature(body, appliedSig, signatures.get(id) ?? '');
			if (rebuilt === null || rebuilt === body) return;
			body = rebuilt;
			appliedSig = signatures.get(id) ?? '';
			editorKey++;
			scheduleSave();
		});
	});

	const canSend = $derived(phase === 'editing' && !!mailboxId && to.length + cc.length + bcc.length > 0);
	// Why the primary action is blocked, surfaced as the button's title so a
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
	// Gmail-style: an empty subject doesn't block the send, it asks first.
	let confirmNoSubject = $state(false);

	// Schedule-send presets. Arming one fills the datetime input (reviewable) and
	// flips the primary button to “Schedule”; it doesn't fire immediately.
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

	// Local-first crash buffer: every edit mirrors synchronously to localStorage
	// (cleared on server ack), so the 800ms debounce window can't lose text.
	// ponytail: key 'new' is shared by concurrent new composes across tabs —
	// last writer wins; key by a session nonce if that ever bites.
	const mirrorKey = $derived(resumeDraftId ?? 'new');
	const snapshot = () => JSON.stringify([body, subject, to, cc, bcc]);

	function scheduleSave() {
		if (phase !== 'editing') return;
		saved = false;
		mirrorDraft(mirrorKey, { body, subject, to, cc, bcc });
		debouncedSave();
	}

	// The bar for "this is a draft": the session has meaningful content —
	// a subject, a recipient, body text, or an attachment. Below that bar nothing
	// is persisted (open+close must not mint empty draft rows), and a draft the
	// user empties out is deleted on close. Prefilled forward/reply content
	// counts: it's resumable state the user chose to start.
	const hasContent = $derived(
		subject.trim().length > 0 ||
			to.length + cc.length + bcc.length > 0 ||
			attachments.length > 0 ||
			body.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0 ||
			forwardMessageIds.length > 0
	);

	// Single-flight: debounce flush, blur flush, visibilitychange flush, Send and
	// attachment upload can all race here — two concurrent startDraft calls would
	// mint two draft rows and clobber draftId with a stale-content snapshot.
	let draftPending: Promise<string | null> | null = null;
	function ensureDraft(): Promise<string | null> {
		if (draftId || !mailboxId) return Promise.resolve(draftId);
		draftPending ??= createDraftRow().finally(() => (draftPending = null));
		return draftPending;
	}
	async function createDraftRow(): Promise<string | null> {
		if (!mailboxId) return null;
		const sent = snapshot();
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
			forwardMessageIds,
			fromAliasId: aliasId ?? null
		});
		draftId = d.id;
		clientRevision = d.clientRevision;
		// Server has this content now, so drop the crash buffer (unless more was
		// typed while the request was in flight).
		if (snapshot() === sent) clearMirror(mirrorKey);
		return draftId;
	}

	// Serialize saves so a debounce-flush, a visibility save, and the send's own
	// flush can't race the same clientRevision (the loser would false-warn "updated
	// in another tab"). Each queued save sees the previous one's bumped revision.
	let saveChain: Promise<void> = Promise.resolve();
	function enqueueSave(): Promise<void> {
		saveChain = saveChain.then(doSave, doSave);
		return saveChain;
	}
	function flushSave(): Promise<void> {
		debouncedSave.cancel();
		// Don't autosave once we're sending/sent; send() drives its own final save.
		if (phase !== 'editing' || !mailboxId) return saveChain;
		return enqueueSave();
	}

	async function doSave() {
		if (!mailboxId) return;
		if (!draftId) {
			if (!hasContent) return;
			// A create may be in flight — ensure it, then autosave the current content.
			await ensureDraft();
			if (!draftId) return;
		}
		const sent = snapshot();
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
			if (snapshot() === sent) clearMirror(mirrorKey);
		} else {
			// Adopt the winning revision. Mid-send this is our own flush racing a
			// pending autosave (same tab), not a real cross-tab edit, so adopt
			// silently. Otherwise a genuine other-tab edit: swap in the server copy
			// (never overwrite it) and say so, since a silent swap reads as data loss.
			const d = res.draft;
			clientRevision = d.clientRevision;
			if (phase !== 'sending') {
				to = d.to;
				cc = d.cc;
				bcc = d.bcc;
				subject = d.subject ?? '';
				body = d.body ?? '';
				editorKey++;
				toast.warning('Draft updated in another tab — loaded the latest version.');
			}
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
		uploadFiles([...e.dataTransfer.files]);
	}

	async function removeAttachment(r2Key: string) {
		if (!draftId) return;
		const res = await detachDraftAttachment({ draftId, r2Key });
		attachments = res.attachments;
	}

	async function send(force = false) {
		if (!canSend) return;
		// Empty subject: confirm once (Gmail-style), then proceed on the retry.
		if (!force && subject.trim().length === 0) {
			confirmNoSubject = true;
			return;
		}
		phase = 'sending';
		const sendAt = scheduleAt ? new Date(scheduleAt).getTime() : null;
		// One toast for the whole send, morphing on a single id: Sending… → Queued…
		// → sent (or Scheduling… → scheduled), or an error.
		const sendProgress = sendToast(sendAt ? 'Scheduling…' : 'Sending…');
		// Close the drawer immediately (state survives until reset() below), then
		// persist + send in the background — Gmail/Superhuman-style optimistic close.
		open = false;
		// Real final save (enqueueSave bypasses flushSave's editing-only guard);
		// ensures the draft even if its create is still in flight (fast forward+send).
		await enqueueSave();
		const id = draftId;
		if (!id) {
			// No draft persisted (empty / create failed): reopen so nothing is lost.
			phase = 'editing';
			open = true;
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
		reset();
		open = false;
		try {
			if (!scheduled) sendProgress.queued(); // draft persisted; delivery request now in flight
			const res = await sendDraftById({ draftId: id, sendAt, undoSeconds: UNDO_SECONDS });
			if (scheduled) {
				// Scheduled sends have no undo countdown — they sit in the Scheduled folder.
				sendProgress.note(`Scheduled for ${whenLabel}`, {
					label: 'View',
					onClick: () => goto('/app?folder=scheduled')
				});
			} else {
				sendProgress.sent(
					'Message sent',
					{ label: 'Undo', onClick: () => undoSend(res.submissionId) },
					UNDO_SECONDS * 1000
				);
			}
		} catch {
			sendProgress.fail('Send failed — your draft is saved in Drafts.');
		}
	}

	async function undoSend(submissionId: string) {
		const res = await undoDraftById({ submissionId });
		if (res.restored && res.draft) {
			compose.start({ resumeDraftId: res.draft.id });
		} else {
			toast.error('Too late to undo — the message already left.');
		}
	}

	// Esc / X / overlay: close but keep the draft (autosaved — find it in Drafts).
	// Closing is instant: the save/discard runs in the background so the panel
	// doesn't hang on a network round-trip. State isn't reset here, so the in-flight
	// call keeps valid refs; the next compose remounts fresh via the nonce.
	function close() {
		debouncedSave.cancel();
		if (draftId && !hasContent) {
			// Emptied-out draft is no longer a draft: delete the husk instead of saving it.
			clearMirror(mirrorKey);
			const id = draftId;
			draftId = null;
			void discardDraftById({ draftId: id }).catch(() => {});
		} else {
			void flushSave();
		}
		open = false;
	}

	async function discard() {
		debouncedSave.cancel();
		if (draftId) await discardDraftById({ draftId });
		reset();
		open = false;
	}

	function reset() {
		clearMirror(mirrorKey);
		draftId = null;
		clientRevision = 0;
		phase = 'editing';
		to = [];
		cc = [];
		bcc = [];
		subject = '';
		body = '';
		forwardMessageIds = [];
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

	// Click an attachment → images preview in a lightbox, everything else downloads.
	let preview = $state<AttachmentRef | null>(null);
	const ext = (attachment: AttachmentRef) => (attachment.filename.split('.').pop() ?? 'file').toUpperCase().slice(0, 4);

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
		draftId ? `/api/drafts/attachments?draftId=${draftId}&key=${encodeURIComponent(attachment.r2Key)}` : '';
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

	// Compact recipient names for the minimized bar.
	const recipientNames = $derived(
		[...to, ...cc, ...bcc].map((addr) => addr.split('@')[0]).join(', ')
	);
</script>

<svelte:window onkeydown={onWindowKey} />
<!-- Tab going hidden is the last reliable moment to reach the network, so flush
     immediately instead of waiting out the debounce (best-effort; the local
     mirror covers whatever doesn't make it). -->
<svelte:document
	onvisibilitychange={() => {
		if (open && document.visibilityState === 'hidden') void flushSave();
	}}
/>

<!-- The panel interior (attachments rail + editor column) is one snippet shared
     by the three containers: docked window, full-screen overlay, bottom drawer.
     `drawer` disables the minimize/maximize chrome; the drawer swipes instead. -->
{#snippet panelInner(drawer: boolean)}
			<!-- Expanded mode keeps the rail mounted even when empty, so the first
			     attachment doesn't reflow the editor column. -->
			{#if drawer ? attachments.length > 0 : !minimized && (bigMode || attachments.length)}
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
						{#each attachments as attachment (attachment.r2Key)}
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
											<span class="text-[10px] font-semibold tracking-wide {m.fg}">{ext(attachment)}</span>
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
									onclick={() => removeAttachment(attachment.r2Key)}
								>
									<XIcon class="size-3.5" />
								</button>
							</div>
						{/each}
					</div>
				</aside>
			{/if}

			<div
				class="relative flex flex-col {drawer || bigMode ? 'min-w-0 flex-1' : 'w-full md:w-[min(94vw,30rem)]'}"
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
			<button type="button" class="min-w-0 flex-1 text-left" onclick={() => drawer || (minimized = !minimized)}>
				<span class="font-heading truncate text-sm font-medium">{title}</span>
			</button>
			<div class="text-muted-foreground flex items-center gap-0.5">
				{#if !minimized && !drawer}
					<button type="button" class="hover:bg-foreground/10 hover:text-foreground grid size-6 place-items-center rounded transition-colors" title={maximized ? 'Exit full screen' : 'Full screen'} onclick={() => (maximized = !maximized)}>
						{#if maximized}<Minimize2Icon class="size-3.5" />{:else}<Maximize2Icon class="size-3.5" />{/if}
					</button>
				{/if}
				{#if !drawer}
					<button type="button" class="hover:bg-foreground/10 hover:text-foreground grid size-6 place-items-center rounded transition-colors" title={minimized ? 'Expand' : 'Minimize'} onclick={() => (minimized = !minimized)}>
						{#if minimized}<ChevronUpIcon class="size-4" />{:else}<MinusIcon class="size-4" />{/if}
					</button>
				{/if}
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
				<!-- Body fills the fixed-height panel; the editor flexes so nothing
				     shifts. overflow-y-auto is the small-screen escape valve: with the
				     iOS keyboard up the panel can be ~350px tall, and the fixed rows
				     (From/To/Cc/Bcc, subject, forward preview) can exceed that — without
				     a scroll container they crushed the editor to zero and pushed the
				     send bar out of the panel. Now the middle scrolls (Gmail-style: the
				     header rows scroll away while you type) and the send bar, a sibling
				     below, stays pinned. -->
				<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-3">
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

					<!-- min-h-36 is the typing-area floor: the editor still flexes to fill
					     spare height, but can no longer be crushed to nothing when the
					     rows above outgrow a keyboard-shrunken panel — the body scrolls
					     instead (see the container above). -->
					<div class="min-h-36 flex-1 pb-2">
						{#key editorKey}
							<TiptapEditor
								fill
								focusStart
								initial={body}
								oninput={(html) => {
									body = html;
									scheduleSave();
								}}
								onattach={() => fileInput?.click()}
								onsend={() => send()}
							/>
						{/key}
					</div>

					{#if forwardMessageIds.length}
						<!-- Forwarded messages — read-only preview via the same sandboxed
						     renderer used to read mail, so the template shows as it'll
						     send. Composed for real (from R2) server-side at Send. -->
						<div class="mt-1 max-h-64 shrink-0 overflow-y-auto rounded-md border">
							<div class="text-muted-foreground bg-muted/40 sticky top-0 border-b px-2 py-1 text-xs">
								Forwarding {forwardMessageIds.length}
								{forwardMessageIds.length === 1 ? 'message' : 'messages'} · original formatting kept
							</div>
							<div class="flex flex-col gap-2 p-2">
								{#each forwardMessageIds as messageId (messageId)}
									<MailFrame src={`/api/messages/${messageId}/body`} collapse fadeClass="from-background" />
								{/each}
							</div>
						</div>
					{/if}

					{#if attachments.length}
						<!-- Mobile fallback: a rail won't fit at 94vw, so dock chips at the bottom. -->
						<div class="max-h-24 shrink-0 overflow-y-auto pb-1 md:hidden">
							<div class="flex flex-wrap gap-2">
								{#each attachments as attachment (attachment.r2Key)}
									<span class="bg-muted flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
										<PaperclipIcon class="text-muted-foreground size-3" />
										<span class="max-w-[14ch] truncate">{attachment.filename}</span>
										<span class="text-faint">{fmtSize(attachment.size)}</span>
										<button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => removeAttachment(attachment.r2Key)}>
											<XIcon class="size-3" />
										</button>
									</span>
								{/each}
							</div>
						</div>
					{/if}
				</div>

				<div class="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
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
						<Button variant="brand" size="sm" class="gap-1.5 rounded-r-none" disabled={!canSend || phase === 'sending'} title={sendHint} onclick={() => send()}>
							{#if phase === 'sending'}
								<Spinner class="size-4" /> Sending…
							{:else}
								<SendIcon class="size-4" /> {scheduleAt ? 'Schedule' : 'Send'}
							{/if}
						</Button>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button {...props} variant="brand" size="sm" class="border-brand-foreground/25 rounded-l-none border-l px-1.5" disabled={!canSend || phase === 'sending'} title="Schedule send" aria-label="Schedule send">
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
		<input bind:this={fileInput} type="file" multiple class="hidden" onchange={onFiles} />
		</div>
{/snippet}

<AlertDialog.Root bind:open={confirmNoSubject}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Send without a subject?</AlertDialog.Title>
			<AlertDialog.Description>This message has no subject line.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Add subject</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => send(true)}>Send anyway</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

{#if open}
	{#if asDrawer}
		<!-- Single-pane region: bottom drawer, ~full height so typing space matches
		     the full-screen panel. Swipe-down/Esc close keeps the draft (autosave). -->
		<!-- repositionInputs off: vaul's keyboard resize collapses the sheet, so we
		     size it ourselves via drawerStyle (visible viewport above the keyboard). -->
		<Drawer.Root open={true} repositionInputs={false} onOpenChange={(v) => { if (!v) close(); }}>
			<!-- interactOutsideBehavior="ignore": a stray tap outside must not dismiss
			     mid-composition; closing is deliberate (swipe, Esc, or the ✕). -->
			<Drawer.Content
				interactOutsideBehavior="ignore"
				class="h-[94svh] p-0 data-[vaul-drawer-direction=bottom]:max-h-[94svh]"
				style={drawerStyle}
			>
				<div class="mt-2 flex min-h-0 flex-1 items-stretch overflow-hidden">
					{@render panelInner(true)}
				</div>
			</Drawer.Content>
		</Drawer.Root>
	{:else if iosPage}
		<!-- iOS full-screen page: fixed to the visible viewport (keyboard-safe), no
		     drawer. The layout owns the history entry so the back-gesture closes it.
		     Top/bottom safe-area padding keeps the header (✕) clear of the status
		     bar / Dynamic Island and the home indicator in standalone PWA mode. -->
		<div
			class="bg-background fixed inset-x-0 z-50 flex flex-col overflow-hidden overscroll-contain pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
			style={iosPageStyle}
		>
			<div class="flex min-h-0 flex-1 items-stretch overflow-hidden">
				{@render panelInner(true)}
			</div>
		</div>
	{:else}
		{#if bigMode}
			<!-- Dim the mail view behind; clicking it closes (keeps the draft). -->
			<button type="button" class="bg-scrim/30 absolute inset-0 z-20" aria-label="Close composer" onclick={close}></button>
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
				{@render panelInner(false)}
			</div>
		</div>
	{/if}
{/if}

<!-- Image preview lightbox (Gmail-style): click backdrop or Esc to close. -->
{#if preview}
	<!-- use:portal — in drawer mode this renders inside vaul's transformed
	     content, where position:fixed pins to the drawer instead of the viewport. -->
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
