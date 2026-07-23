<script lang="ts">
	import { onMount } from 'svelte';
	import { mode } from 'mode-watcher';
	import { PersistedState, watch } from 'runed';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteSet } from 'svelte/reactivity';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ReplyComposer from '$lib/components/mail/reply-composer.svelte';
	import NoteComposer from '$lib/components/mail/note-composer.svelte';
	import { compose } from '$lib/client/compose.svelte.js';
	import EmptyState from '$lib/components/mail/empty-state.svelte';
	import SenderAvatar from '$lib/components/mail/sender-avatar.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { myMailboxes, myManagedMailboxIds } from '$lib/rpc/mailbox.remote';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import {
		mailboxThreads,
		openThread,
		markThreadRead,
		moveThread,
		starThread,
		mailboxMembers,
		assignThread,
		editNoteById,
		deleteNoteById,
		bulkMoveThreads,
		bulkMarkRead,
		emptyFolder
	} from '$lib/rpc/thread.remote';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { toast } from 'svelte-sonner';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import { sendIdentities, myDrafts, scheduledSends, undoDraftById, discardDrafts } from '$lib/rpc/draft.remote';
	import type { SendIdentity } from '@doota/mail-core/identities';
	import type { MessageDTO } from '@doota/mail-core/mail-thread-contract';
	import type { ThreadSummary } from '@doota/mail-core/read';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SendIcon from '@lucide/svelte/icons/send';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ForwardIcon from '@lucide/svelte/icons/forward';
	import StarIcon from '@lucide/svelte/icons/star';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import InboxDownIcon from '@lucide/svelte/icons/inbox';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CheckCheckIcon from '@lucide/svelte/icons/check-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import Rows3Icon from '@lucide/svelte/icons/rows-3';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import XIcon from '@lucide/svelte/icons/x';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { searchMail } from '$lib/rpc/search.remote';
	import { fly } from 'svelte/transition';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';

	const FOLDERS = [
		{ id: 'inbox', name: 'Inbox', icon: InboxIcon },
		{ id: 'sent', name: 'Sent', icon: SendIcon },
		{ id: 'drafts', name: 'Drafts', icon: FileTextIcon },
		{ id: 'scheduled', name: 'Scheduled', icon: ClockIcon },
		{ id: 'archived', name: 'Archive', icon: ArchiveIcon },
		{ id: 'spam', name: 'Spam', icon: ShieldAlertIcon },
		{ id: 'trash', name: 'Trash', icon: Trash2Icon }
	] as const;

	let mailboxes = $state<{ id: string; address: string; displayName: string | null }[]>([]);
	let identities = $state<SendIdentity[]>([]);
	onMount(async () => {
		[mailboxes, identities] = await Promise.all([myMailboxes(), sendIdentities()]);
	});

	// URL is the source of truth — shareable, back-button, and lets the sidebar
	// switcher drive this view by navigation.
	const params = $derived(page.url.searchParams);
	const mailboxId = $derived(params.get('mailbox') ?? mailboxes[0]?.id ?? null);
	const placement = $derived(params.get('folder') ?? 'inbox');
	const threadId = $derived(params.get('thread'));
	const isVirtual = $derived(placement === 'drafts' || placement === 'scheduled');
	const activeMailbox = $derived(mailboxes.find((m) => m.id === mailboxId));
	const managedIdsQ = myManagedMailboxIds();
	const canManageActive = $derived(!!mailboxId && (managedIdsQ.current ?? []).includes(mailboxId));
	const folder = $derived(FOLDERS.find((f) => f.id === placement) ?? FOLDERS[0]);

	// Folder-specific empty states — a Compose button only where starting a new
	// message is the natural next step; trash/spam/archive just explain themselves.
	const EMPTY_COPY: Record<string, { title: string; desc: string; compose?: boolean }> = {
		inbox: { title: 'Inbox zero', desc: 'New mail lands here.', compose: true },
		sent: { title: 'Nothing sent yet', desc: 'Messages you send appear here.', compose: true },
		archived: { title: 'No archived mail', desc: 'Archive conversations to tuck them away without deleting them.' },
		spam: { title: 'No spam', desc: 'Suspicious mail is quarantined here.' },
		trash: { title: 'Trash is empty', desc: 'Deleted conversations end up here.' }
	};

	// Full search-results mode (?q=): the palette shows the top hits; "view all"
	// lands here, where the list pane becomes the results list. Searches ALL
	// accessible mailboxes — deliberately not scoped to the active one, so
	// opening a hit (which switches ?mailbox) can't reshuffle the results.
	const searchQ = $derived(params.get('q'));
	const searchResultsQ = $derived(
		searchQ && searchQ.trim().length >= 2 ? searchMail({ q: searchQ.trim(), limit: 100 }) : null
	);

	function nav(next: Record<string, string | null>) {
		const sp = new URLSearchParams(params);
		for (const [k, v] of Object.entries(next)) v === null ? sp.delete(k) : sp.set(k, v);
		goto(`?${sp}`, { keepFocus: true, noScroll: true });
	}

	const threadQ = $derived(mailboxId && threadId && !isVirtual ? openThread({ mailboxId, threadId }) : null);
	// Open-thread pane renders from `.current` so a refresh() updates in place
	// instead of blanking (which read like a full reload).
	const openDto = $derived(threadQ?.current ?? null);

	// Thread list — infinite scroll. Pages accumulate into `items`; the next page
	// loads when the list nears the bottom, and the list resets when the mailbox
	// or folder changes. Common actions patch `items` in place (no refetch/flash).
	const PAGE = 30;
	let items = $state<ThreadSummary[]>([]);
	let nextOffset = $state(0);
	let reachedEnd = $state(false);
	let loadingList = $state(false);

	async function loadThreads(reset: boolean) {
		if (!mailboxId || isVirtual || loadingList) return;
		if (!reset && reachedEnd) return;
		loadingList = true;
		try {
			const offset = reset ? 0 : nextOffset;
			const page = await mailboxThreads({ mailboxId, placement: placement as never, offset });
			items = reset ? page : [...items, ...page];
			nextOffset = offset + page.length;
			reachedEnd = page.length < PAGE;
		} finally {
			loadingList = false;
		}
	}

	// Reset + load page 0 when mailbox/folder changes. `watch` tracks only its
	// sources, so the loader's own state writes can't retrigger it.
	watch(
		[() => mailboxId, () => isVirtual, () => placement],
		([mb, virt]) => {
			draftSel.clear();
			threadSel.clear();
			if (mb && !virt) loadThreads(true);
			else {
				items = [];
				nextOffset = 0;
				reachedEnd = false;
			}
		}
	);

	// Thread multi-select — checkbox column; the filter rail becomes the action
	// toolbar while anything is selected. Bulk mutations patch `items` in place
	// like the single-thread actions do (no refetch/flash).
	const threadSel = new SvelteSet<string>();
	let bulkBusy = $state(false);
	async function bulkMove(pl: 'inbox' | 'archived' | 'spam' | 'trash') {
		if (!mailboxId || bulkBusy) return;
		const ids = [...threadSel];
		bulkBusy = true;
		try {
			await bulkMoveThreads({ mailboxId, threadIds: ids, placement: pl });
			items = items.filter((t) => !threadSel.has(t.threadId));
			if (threadId && threadSel.has(threadId)) nav({ thread: null });
			threadSel.clear();
		} finally {
			bulkBusy = false;
		}
	}
	async function bulkRead(read: boolean) {
		if (!mailboxId || bulkBusy) return;
		const ids = [...threadSel];
		bulkBusy = true;
		try {
			await bulkMarkRead({ mailboxId, threadIds: ids, read });
			items = items.map((t) => (threadSel.has(t.threadId) ? { ...t, unread: !read } : t));
			threadSel.clear();
		} finally {
			bulkBusy = false;
		}
	}

	// "Empty trash/spam" — hides everything at the placement (no hard delete).
	async function emptyCurrentFolder() {
		if (!mailboxId || (placement !== 'trash' && placement !== 'spam')) return;
		await emptyFolder({ mailboxId, placement });
		items = [];
		threadSel.clear();
		if (threadId) nav({ thread: null });
		toast.success(`${folder.name} emptied.`);
	}

	// Drafts multi-select. Single-row delete goes through the same bulk call.
	const draftSel = new SvelteSet<string>();
	let deletingDrafts = $state(false);
	async function deleteDrafts(ids: string[]) {
		deletingDrafts = true;
		try {
			await discardDrafts({ draftIds: ids });
			for (const id of ids) draftSel.delete(id);
			await myDrafts().refresh();
		} finally {
			deletingDrafts = false;
		}
	}

	// Closing the composer (send, discard, or plain close) refreshes the virtual
	// lists it feeds — Drafts and Scheduled were serving cached results until a
	// full navigation.
	watch(
		[() => compose.open],
		(cur, prev) => {
			if (prev?.[0] && !cur[0]) {
				if (placement === 'drafts') void myDrafts().refresh();
				if (placement === 'scheduled') void scheduledSends().refresh();
			}
		}
	);

	function onListScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) loadThreads(false);
	}

	/** Patch one loaded row in place — avoids a full refetch (and its flash). */
	function patchItem(id: string, patch: Partial<ThreadSummary>) {
		items = items.map((t) => (t.threadId === id ? { ...t, ...patch } : t));
	}

	async function refresh() {
		await threadQ?.refresh();
		await loadThreads(true);
	}

	// Collaboration layer (Task 5). Members drive "is this a shared mailbox?" —
	// personal mailboxes (1 member) show none of this UI.
	const currentUserId = $derived(page.data.user?.id ?? '');
	const membersQ = $derived(mailboxId && !isVirtual ? mailboxMembers(mailboxId) : null);
	const members = $derived(membersQ?.current ?? []);
	// A shared mailbox (>1 member) shows the collab UI; a personal mailbox shows none.
	const isShared = $derived(members.length > 1);
	let composeMode = $state<'reply' | 'note'>('reply');
	let assignFilter = $state<'all' | 'mine' | 'unassigned'>('all');
	// Quick filters narrow the loaded pages client-side (ponytail: filters what's
	// fetched, not the whole mailbox — server-side filtering if that ever bites).
	let quickFilter = $state<'all' | 'unread' | 'starred'>('all');
	const filtersActive = $derived(quickFilter !== 'all' || assignFilter !== 'all');

	function applyListFilters<
		T extends { assigneeUserId: string | null; unread: boolean; isStarred: boolean }
	>(rows: T[]): T[] {
		let out = rows;
		if (assignFilter === 'mine') out = out.filter((r) => r.assigneeUserId === currentUserId);
		else if (assignFilter === 'unassigned') out = out.filter((r) => !r.assigneeUserId);
		if (quickFilter === 'unread') out = out.filter((r) => r.unread);
		else if (quickFilter === 'starred') out = out.filter((r) => r.isStarred);
		return out;
	}
	async function assign(userId: string | null) {
		if (!mailboxId || !threadId) return;
		const id = threadId;
		await assignThread({ mailboxId, threadId: id, assigneeUserId: userId });
		patchItem(id, { assigneeUserId: userId });
		await threadQ?.refresh();
	}
	async function removeNote(noteId: string) {
		await deleteNoteById({ noteId });
		await refresh();
	}
	async function editNotePrompt(noteId: string, currentBody: string) {
		const next = prompt('Edit note', currentBody);
		if (next && next.trim() && next !== currentBody) {
			await editNoteById({ noteId, body: next });
			await refresh();
		}
	}
	const short = (id: string, members: { userId: string; name: string }[]) =>
		members.find((m) => m.userId === id)?.name ?? 'someone';

	// Open a thread and mark it read (clears the unread dot).
	async function selectThread(id: string) {
		nav({ thread: id });
		if (mailboxId) {
			await markThreadRead({ mailboxId, threadId: id });
			patchItem(id, { unread: false });
		}
	}

	// Triage: move to a placement (archive/spam/trash/inbox), then leave the thread.
	async function move(placement: string) {
		if (!mailboxId || !threadId) return;
		const id = threadId;
		await moveThread({ mailboxId, threadId: id, placement: placement as never });
		nav({ thread: null });
		// The thread left this folder — drop it from the list without a refetch.
		items = items.filter((t) => t.threadId !== id);
	}
	async function toggleStar(current: boolean) {
		if (!mailboxId || !threadId) return;
		const id = threadId;
		await starThread({ mailboxId, threadId: id, starred: !current });
		patchItem(id, { isStarred: !current });
		await threadQ?.refresh();
	}

	// Reply context (computed from the loaded thread).
	function replyCtx(msgs: MessageDTO[]) {
		const lastInbound = [...msgs].reverse().find((m) => !m.submission);
		const parent = msgs.at(-1);
		const target = lastInbound?.replyTo || lastInbound?.from || parent?.from || '';
		const self = new Set(identities.map((i) => i.address.toLowerCase()));
		const notSelf = (a: string) => a && !self.has(a.toLowerCase());
		const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
		const toAll = uniq([target, ...(lastInbound?.to ?? [])]).filter(notSelf);
		const ccAll = uniq(lastInbound?.cc ?? []).filter((a) => notSelf(a) && !toAll.includes(a));
		return { target, toAll, ccAll, aliasId: lastInbound?.viaAliasId ?? null, parent };
	}

	// Remote images (tracking pixels) are blocked by default via CSP inside the
	// sandboxed iframe; the user can opt in per message. The doc body is
	// transparent with a mode-matched text color, so plain emails follow the app
	// theme (the iframe element paints bg-card); emails that hardcode their own
	// background keep it — same stance as Gmail's "original" view.
	const loadedImages = new SvelteSet<string>();
	function frameDoc(html: string, allowRemote: boolean, dark: boolean): string {
		const imgSrc = allowRemote ? 'img-src data: https:;' : 'img-src data:;';
		const csp = `default-src 'none'; ${imgSrc} style-src 'unsafe-inline'; font-src data:; media-src data:;`;
		const color = dark ? '#e8e8ee' : '#25252c';
		return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width">${dark ? '<meta name="color-scheme" content="dark">' : ''}</head><body style="margin:0;font:14px system-ui,sans-serif;background:transparent;color:${color}">${html}</body></html>`;
	}

	function fmtTime(ms: number | null): string {
		if (!ms) return '';
		return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}

	// Sender identity for list rows + message monograms. `from` is a raw header
	// ("Name <addr>" or a bare address); pull a human name + two-letter initials,
	// and tint the monogram deterministically so a sender keeps the same colour.
	function senderName(from: string | null): string {
		if (!from) return 'Unknown';
		const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
		if (named?.[1]?.trim()) return named[1].trim();
		return from.split('@')[0]?.replace(/[._-]+/g, ' ').trim() || from;
	}

	// Two conversation renderings, user-switchable + persisted: 'chat' (default —
	// WhatsApp-style bubbles, reads as a communication flow) and 'mail' (Gmail-style
	// collapsible card stack, reads as correspondence).
	const threadView = new PersistedState<'chat' | 'mail'>('doota:thread-view', 'chat');

	// Day dividers for the chat view (WhatsApp-style). Items are a mixed union;
	// each type carries its timestamp under a different key.
	function itemMs(it: unknown): number | null {
		const o = it as { sentAt?: number | null; at?: number | null; createdAt?: number | null };
		return o.sentAt ?? o.at ?? o.createdAt ?? null;
	}
	function isNewDay(items: unknown[], i: number): boolean {
		const ms = itemMs(items[i]);
		if (ms == null) return false;
		for (let j = i - 1; j >= 0; j--) {
			const prev = itemMs(items[j]);
			if (prev != null) return new Date(ms).toDateString() !== new Date(prev).toDateString();
		}
		return true;
	}
	const fmtDay = (ms: number) =>
		new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

	// Land on the newest message when a thread opens (or the view flips): chat
	// scrolls to the bottom, mail brings the newest card's header into view.
	// Keyed on thread id — a refresh() of the same thread never yanks the scroll.
	let streamEl = $state<HTMLElement>();
	$effect(() => {
		const id = openDto?.id;
		const view = threadView.current;
		if (!id || !streamEl) return;
		requestAnimationFrame(() => {
			streamEl
				?.querySelector('[data-newest="true"]')
				?.scrollIntoView(view === 'chat' ? { block: 'end' } : { block: 'start' });
		});
	});

	// Gmail-style collapse (mail view): every message except the newest starts
	// collapsed; clicking a header toggles it. Effective state = default XOR
	// toggled, so no seeding pass is needed and thread switches stay stateless.
	const msgToggles = new SvelteSet<string>();
	const msgOpen = (id: string, isLast: boolean) => isLast !== msgToggles.has(id);
	function toggleMsg(id: string) {
		if (msgToggles.has(id)) msgToggles.delete(id);
		else msgToggles.add(id);
	}
	/** First text line of a message, for the collapsed-header preview. */
	function msgSnippet(m: MessageDTO): string {
		return (m.bodyStripped ?? m.bodyFull ?? '').split('\n').find((l) => l.trim()) ?? '';
	}

	// Thread attachments panel — every attachment in the open thread, grouped by
	// day (messages are chronological, so consecutive-day grouping is enough).
	// ≥ md it docks beside the stream; < md it's a bottom drawer.
	let attachmentsOpen = $state(false);
	const isMobile = new IsMobile();
	function senderEmail(from: string | null): string {
		return from?.match(/<([^>]+)>/)?.[1] ?? from ?? '';
	}
	// Grouped day → message, so a message's files stay together as one tile grid.
	function groupAttachments(msgs: MessageDTO[]) {
		const days: { day: string; entries: { msg: MessageDTO; atts: MessageDTO['attachments'] }[] }[] = [];
		for (const msg of msgs) {
			if (!msg.attachments.length) continue;
			const day = msg.sentAt ? fmtDay(msg.sentAt) : 'Unknown date';
			let d = days.at(-1);
			if (!d || d.day !== day) {
				d = { day, entries: [] };
				days.push(d);
			}
			d.entries.push({ msg, atts: msg.attachments });
		}
		return days;
	}
	const isImage = (a: { contentType: string | null }) => !!a.contentType?.startsWith('image/');
	const fileExt = (name: string | null) => name?.match(/\.(\w{1,5})$/)?.[1]?.toUpperCase() ?? 'FILE';
	const fmtSize = (n: number | null) =>
		n == null ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
	// Type-tinted icon tile for non-image files (PDF reads red, archives amber, …).
	function fileTile(a: { contentType: string | null }) {
		const t = a.contentType ?? '';
		if (t === 'application/pdf') return { icon: FileTextIcon, cls: 'bg-destructive/10 text-destructive' };
		if (t.includes('zip') || t.includes('compressed') || t.includes('tar')) return { icon: ArchiveIcon, cls: 'bg-warn/10 text-warn' };
		if (t.startsWith('audio/')) return { icon: PaperclipIcon, cls: 'bg-p1/10 text-p1' };
		if (t.startsWith('video/')) return { icon: PaperclipIcon, cls: 'bg-p3/10 text-p3' };
		if (t.startsWith('text/') || t.includes('word') || t.includes('document') || t.includes('sheet')) return { icon: FileTextIcon, cls: 'bg-brand/10 text-brand' };
		return { icon: PaperclipIcon, cls: 'bg-muted text-muted-foreground' };
	}
	/** Scroll a message into view; in mail view, expand it first if collapsed.
	 * On mobile the drawer covers the stream, so jumping closes it. */
	function jumpToMsg(id: string, isLast: boolean) {
		if (isMobile.current) attachmentsOpen = false;
		if (threadView.current === 'mail' && !msgOpen(id, isLast)) toggleMsg(id);
		const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
		requestAnimationFrame(() => {
			streamEl?.querySelector(`[data-msg="${id}"]`)?.scrollIntoView({ behavior, block: 'center' });
		});
	}

	// Compose (Forward / resume Draft / new) routes through the shared controller;
	// the single ComposePanel is mounted in the (app) layout.
	function forward(parent: MessageDTO, subject: string | null) {
		if (!mailboxId) return;
		compose.start({
			prefill: {
				kind: 'forward',
				mailboxId,
				threadId,
				inReplyToMessageId: parent.messageIdHeader,
				subject: `Fwd: ${subject ?? ''}`.trim(),
				body: `\n\n---------- Forwarded message ----------\nFrom: ${parent.from ?? ''}\n\n${parent.bodyFull ?? parent.bodyStripped ?? ''}`
			}
		});
	}
	function openDraft(id: string) {
		compose.start({ resumeDraftId: id });
	}
	function composeNew() {
		if (!mailboxId) return;
		compose.start({ prefill: { kind: 'new', mailboxId } });
	}
	async function cancelScheduled(submissionId: string) {
		await undoDraftById({ submissionId });
		await scheduledSends().refresh();
	}

	// Escape walks back out: attachments panel first, then the open thread.
	// Dialogs/drawers (composer, palette) preventDefault their own Esc — skip those.
	function onPageKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented) return;
		const t = e.target as HTMLElement;
		if (t?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
		if (attachmentsOpen) {
			attachmentsOpen = false;
		} else if (threadId) {
			nav({ thread: null });
		}
	}
</script>

<svelte:window onkeydown={onPageKeydown} />

{#snippet listSkeleton()}
	{#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
		<div class="flex flex-col gap-2 border-b px-4 py-3">
			<div class="flex items-center gap-2">
				<Skeleton class="h-3 w-28 rounded" />
				<Skeleton class="ml-auto h-3 w-10 rounded" />
			</div>
			<Skeleton class="h-3.5 w-3/4 rounded" />
			<Skeleton class="h-3 w-1/2 rounded" />
		</div>
	{/each}
{/snippet}

{#snippet threadSkeleton()}
	<div class="flex h-12 items-center gap-2 border-b px-3 md:px-4">
		<Skeleton class="h-4 w-48 rounded" />
		<Skeleton class="ml-auto size-8 rounded-md" />
	</div>
	<div class="flex-1 space-y-5 p-4">
		{#each Array.from({ length: 3 }, (_, i) => i) as i (i)}
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<Skeleton class="size-8 rounded-full" />
					<Skeleton class="h-3 w-32 rounded" />
				</div>
				<Skeleton class="h-20 w-full rounded-lg" />
			</div>
		{/each}
	</div>
{/snippet}

{#snippet monogram(from: string | null, cls: string)}
	<SenderAvatar {from} class={cls} />
{/snippet}

<!-- Avatar-as-select-toggle (Gmail pattern): the avatar swaps to a check when
     selected and shows a checkbox affordance on fine-pointer hover — the row's
     geometry never changes, so selection causes zero layout shift. -->
{#snippet selectAvatar(from: string | null, checked: boolean, toggle: () => void, label: string)}
	<button
		type="button"
		aria-pressed={checked}
		aria-label={label}
		onclick={(e) => {
			e.stopPropagation();
			toggle();
		}}
		class="focus-visible:ring-ring/50 relative mt-0.5 shrink-0 rounded-full outline-none focus-visible:ring-2"
	>
		{#if checked}
			<span class="bg-brand text-brand-foreground grid size-9 place-items-center rounded-full">
				<CheckIcon class="size-4" />
			</span>
		{:else}
			{@render monogram(from, 'size-9 text-xs')}
			<span
				class="bg-background/95 text-muted-foreground pointer-fine:group-hover/row:grid absolute inset-0 hidden place-items-center rounded-full border"
			>
				<CheckIcon class="size-4" />
			</span>
		{/if}
	</button>
{/snippet}

<!-- Why an outbound message shows the warning tick: preflight/provider reason +
     the recipients that didn't make it. Rendered under bubbles and card headers
     so a failure is readable without hunting for a 3px icon. -->
{#snippet sendFailure(sub: NonNullable<MessageDTO['submission']>)}
	{@const bad = sub.perRecipient.filter((r) => ['failed', 'bounced', 'dropped', 'complained'].includes(r.status))}
	<div class="border-destructive/30 bg-destructive/10 text-destructive mt-1.5 w-full rounded-lg border px-2.5 py-1.5 text-left text-[11px]">
		<div class="flex items-center gap-1 font-semibold">
			<TriangleAlertIcon class="size-3 shrink-0" />
			{sub.status === 'canceled' ? 'Send canceled' : 'Not delivered'}
		</div>
		{#if sub.lastError}<p class="mt-0.5 opacity-90">{sub.lastError}</p>{/if}
		{#each bad as r (r.address)}
			<p class="mt-0.5 truncate font-mono opacity-90">
				{r.address} — {r.status}{r.bounceType ? ` (${r.bounceType} bounce)` : ''}
			</p>
		{/each}
	</div>
{/snippet}

<!-- Shared by the docked aside (≥ md) and the mobile drawer. -->
{#snippet attachmentGroups(groups: ReturnType<typeof groupAttachments>, msgs: MessageDTO[])}
	{#if groups.length === 0}
		<p class="text-muted-foreground py-6 text-center text-sm">No attachments in this thread.</p>
	{/if}
	{#each groups as g (g.day)}
		<p class="text-faint px-1 pt-2 pb-1.5 text-[11px] font-medium first:pt-0">{g.day}</p>
		<div class="space-y-2">
			{#each g.entries as { msg, atts } (msg.id)}
				<div class="bg-background/60 rounded-xl border p-2">
					<!-- Sender header (once per message) → jump to the message -->
					<button
						type="button"
						title="Show in conversation"
						onclick={() => jumpToMsg(msg.id, msg.id === msgs.at(-1)?.id)}
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
{/snippet}

<!-- @container: the list/thread split reacts to THIS region's width (sidebar
     open/closed included), not the viewport — collapsing the sidebar on a small
     laptop earns the two-pane layout. -->
<div class="@container flex h-full">
	<!-- List pane -->
	<!-- Single-pane swap (list OR thread) until the mail region is ≥ 56rem wide;
	     then the real two-pane split. -->
	<div class="@4xl:w-[360px] @4xl:shrink-0 relative flex w-full flex-col border-r {threadId ? '@4xl:flex hidden' : 'flex'}">
		<!-- List header — folder identity (or the active search) + settings -->
		<div class="flex h-14 items-center gap-2 border-b px-4">
			{#if searchQ}
				<SearchIcon class="text-muted-foreground size-4 shrink-0" />
				<div class="min-w-0 flex-1">
					<h2 class="font-heading text-[15px] leading-tight font-semibold tracking-tight">Search</h2>
					<span class="text-muted-foreground mt-1 block truncate font-mono text-[11px] leading-none">{searchQ}</span>
				</div>
				<button
					type="button"
					title="Clear search"
					onclick={() => nav({ q: null, thread: null })}
					class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-8 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2"
				>
					<XIcon class="size-4" />
				</button>
			{:else}
				<div class="min-w-0 flex-1">
					<h2 class="font-heading text-[15px] leading-tight font-semibold tracking-tight">{folder.name}</h2>
					<span class="text-muted-foreground mt-1 block truncate font-mono text-[11px] leading-none">{activeMailbox?.address ?? '…'}</span>
				</div>
			{/if}
			{#if (placement === 'trash' || placement === 'spam') && !searchQ && items.length}
				<AlertDialog.Root>
					<AlertDialog.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive shrink-0 gap-1.5 text-xs">
								<Trash2Icon class="size-3.5" /> Empty
							</Button>
						{/snippet}
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>Empty {folder.name.toLowerCase()}?</AlertDialog.Title>
							<AlertDialog.Description>
								Every conversation in {folder.name.toLowerCase()} is hidden from this mailbox and won't
								appear in the app again.
							</AlertDialog.Description>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
							<AlertDialog.Action onclick={emptyCurrentFolder}>Empty {folder.name.toLowerCase()}</AlertDialog.Action>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
			{/if}
			{#if canManageActive && !searchQ}
				<a href="/mailboxes/{mailboxId}" title="Manage mailbox" class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-8 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2">
					<SettingsIcon class="size-4" />
				</a>
			{/if}
		</div>

		<!-- Filter rail — folder nav lives in the sidebar (this row used to duplicate
		     it); the list's own row narrows what's shown instead. -->
		{#if !isVirtual && !searchQ && threadSel.size}
			<!-- Selection toolbar — takes the filter rail's row while anything is
			     selected. Same fixed h-10 as the rail: swapping causes no shift. -->
			<div class="bg-card/60 flex h-10 items-center gap-1 border-b px-2">
				<Button variant="ghost" size="icon" class="size-7" title="Clear selection" onclick={() => threadSel.clear()}>
					<XIcon class="size-4" />
				</Button>
				<span class="text-muted-foreground text-xs tabular-nums">{threadSel.size}</span>
				<div class="ml-auto flex items-center gap-0.5">
					<Button variant="ghost" size="icon" class="size-7" title="Mark read" disabled={bulkBusy} onclick={() => bulkRead(true)}>
						<MailOpenIcon class="size-4" />
					</Button>
					<Button variant="ghost" size="icon" class="size-7" title="Mark unread" disabled={bulkBusy} onclick={() => bulkRead(false)}>
						<MailIcon class="size-4" />
					</Button>
					{#if placement !== 'inbox'}
						<Button variant="ghost" size="icon" class="size-7" title="Move to inbox" disabled={bulkBusy} onclick={() => bulkMove('inbox')}>
							<InboxIcon class="size-4" />
						</Button>
					{/if}
					{#if placement !== 'archived'}
						<Button variant="ghost" size="icon" class="size-7" title="Archive" disabled={bulkBusy} onclick={() => bulkMove('archived')}>
							<ArchiveIcon class="size-4" />
						</Button>
					{/if}
					{#if placement !== 'spam'}
						<Button variant="ghost" size="icon" class="size-7" title="Mark spam" disabled={bulkBusy} onclick={() => bulkMove('spam')}>
							<ShieldAlertIcon class="size-4" />
						</Button>
					{/if}
					{#if placement !== 'trash'}
						<Button variant="ghost" size="icon" class="size-7 hover:text-destructive" title="Trash" disabled={bulkBusy} onclick={() => bulkMove('trash')}>
							<Trash2Icon class="size-4" />
						</Button>
					{/if}
				</div>
			</div>
		{:else if !isVirtual && !searchQ}
			<div class="flex h-10 items-center gap-2 border-b px-3">
				<div class="bg-muted/60 flex items-center gap-0.5 rounded-full p-0.5 text-xs">
					{#each [['all', 'All'], ['unread', 'Unread'], ['starred', 'Starred']] as [id, label] (id)}
						<button
							type="button"
							class="focus-visible:ring-ring/50 rounded-full px-2 py-0.5 transition-colors outline-none focus-visible:ring-2 {quickFilter === id ? 'bg-card text-foreground shadow-xs font-medium' : 'text-muted-foreground hover:text-foreground'}"
							onclick={() => (quickFilter = id as typeof quickFilter)}
						>
							{label}
						</button>
					{/each}
				</div>
				{#if isShared}
					<div class="bg-muted/60 ml-auto flex items-center gap-0.5 rounded-full p-0.5 text-xs">
						{#each [['all', 'All'], ['mine', 'Mine'], ['unassigned', 'Unassigned']] as [id, label] (id)}
							<button
								type="button"
								class="focus-visible:ring-ring/50 rounded-full px-2 py-0.5 transition-colors outline-none focus-visible:ring-2 {assignFilter === id ? 'bg-card text-foreground shadow-xs font-medium' : 'text-muted-foreground hover:text-foreground'}"
								onclick={() => (assignFilter = id as typeof assignFilter)}
							>
								{label}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		{#if placement === 'drafts' && draftSel.size}
			<!-- Floats over the list top (pane is relative; header is h-14) so the
			     bar's appearance pushes nothing — same zero-shift rule as threads. -->
			<div class="bg-card/85 absolute inset-x-0 top-14 z-10 flex h-10 items-center gap-1 border-b px-2 shadow-xs backdrop-blur">
				<Button variant="ghost" size="icon" class="size-7" title="Clear selection" onclick={() => draftSel.clear()}>
					<XIcon class="size-4" />
				</Button>
				<span class="text-muted-foreground text-xs tabular-nums">{draftSel.size} selected</span>
				<Button
					variant="ghost"
					size="sm"
					class="text-destructive hover:text-destructive ml-auto gap-1.5"
					disabled={deletingDrafts}
					onclick={() => deleteDrafts([...draftSel])}
				>
					{#if deletingDrafts}<Spinner class="size-3.5" />{:else}<Trash2Icon class="size-3.5" />{/if}
					Delete
				</Button>
			</div>
		{/if}
		<div class="flex-1 overflow-y-auto" onscroll={onListScroll}>
			{#if searchQ && searchResultsQ}
				{#await searchResultsQ}
					{@render listSkeleton()}
				{:then hits}
					{#if hits.length}
						{#each hits as hit (hit.threadId)}
							{@const selected = threadId === hit.threadId}
							<button
								type="button"
								onclick={() => nav({ mailbox: hit.mailboxId, thread: hit.threadId })}
								class="focus-visible:ring-ring/50 relative flex w-full gap-3 border-b px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset {selected ? 'bg-accent/70' : 'hover:bg-muted/50'}"
							>
								{#if selected}<span class="bg-brand absolute inset-y-1.5 left-0 w-[3px] rounded-r-full"></span>{/if}
								{@render monogram(hit.from, 'mt-0.5 size-9 text-xs')}
								<div class="min-w-0 flex-1">
									<div class="flex items-baseline gap-2">
										<span class="flex-1 truncate text-sm font-medium">{hit.from ? senderName(hit.from) : '—'}</span>
										{#if hit.at}<span class="text-faint shrink-0 text-[11px]">{fmtTime(hit.at)}</span>{/if}
									</div>
									<span class="block truncate text-[13px] text-muted-foreground">{hit.subject ?? '(no subject)'}</span>
									<span class="text-muted-foreground line-clamp-1 text-xs">{hit.snippet ?? ''}</span>
								</div>
							</button>
						{/each}
					{:else}
						<EmptyState icon={SearchIcon} title="No results" description={`Nothing matches “${searchQ}”.`}>
							{#snippet action()}
								<Button variant="ghost" size="sm" onclick={() => nav({ q: null })}>Clear search</Button>
							{/snippet}
						</EmptyState>
					{/if}
				{/await}
			{:else if placement === 'drafts'}
				<!-- .current (not #await): reactive to refresh() when the composer closes. -->
				{@const draftsQ = myDrafts()}
				{#if !draftsQ.current}
					{@render listSkeleton()}
				{:else}
					{@const drafts = draftsQ.current}
					{#if drafts.length}
						{#each drafts as d (d.id)}
							<div class="group/row group/draft flex items-start border-b py-2.5 pl-3 transition-colors {draftSel.has(d.id) ? 'bg-accent/50' : 'hover:bg-muted/50'}">
								{@render selectAvatar(
									d.to[0] ?? null,
									draftSel.has(d.id),
									() => (draftSel.has(d.id) ? draftSel.delete(d.id) : draftSel.add(d.id)),
									'Select draft'
								)}
								<button type="button" onclick={() => openDraft(d.id)} class="focus-visible:ring-ring/50 flex min-w-0 flex-1 gap-3 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset">
									<div class="min-w-0 flex-1">
										<div class="flex items-baseline gap-2">
											<span class="flex-1 truncate text-sm font-medium">{d.to.length ? d.to.map(senderName).join(', ') : 'No recipients'}</span>
											<span class="text-warn shrink-0 text-[11px] font-medium">Draft</span>
										</div>
										<span class="block truncate text-[13px] text-muted-foreground">{d.subject || '(no subject)'}</span>
										<span class="text-muted-foreground line-clamp-1 text-xs">{d.snippet ?? ''}</span>
									</div>
								</button>
								<button
									type="button"
									title="Delete draft"
									onclick={() => deleteDrafts([d.id])}
									class="text-muted-foreground hover:text-destructive focus-visible:ring-ring/50 pointer-coarse:opacity-100 mr-2 grid size-8 shrink-0 place-items-center self-center rounded-lg opacity-0 transition-opacity outline-none group-hover/draft:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
								>
									<Trash2Icon class="size-4" />
								</button>
							</div>
						{/each}
					{:else}
						<EmptyState icon={FileTextIcon} title="No drafts" description="Messages you start and close are saved here.">
							{#snippet action()}
								<Button size="sm" class="gap-1.5" onclick={composeNew}>
									<PencilIcon class="size-3.5" /> New message
								</Button>
							{/snippet}
						</EmptyState>
					{/if}
				{/if}
			{:else if placement === 'scheduled'}
				{@const schedQ = scheduledSends()}
				{#if schedQ.current}
					{@const items = schedQ.current}
					{#if items.length}
						{#each items as s (s.submissionId)}
							<div class="flex gap-3 border-b px-3 py-2.5">
								{@render monogram(s.to ?? null, 'mt-0.5 size-9 text-xs')}
								<div class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{s.to ? senderName(s.to) : '—'}</span>
									<span class="block truncate text-[13px] text-muted-foreground">{s.subject || '(no subject)'}</span>
									<div class="mt-1 flex items-center justify-between">
										<span class="text-brand inline-flex items-center gap-1 text-xs font-medium"><ClockIcon class="size-3" /> Sends {fmtTime(s.sendAt)}</span>
										<button type="button" class="text-muted-foreground hover:text-foreground text-xs underline" onclick={() => cancelScheduled(s.submissionId)}>Cancel</button>
									</div>
								</div>
							</div>
						{/each}
					{:else}
						<EmptyState icon={ClockIcon} title="Nothing scheduled" description="Schedule a send and it will appear here until it goes out." />
					{/if}
				{:else}
					{@render listSkeleton()}
				{/if}
			{:else if mailboxId && !isVirtual}
					{#if applyListFilters(items).length}
						{#each applyListFilters(items) as t (t.threadId)}
							{@const selected = threadId === t.threadId}
							{@const checked = threadSel.has(t.threadId)}
							<div class="group/row relative flex items-start border-b py-2.5 pl-3 transition-colors {selected ? 'bg-accent/70' : checked ? 'bg-accent/50' : 'hover:bg-muted/50'}">
								{#if selected}<span class="bg-brand absolute inset-y-1.5 left-0 w-[3px] rounded-r-full"></span>{/if}
								{@render selectAvatar(
									t.from,
									checked,
									() => (checked ? threadSel.delete(t.threadId) : threadSel.add(t.threadId)),
									'Select conversation'
								)}
							<button type="button" onclick={() => selectThread(t.threadId)} class="focus-visible:ring-ring/50 flex min-w-0 flex-1 gap-3 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset">
								<div class="min-w-0 flex-1">
									<div class="flex items-baseline gap-2">
										<span class="flex-1 truncate text-sm {t.unread ? 'text-foreground font-semibold' : 'text-foreground/90 font-medium'}">{senderName(t.from)}</span>
										<span class="text-faint shrink-0 text-[11px]">{fmtTime(t.lastMessageAt)}</span>
									</div>
									<div class="flex items-center gap-1.5">
										{#if t.unread}<span class="bg-brand size-1.5 shrink-0 rounded-full"></span>{/if}
										<span class="min-w-0 flex-1 truncate text-[13px] {t.unread ? 'text-foreground font-medium' : 'text-muted-foreground'}">{t.subject ?? '(no subject)'}</span>
										{#if t.hasNotes}<StickyNoteIcon class="text-warn size-3.5 shrink-0" />{/if}
										{#if t.assigneeUserId}<UserRoundIcon class="text-brand size-3.5 shrink-0" />{/if}
										{#if t.isStarred}<StarIcon class="text-p3 size-3.5 shrink-0 fill-current" />{/if}
									</div>
									<span class="text-muted-foreground mt-0.5 line-clamp-1 text-xs">{t.snippet ?? ''}</span>
								</div>
							</button>
							</div>
						{/each}
						{#if loadingList}
							<div class="flex justify-center py-3"><Spinner class="text-muted-foreground size-4" /></div>
						{/if}
					{:else if loadingList}
						{@render listSkeleton()}
					{:else if filtersActive && items.length}
						<!-- The folder has mail; the filters hid all of it. -->
						<EmptyState icon={ListFilterIcon} title="No matches" description="Nothing loaded here matches the active filters.">
							{#snippet action()}
								<Button variant="ghost" size="sm" onclick={() => { quickFilter = 'all'; assignFilter = 'all'; }}>
									Clear filters
								</Button>
							{/snippet}
						</EmptyState>
					{:else}
						{@const empty = EMPTY_COPY[placement] ?? EMPTY_COPY.inbox}
						{#if empty.compose}
							<EmptyState icon={folder.icon} title={empty.title} description={empty.desc}>
								{#snippet action()}
									<Button size="sm" class="gap-1.5" onclick={composeNew}>
										<PencilIcon class="size-3.5" /> Compose
									</Button>
								{/snippet}
							</EmptyState>
						{:else}
							<EmptyState icon={folder.icon} title={empty.title} description={empty.desc} />
						{/if}
					{/if}
			{/if}
		</div>

		<!-- Mobile compose FAB — the top bar drops its Compose button below `sm` to
		     give the search field the width back; composing moves here. Lives inside
		     the list pane so opening a thread (which hides the pane) hides it too. -->
		{#if mailboxId}
			<button
				type="button"
				aria-label="Compose"
				onclick={composeNew}
				class="bg-brand text-brand-foreground focus-visible:ring-ring/50 absolute right-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-10 grid size-13 place-items-center rounded-full shadow-lg transition-transform outline-none focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-95 sm:hidden"
			>
				<PencilIcon class="size-5" />
			</button>
		{/if}
	</div>

	<!-- Conversation -->
	<div class="relative min-w-0 flex-1 flex-col overflow-hidden {threadId ? 'flex' : '@4xl:flex hidden'}">
		{#if threadId && threadQ}
			{#if openDto}
				{@const thread = openDto}
					{@const msgs = thread.items.filter((i): i is MessageDTO => i.type === 'external_message')}
					{@const ctx = replyCtx(msgs)}
					{@const attTotal = msgs.reduce((n, m) => n + m.attachments.length, 0)}
					<div class="bg-card/40 flex h-14 items-center gap-2 border-b px-3 md:px-4">
						<Button variant="ghost" size="icon" class="text-muted-foreground @4xl:hidden" onclick={() => nav({ thread: null })}>
							<ArrowLeftIcon class="size-4" />
						</Button>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm leading-tight font-semibold">{thread.subject ?? '(no subject)'}</p>
							<p class="text-muted-foreground truncate text-[11px] leading-tight">
								{msgs.length} message{msgs.length === 1 ? '' : 's'}{ctx.target ? ` · ${senderName(ctx.target)}` : ''}
							</p>
						</div>
						{#if isShared}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button variant="outline" size="sm" class="h-8 gap-1.5" {...props}>
											<UserRoundIcon class="size-3.5 {thread.assigneeUserId ? 'text-brand' : ''}" />
											<span class="max-w-[12ch] truncate text-xs">{thread.assigneeUserId ? short(thread.assigneeUserId, members) : 'Unassigned'}</span>
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content class="w-56" align="end">
									<DropdownMenu.Label class="text-muted-foreground text-xs">Assign to</DropdownMenu.Label>
									{#each members as mem (mem.userId)}
										<DropdownMenu.Item onSelect={() => assign(mem.userId)}>
											<span class="flex-1 truncate">{mem.name}</span>
											{#if thread.assigneeUserId === mem.userId}<CheckIcon class="size-4" />{/if}
										</DropdownMenu.Item>
									{/each}
									{#if thread.assigneeUserId}
										<DropdownMenu.Separator />
										<DropdownMenu.Item onSelect={() => assign(null)}>Unassign</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}

						<!-- Interact: star + forward (step back on phones — star also lives on list rows) -->
						<Button variant="ghost" size="icon" class="text-muted-foreground hidden size-8 sm:inline-flex" title={thread.isStarred ? 'Unstar' : 'Star'} onclick={() => toggleStar(thread.isStarred)}>
							<StarIcon class="size-4 {thread.isStarred ? 'text-p3 fill-current' : ''}" />
						</Button>
						{#if ctx.parent}
							{@const p = ctx.parent}
							<Button variant="ghost" size="icon" class="text-muted-foreground hidden size-8 sm:inline-flex" title="Forward" onclick={() => forward(p, thread.subject)}>
								<ForwardIcon class="size-4" />
							</Button>
						{/if}
						{#if attTotal > 0}
							<button
								type="button"
								title="Attachments"
								aria-pressed={attachmentsOpen}
								onclick={() => (attachmentsOpen = !attachmentsOpen)}
								class="focus-visible:ring-ring/50 relative grid size-8 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 {attachmentsOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
							>
								<PaperclipIcon class="size-4" />
								<span class="bg-brand text-brand-foreground absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full text-[9px] font-semibold">{attTotal}</span>
							</button>
						{/if}

						<!-- View toggle: chat flow vs mail card stack -->
						<div class="bg-muted/60 flex items-center gap-0.5 rounded-xl p-0.5">
							<button type="button" title="Chat view" aria-pressed={threadView.current === 'chat'} onclick={() => (threadView.current = 'chat')} class="focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 {threadView.current === 'chat' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}">
								<MessageCircleIcon class="size-4" />
							</button>
							<button type="button" title="Mail view" aria-pressed={threadView.current === 'mail'} onclick={() => (threadView.current = 'mail')} class="focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 {threadView.current === 'mail' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}">
								<Rows3Icon class="size-4" />
							</button>
						</div>

						<!-- Triage: grouped as one control cluster, separate from interact -->
						<div class="bg-muted/60 flex items-center gap-0.5 rounded-xl p-0.5">
							{#if placement !== 'inbox'}
								<button type="button" title="Move to inbox" onclick={() => move('inbox')} class="text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg shadow-none transition-colors outline-none hover:shadow-xs focus-visible:ring-2">
									<InboxDownIcon class="size-4" />
								</button>
							{/if}
							{#if placement !== 'archived'}
								<button type="button" title="Archive" onclick={() => move('archived')} class="text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg transition-colors outline-none hover:shadow-xs focus-visible:ring-2">
									<ArchiveIcon class="size-4" />
								</button>
							{/if}
							{#if placement !== 'spam'}
								<button type="button" title="Mark spam" onclick={() => move('spam')} class="text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg transition-colors outline-none hover:shadow-xs focus-visible:ring-2">
									<ShieldAlertIcon class="size-4" />
								</button>
							{/if}
							{#if placement !== 'trash'}
								<button type="button" title="Trash" onclick={() => move('trash')} class="text-muted-foreground hover:text-destructive hover:bg-card focus-visible:ring-destructive/40 grid size-7 place-items-center rounded-lg transition-colors outline-none hover:shadow-xs focus-visible:ring-2">
									<Trash2Icon class="size-4" />
								</button>
							{/if}
						</div>
					</div>

					<!-- Middle row: message stream + (optional) docked attachments column.
					     Header above and reply/notes below stay full-width and visible. -->
					<div class="flex min-h-0 min-w-0 flex-1">
					<ScrollArea class="min-h-0 min-w-0 flex-1">
						<!-- chat: WhatsApp-style flow (default). mail: full-width card stack. -->
						<div bind:this={streamEl} class="flex w-full flex-col p-4 md:p-6 {threadView.current === 'mail' ? 'gap-2.5' : 'gap-3'}">
							{#each thread.items as item, i (item.id)}
								{#if threadView.current === 'chat' && isNewDay(thread.items, i)}
									{@const ms = itemMs(item)}
									{#if ms != null}
										<div class="flex justify-center py-1">
											<span class="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-[11px] font-medium">{fmtDay(ms)}</span>
										</div>
									{/if}
								{/if}
								{#if item.type === 'external_message' && threadView.current === 'chat'}
									{@const m = item}
									{@const outbound = !!m.submission}
									<div data-msg={m.id} data-newest={m.id === msgs.at(-1)?.id} class="flex gap-2.5 {outbound ? 'flex-row-reverse' : ''}">
										{#if !outbound}{@render monogram(m.from, 'mt-5 size-7 text-[10px]')}{/if}
										<div class="flex min-w-0 max-w-[80%] flex-col {outbound ? 'items-end' : 'items-start'}">
											{#if !outbound}<span class="text-muted-foreground mb-1 px-1 text-[11px] font-medium">{senderName(m.from)}</span>{/if}
											<div class="w-full rounded-2xl px-3.5 py-2.5 text-sm shadow-xs {outbound ? 'bg-foreground text-background rounded-tr-md' : 'bg-card rounded-tl-md border'}">
												{#if m.contentKind === 'card' && m.bodyHtml}
													{@const allow = loadedImages.has(m.id)}
													<!-- Outbound bubbles are ink (inverted vs the app mode), so the frame's
													     text scheme follows the BUBBLE surface, and the frame stays
													     transparent so the bubble color shows through. -->
													{@const frameDark = outbound ? mode.current !== 'dark' : mode.current === 'dark'}
													<div class="w-[min(70vw,32rem)]">
														<!-- Untrusted email HTML: script-less sandbox + CSP blocking remote content. -->
														<iframe title="Message content" sandbox="" srcdoc={frameDoc(m.bodyHtml, allow, frameDark)} class="h-72 w-full rounded-lg border-0 bg-transparent"></iframe>
														{#if !allow}
															<button type="button" class="mt-1 text-xs hover:underline {outbound ? 'text-background/80' : 'text-brand'}" onclick={() => loadedImages.add(m.id)}>
																Load remote images
															</button>
														{/if}
													</div>
												{:else}
													<div class="whitespace-pre-wrap">{m.bodyStripped ?? m.bodyFull ?? ''}</div>
												{/if}
												{#if m.attachments.length}
													<div class="mt-2 flex flex-wrap gap-1.5">
														{#each m.attachments as a (a.id)}
															<a href={resolve('/api/attachments/[id]', { id: a.id })} class="{outbound ? 'bg-background/15' : 'bg-muted border'} flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs" target="_blank" rel="noopener">
																<PaperclipIcon class="size-3" /><span class="max-w-[14ch] truncate">{a.filename ?? 'file'}</span>
															</a>
														{/each}
													</div>
												{/if}
												<div class="mt-1 flex items-center justify-end gap-1 text-[11px] {outbound ? 'text-background/70' : 'text-faint'}">
													{#if m.viaAlias}<span class="font-mono">via {m.viaAlias}</span>{/if}
													<span>{fmtTime(m.sentAt)}</span>
													{#if outbound && m.submission}
														{#if m.submission.tick === 'clock'}<ClockIcon class="size-3" />
														{:else if m.submission.tick === 'single'}<CheckIcon class="size-3" />
														{:else if m.submission.tick === 'double'}<CheckCheckIcon class="size-3" />
														{:else}<TriangleAlertIcon class="text-destructive size-3" />{/if}
													{/if}
												</div>
											</div>
											{#if m.submission?.tick === 'warning'}
												{@render sendFailure(m.submission)}
											{/if}
										</div>
									</div>
								{:else if item.type === 'external_message'}
								{@const m = item}
								{@const outbound = !!m.submission}
								{@const isLast = m.id === msgs.at(-1)?.id}
								{@const open = msgOpen(m.id, isLast)}
								<article data-msg={m.id} data-newest={isLast} class="overflow-hidden rounded-2xl border shadow-xs {outbound ? 'border-brand/25 bg-card' : 'bg-card'}">
									<button
										type="button"
										aria-expanded={open}
										onclick={() => toggleMsg(m.id)}
										class="hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:ring-2"
									>
										{@render monogram(m.from, 'size-8 text-[11px]')}
										<div class="min-w-0 flex-1">
											<div class="flex items-baseline gap-2">
												<span class="truncate text-sm font-semibold {outbound ? 'text-brand' : ''}">{outbound ? 'You' : senderName(m.from)}</span>
												{#if m.viaAlias}<span class="text-faint truncate font-mono text-[10px]">via {m.viaAlias}</span>{/if}
											</div>
											{#if open}
												<span class="text-muted-foreground block truncate font-mono text-[11px]">{m.from ?? ''}</span>
											{:else}
												<span class="text-muted-foreground block truncate text-xs">{msgSnippet(m)}</span>
											{/if}
										</div>
										<div class="text-faint flex shrink-0 items-center gap-1 text-[11px]">
											<span>{fmtTime(m.sentAt)}</span>
											{#if outbound && m.submission}
												{#if m.submission.tick === 'clock'}<ClockIcon class="size-3" />
												{:else if m.submission.tick === 'single'}<CheckIcon class="size-3" />
												{:else if m.submission.tick === 'double'}<CheckCheckIcon class="text-brand size-3" />
												{:else}<TriangleAlertIcon class="text-destructive size-3" />{/if}
											{/if}
										</div>
									</button>
									{#if m.submission?.tick === 'warning'}
										<div class="px-3.5 pb-2.5">
											{@render sendFailure(m.submission)}
										</div>
									{/if}
									{#if open}
										<div class="px-3.5 pb-3.5">
											{#if m.contentKind === 'card' && m.bodyHtml}
												{@const allow = loadedImages.has(m.id)}
												<!-- Untrusted email HTML: script-less sandbox + CSP blocking remote content. -->
												<iframe title="Message content" sandbox="" srcdoc={frameDoc(m.bodyHtml, allow, mode.current === 'dark')} class="h-72 w-full rounded-lg border-0 bg-transparent"></iframe>
												{#if !allow}
													<button type="button" class="text-brand mt-1.5 text-xs hover:underline" onclick={() => loadedImages.add(m.id)}>
														Load remote images
													</button>
												{/if}
											{:else}
												<div class="text-sm whitespace-pre-wrap">{m.bodyStripped ?? m.bodyFull ?? ''}</div>
											{/if}
											{#if m.attachments.length}
												<div class="mt-2.5 flex flex-wrap gap-1.5">
													{#each m.attachments as a (a.id)}
														<a href={resolve('/api/attachments/[id]', { id: a.id })} class="bg-muted hover:bg-accent hover:text-accent-foreground flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition-colors" target="_blank" rel="noopener">
															<PaperclipIcon class="size-3" /><span class="max-w-[18ch] truncate">{a.filename ?? 'file'}</span>
														</a>
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								</article>
								{:else if item.type === 'internal_note'}
									{@const n = item}
									<!-- Internal note — unmistakably NOT an email: amber, left-spined, "not sent". -->
									<div class="rounded-lg border-l-2 border-amber-400 bg-amber-50 px-3.5 py-2.5 dark:bg-amber-950/25">
										<div class="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-500">
											<StickyNoteIcon class="size-3" />
											Internal note · {short(n.authorUserId ?? '', members)} · not sent
											{#if n.editedAt && !n.deleted}<span class="text-faint">(edited)</span>{/if}
										</div>
										{#if n.deleted}
											<p class="text-muted-foreground text-sm italic">This note was deleted.</p>
										{:else}
											<p class="text-sm whitespace-pre-wrap text-ink">{n.body}</p>
											{#if n.authorUserId === currentUserId}
												<div class="mt-1 flex gap-3 text-[11px] text-amber-700/80 dark:text-amber-500/80">
													<button type="button" class="inline-flex items-center gap-1 hover:underline" onclick={() => editNotePrompt(n.id, n.body ?? '')}><PencilIcon class="size-3" /> Edit</button>
													<button type="button" class="hover:underline" onclick={() => removeNote(n.id)}>Delete</button>
												</div>
											{/if}
										{/if}
									</div>
								{:else if item.type === 'system_event'}
									{@const ev = item}
									<div class="text-faint py-1 text-center text-[11px]">
										{#if ev.eventType === 'assigned'}
											{short(ev.actorUserId ?? '', members)} assigned to {short(String(ev.data.assigneeUserId ?? ''), members)}
										{:else if ev.eventType === 'unassigned'}
											{short(ev.actorUserId ?? '', members)} unassigned this thread
										{:else if ev.eventType === 'archived'}
											{short(ev.actorUserId ?? '', members)} archived this thread
										{:else if ev.eventType === 'unarchived'}
											{short(ev.actorUserId ?? '', members)} moved this to inbox
										{:else}
											{short(ev.actorUserId ?? '', members)} changed placement
										{/if}
										· {fmtTime(ev.at)}
									</div>
								{/if}
							{/each}
						</div>
					</ScrollArea>

					<!-- Attachments ≥ md — docked column beside the stream. -->
					{#if attachmentsOpen && !isMobile.current}
						{@const groups = groupAttachments(msgs)}
						<aside
							transition:fly={{ x: 24, duration: 160 }}
							class="bg-card/40 flex w-80 max-w-[45%] shrink-0 flex-col border-l"
							aria-label="Thread attachments"
						>
							<div class="flex h-12 shrink-0 items-center gap-2 border-b px-3.5">
								<PaperclipIcon class="text-muted-foreground size-4" />
								<span class="text-sm font-semibold">Attachments</span>
								<button type="button" title="Close" onclick={() => (attachmentsOpen = false)} class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 ml-auto grid size-7 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2">
									<XIcon class="size-4" />
								</button>
							</div>
							<div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
								{@render attachmentGroups(groups, msgs)}
							</div>
						</aside>
					{/if}
					</div>

					<!-- Attachments < md — bottom drawer over the conversation. -->
					{#if isMobile.current}
						<Drawer.Root open={attachmentsOpen} onOpenChange={(o) => (attachmentsOpen = o)}>
							<Drawer.Content class="max-h-[80svh]">
								<Drawer.Header class="pb-2">
									<Drawer.Title class="flex items-center gap-2 text-sm">
										<PaperclipIcon class="text-muted-foreground size-4" /> Attachments
									</Drawer.Title>
								</Drawer.Header>
								<div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-6">
									{@render attachmentGroups(groupAttachments(msgs), msgs)}
								</div>
							</Drawer.Content>
						</Drawer.Root>
					{/if}

					{#if mailboxId}
						{#if isShared}
							<!-- Deliberate Reply | Note toggle — never a silent mode flip. -->
							<div class="flex items-center gap-1 border-t px-3 pt-2 text-xs font-medium">
								<button type="button" class="rounded-t px-3 py-1.5 {composeMode === 'reply' ? 'bg-card border border-b-0' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (composeMode = 'reply')}>Reply</button>
								<button type="button" class="rounded-t px-3 py-1.5 {composeMode === 'note' ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/25 dark:text-amber-500' : 'text-muted-foreground hover:text-foreground'}" onclick={() => (composeMode = 'note')}>Note</button>
							</div>
						{/if}
						{#if composeMode === 'note' && isShared}
							{#key thread.id}
								<NoteComposer {mailboxId} threadId={thread.id} onchange={refresh} />
							{/key}
						{:else if ctx.target}
							{#key thread.id}
								<ReplyComposer
									{mailboxId}
									threadId={thread.id}
									parentMessageId={ctx.parent?.messageIdHeader ?? null}
									toAddress={ctx.target}
									to={[ctx.target]}
									toAll={ctx.toAll}
									ccAll={ctx.ccAll}
									defaultAliasId={ctx.aliasId}
									{identities}
									onchange={refresh}
								/>
							{/key}
						{/if}
					{/if}
			{:else}
				{@render threadSkeleton()}
			{/if}
		{:else}
			<EmptyState icon={MessagesSquareIcon} title="No conversation selected" description="Pick a thread from the list to read it here, or compose a new message." />
		{/if}
	</div>
</div>
