<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount, untrack, tick } from 'svelte';
	import { mode } from 'mode-watcher';
	import { PersistedState, watch } from 'runed';
	import { page } from '$app/state';
	import { goto, pushState, replaceState, onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import ReplyComposer from '$lib/components/mail/reply-composer.svelte';
	import Highlight from '$lib/components/mail/highlight.svelte';
	import ContactHoverCard from '$lib/components/mail/contact-hovercard.svelte';
	import { AvatarGroup } from '$lib/components/ui/avatar/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Kbd } from '$lib/components/ui/kbd/index.js';
	import { swipeX } from '$lib/utils/swipe';
	import { pullToRefresh } from '$lib/utils/pull-refresh';
	import { pushRecentThread } from '$lib/client/recent-threads';
	import { relTime } from '$lib/utils/reltime';
	import MailFrame from '$lib/components/mail/mail-frame.svelte';
	import InviteCard from '$lib/components/mail/invite-card.svelte';
	import AttachmentTile from '$lib/components/mail/attachment-tile.svelte';
	import NoteComposer from '$lib/components/mail/note-composer.svelte';
	import { compose } from '$lib/client/compose.svelte.js';
	import EmptyState from '$lib/components/mail/empty-state.svelte';
	import SenderAvatar from '$lib/components/mail/sender-avatar.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { myMailboxes, myManagedMailboxIds } from '$lib/rpc/mailbox.remote';
	import { activeMailbox as lastMailbox } from '$lib/client/active-mailbox.svelte.js';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
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
		emptyFolder,
		unreadCount,
		setSenderImageTrust,
		setInviteRsvp
	} from '$lib/rpc/thread.remote';
	import { unread } from '$lib/client/unread.svelte.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { linkifySegments } from '$lib/utils/linkify.js';
	import { toast } from 'svelte-sonner';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import { sendIdentities, myDrafts, scheduledSends, undoDraftById, discardDrafts, retrySendById } from '$lib/rpc/draft.remote';
	import { realtime } from '$lib/client/mail-events.svelte.js';
	import type { SendIdentity } from '@doota/mail-core/identities';
	import type { MessageDTO, CalendarInviteDTO, InviteRsvpStatus } from '@doota/mail-core/mail-thread-contract';
	import { replySubject, FAILED_SEND_STATUSES } from '@doota/mail-core/mail-thread-contract';
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
	import ReplyIcon from '@lucide/svelte/icons/reply';
	import ReplyAllIcon from '@lucide/svelte/icons/reply-all';
	import StarIcon from '@lucide/svelte/icons/star';
	import EllipsisVerticalIcon from '@lucide/svelte/icons/ellipsis-vertical';
	import UsersIcon from '@lucide/svelte/icons/users';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import InboxDownIcon from '@lucide/svelte/icons/inbox';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import LockIcon from '@lucide/svelte/icons/lock';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import Rows3Icon from '@lucide/svelte/icons/rows-3';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { searchMail } from '$lib/rpc/search.remote';
	import { slide } from 'svelte/transition';
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
	// URL is authoritative; when it lacks ?mailbox, fall back to the user's last
	// explicit pick (validated against current access), NOT blindly mailboxes[0] —
	// so folder nav / a fresh load never auto-switches the mailbox.
	const mailboxId = $derived(
		params.get('mailbox') ??
			mailboxes.find((m) => m.id === lastMailbox.current)?.id ??
			mailboxes[0]?.id ??
			null
	);
	const placement = $derived(params.get('folder') ?? 'inbox');
	const threadId = $derived(params.get('thread'));

	// Continuation: on a bare /app load the mailbox comes from the persisted pick,
	// but the URL doesn't show it — so write it back (replace, no history entry).
	// Now the URL always reflects the active mailbox: refresh/share is stable and
	// folder links carry the param instead of leaning on the fallback.
	$effect(() => {
		const mb = mailboxId;
		if (!mb || params.get('mailbox')) return;
		untrack(() => {
			const sp = new URLSearchParams(page.url.searchParams);
			sp.set('mailbox', mb);
			replaceState(`?${sp}`, page.state);
		});
	});
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

	// Unread inbox count → sidebar badge + tab title. The mail page owns the
	// fetch (it knows the mailbox); readers watch the shared store.
	async function refreshUnread() {
		if (!mailboxId) return;
		try {
			unread.count = await unreadCount({ mailboxId });
		} catch {
			// transient — next trigger retries
		}
	}
	watch([() => mailboxId], ([mb]) => {
		if (mb) void refreshUnread();
		else unread.count = 0;
	});
	$effect(() => {
		document.title = unread.count > 0 ? `(${unread.count}) Doota` : 'Doota';
	});

	// Keep the OPEN thread read: a reply landing while you're viewing it, or your
	// own send, shouldn't resurface the row as unread in the list/badge. No-op on
	// a hidden tab (you haven't looked) or when nothing's open.
	async function markOpenRead() {
		const mb = mailboxId;
		const th = threadId;
		if (!mb || !th || document.hidden) return;
		await markThreadRead({ mailboxId: mb, threadId: th });
		patchItem(th, { unread: false });
		void refreshUnread();
	}
	// Returned to the tab with a thread open → treat it as seen.
	$effect(() => {
		const onVis = () => {
			if (!document.hidden) void markOpenRead();
		};
		document.addEventListener('visibilitychange', onVis);
		return () => document.removeEventListener('visibilitychange', onVis);
	});

	// Live MailEventHub push. send_state: refresh the open thread in place —
	// ticks flip clock→sent→delivered, failure banners appear without reopening
	// (toasting lives in the app shell's notifier). inbound: new mail for this
	// mailbox — bump the badge, refresh the visible list, and refresh the open
	// thread if the reply landed there. Tracks ONLY the event; folder/thread
	// state is read untracked so navigation doesn't replay the last event.
	// Page-specific reactions to the shared realtime bus (RealtimeSync is the sole
	// subscriber + owns OS-notify and the unread badge). Here we only refresh what
	// THIS view shows: the open thread's ticks/messages and the list.
	$effect(() => {
		void realtime.seq;
		const evt = realtime.event;
		if (!evt) return;
		untrack(() => void onRealtime(evt));
	});
	async function onRealtime(evt: NonNullable<typeof realtime.event>) {
		if (evt.type === 'send_state') {
			if (evt.threadId && evt.threadId === threadId) void threadQ?.refresh();
			return;
		}
		// Capture reactive scope now — we await below and the user may navigate.
		const mb = mailboxId;
		const th = threadId;
		if (evt.mailboxId !== mb) return;
		const openHere = evt.threadId === th;
		if (openHere) void threadQ?.refresh();
		// A reply landing in the thread you're looking at is already on screen —
		// advance the read cursor so it doesn't resurface as unread. Visible tab is
		// enough (don't require window focus — the thread is on screen); a hidden
		// tab means you haven't seen it, so leave it unread.
		const viewing = openHere && !document.hidden;
		if (viewing && mb && th) {
			await markThreadRead({ mailboxId: mb, threadId: th });
			void refreshUnread();
		}
		// ponytail: full first-page reload on inbound — fine at inbox scale; switch
		// to a prepend-merge if reset scroll ever annoys. Runs after markThreadRead
		// so the reloaded row reflects the advanced cursor.
		if (placement === 'inbox' || placement === 'sent') await loadThreads(true);
		if (viewing && th) patchItem(th, { unread: false });
	}

	// Thread list — infinite scroll. Pages accumulate into `items`; the next page
	// loads when the list nears the bottom, and the list resets when the mailbox
	// or folder changes. Common actions patch `items` in place (no refetch/flash).
	const PAGE = 30;
	let items = $state<ThreadSummary[]>([]);
	let nextOffset = $state(0);
	let reachedEnd = $state(false);
	let loadingList = $state(false);

	let pendingReload = false;
	async function loadThreads(reset: boolean) {
		if (!mailboxId || isVirtual) return;
		if (loadingList) {
			// A reset that lands mid-load (live event during initial fetch) must
			// not be dropped — run it again once the current load settles.
			if (reset) pendingReload = true;
			return;
		}
		if (!reset && reachedEnd) return;
		loadingList = true;
		const forMailbox = mailboxId;
		const forPlacement = placement;
		try {
			const offset = reset ? 0 : nextOffset;
			const q = mailboxThreads({ mailboxId, placement: placement as never, offset });
			// Same-args query calls are deduped/cached — a plain re-await can hand
			// back the stale page. Resets come from live events, so force the read.
			const page = reset ? ((await q.refresh(), q.current) ?? []) : await q;
			// The user may have switched folders/mailboxes while this was in flight —
			// drop the late page rather than paint the wrong folder's mail.
			if (forMailbox !== mailboxId || forPlacement !== placement) return;
			items = reset ? page : [...items, ...page];
			nextOffset = offset + page.length;
			reachedEnd = page.length < PAGE;
		} finally {
			loadingList = false;
			if (pendingReload) {
				pendingReload = false;
				void loadThreads(true);
			}
		}
	}

	// Reset + load page 0 when mailbox/folder changes. `watch` tracks only its
	// sources, so the loader's own state writes can't retrigger it.
	watch(
		[() => mailboxId, () => isVirtual, () => placement],
		([mb, virt]) => {
			draftSel.clear();
			threadSel.clear();
			// Clear the previous folder's rows up front so the switch shows a skeleton,
			// not stale mail. Live-event refreshes call loadThreads directly (not via
			// this watch), so in-place updates never flash.
			items = [];
			nextOffset = 0;
			reachedEnd = false;
			if (mb && !virt) loadThreads(true);
		}
	);

	// Thread multi-select — checkbox column; the filter rail becomes the action
	// toolbar while anything is selected. Bulk mutations patch `items` in place
	// like the single-thread actions do (no refetch/flash).
	const threadSel = new SvelteSet<string>();
	let bulkBusy = $state(false);

	// Action feedback on rows. Leaving rows play ONE continuous exit: height
	// collapses while the row slides toward where it's going (trash/spam left,
	// archive/inbox right), so rows below track the shrink instead of jumping
	// after a separate fade. The exit only plays when rowFx names the row —
	// removals from plain refreshes/live reloads stay instant. Read/unread
	// keeps the row and pulses a ring instead.
	type RowFx = 'delete' | 'spam' | 'archived' | 'inbox' | 'pulse';
	const PULSE_CLASS = 'ring-brand/40 ring-2 ring-inset transition-shadow duration-300';
	const rowFx = new SvelteMap<string, RowFx>();

	function exitFx(node: HTMLElement, { kind }: { kind?: RowFx }) {
		if (!kind || kind === 'pulse') return { duration: 0 };
		const dx = kind === 'archived' || kind === 'inbox' ? 40 : -40;
		const h = node.offsetHeight;
		const cs = getComputedStyle(node);
		const pt = parseFloat(cs.paddingTop);
		const pb = parseFloat(cs.paddingBottom);
		return {
			duration: 280,
			easing: cubicOut,
			css: (t: number, u: number) =>
				`overflow:hidden; opacity:${t}; transform:translateX(${dx * u}px); height:${h * t}px; padding-top:${pt * t}px; padding-bottom:${pb * t}px; min-height:0;`
		};
	}

	async function bulkMove(pl: 'inbox' | 'archived' | 'spam' | 'trash') {
		if (!mailboxId || bulkBusy) return;
		const ids = [...threadSel];
		const mb = mailboxId;
		bulkBusy = true;
		const prevs = ids.map((id) => ({ threadId: id, prev: rowPrev(id) }));
		const fx: RowFx = pl === 'trash' ? 'delete' : pl;
		for (const id of ids) rowFx.set(id, fx);
		// Optimistic: rows leave immediately (exit transition reads rowFx); a
		// loading toast tracks the write, flipping to Undo on success (same flow as
		// swipe triage), or to an error + list reload on failure.
		items = items.filter((t) => !threadSel.has(t.threadId));
		if (threadId && threadSel.has(threadId)) nav({ thread: null });
		threadSel.clear();
		const label = MOVE_BUSY[pl] ?? 'Moving…';
		const busy = ids.length > 1 ? label.replace('…', ` ${ids.length}…`) : label;
		try {
			const ok = await runWithToast(busy, 'Action failed — restoring the list.', () => bulkMoveThreads({ mailboxId: mb, threadIds: ids, placement: pl }), { done: (id) => toastUndoMove(prevs, pl, id) });
			if (ok) void refreshUnread();
			else void loadThreads(true);
		} finally {
			setTimeout(() => {
				for (const id of ids) rowFx.delete(id);
			}, 350);
			bulkBusy = false;
		}
	}
	async function bulkRead(read: boolean) {
		if (!mailboxId || bulkBusy) return;
		const ids = [...threadSel];
		bulkBusy = true;
		for (const id of ids) rowFx.set(id, 'pulse');
		try {
			await bulkMarkRead({ mailboxId, threadIds: ids, read });
			items = items.map((t) => (threadSel.has(t.threadId) ? { ...t, unread: !read } : t));
			threadSel.clear();
			void refreshUnread();
		} finally {
			setTimeout(() => {
				for (const id of ids) rowFx.delete(id);
			}, 400);
			bulkBusy = false;
		}
	}

	// "Empty trash/spam" — hides everything at the placement (no hard delete).
	// Confirmed bulk (AlertDialog) with real latency: loading toast → success,
	// no Undo. Optimistic clear; reload the list back if the write fails.
	async function emptyCurrentFolder() {
		if (!mailboxId || (placement !== 'trash' && placement !== 'spam')) return;
		const mb = mailboxId;
		const pl = placement;
		const name = folder.name;
		const kept = items;
		items = [];
		threadSel.clear();
		if (threadId) nav({ thread: null });
		const ok = await runWithToast(`Emptying ${name}…`, `Could not empty ${name.toLowerCase()}.`, () => emptyFolder({ mailboxId: mb, placement: pl }), {
			done: (id) => toast.success(`${name} emptied.`, { id })
		});
		if (!ok) items = kept;
	}

	// Drafts multi-select. Single-row delete goes through the same bulk call.
	const draftSel = new SvelteSet<string>();
	let deletingDrafts = $state(false);
	// Rows mid-delete: dimmed + non-interactive so they immediately read as
	// "going away" during the network round-trip, before the exit collapse.
	const pendingDelete = new SvelteSet<string>();
	async function deleteDrafts(ids: string[]) {
		deletingDrafts = true;
		for (const id of ids) pendingDelete.add(id);
		try {
			await discardDrafts({ draftIds: ids });
			for (const id of ids) draftSel.delete(id);
			// Now play the exit collapse (threads' `delete` fx) and refresh them out.
			for (const id of ids) rowFx.set(id, 'delete');
			await myDrafts().refresh();
		} finally {
			for (const id of ids) pendingDelete.delete(id);
			setTimeout(() => {
				for (const id of ids) rowFx.delete(id);
			}, 350);
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

	// Manual refresh — live push covers updates, but the button gives control
	// back to the user. Feedback always: what's new, a calm "nothing new", or
	// the error.
	let refreshing = $state(false);
	const CALM = [
		'Nothing new — enjoy the quiet.',
		'All caught up. ☕',
		'Nothing new — your inbox is calm.',
		'No new mail. A good sign.'
	];
	const calm = () => CALM[Math.floor(Math.random() * CALM.length)];
	async function manualRefresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			if (isVirtual) {
				const q = placement === 'drafts' ? myDrafts() : scheduledSends();
				const before = new Set(
					(q.current ?? []).map((r) => ('id' in r ? r.id : r.submissionId))
				);
				await q.refresh();
				const after = (q.current ?? []).map((r) => ('id' in r ? r.id : r.submissionId));
				const changed = after.length !== before.size || after.some((id) => !before.has(id));
				toast.success(changed ? 'List updated.' : calm());
			} else {
				const before = new Map(items.map((t) => [t.threadId, t.lastMessageAt ?? 0]));
				await loadThreads(true);
				void refreshUnread();
				const fresh = items.filter((t) => {
					const prev = before.get(t.threadId);
					return prev === undefined || (t.lastMessageAt ?? 0) > prev;
				}).length;
				toast.success(
					fresh > 0 ? `${fresh} ${fresh === 1 ? 'conversation' : 'conversations'} updated.` : calm()
				);
			}
		} catch {
			toast.error('Refresh failed — check your connection and try again.');
		} finally {
			refreshing = false;
		}
	}

	let listEl = $state<HTMLElement>();
	function onListScroll(e: Event) {
		// Search has its own (capped) result set — don't fire folder pagination,
		// which would mutate `items` under the search view.
		if (searchQ) return;
		const el = e.currentTarget as HTMLElement;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) loadThreads(false);
	}
	// The list pane and search share one scroll container — reset it to the top
	// when a search opens (or the query changes) so results never start pinned at
	// a stale offset from the folder list (iOS reads that as "won't scroll").
	$effect(() => {
		void searchQ;
		untrack(() => {
			if (searchQ && listEl) listEl.scrollTop = 0;
		});
	});

	/** Patch one loaded row in place — avoids a full refetch (and its flash). */
	function patchItem(id: string, patch: Partial<ThreadSummary>) {
		items = items.map((t) => (t.threadId === id ? { ...t, ...patch } : t));
	}

	// Coherent star/assignee between the list and the open-thread header: ONE
	// source, patched in place — never a full thread refetch to flip a boolean.
	// Priority: optimistic override → the list row (when the open thread is
	// loaded) → the thread DTO (direct-URL case). Override resets per thread.
	const openThreadItem = $derived(items.find((t) => t.threadId === threadId));
	let openFlagOverride = $state<{ isStarred?: boolean; assigneeUserId?: string | null }>({});
	$effect(() => {
		void threadId;
		untrack(() => (openFlagOverride = {}));
	});
	const openStarred = $derived(
		openFlagOverride.isStarred ?? openThreadItem?.isStarred ?? openDto?.isStarred ?? false
	);
	const openAssignee = $derived(
		'assigneeUserId' in openFlagOverride
			? (openFlagOverride.assigneeUserId ?? null)
			: (openThreadItem?.assigneeUserId ?? openDto?.assigneeUserId ?? null)
	);

	async function refresh() {
		await threadQ?.refresh();
		await loadThreads(true);
		// Sending a reply bumps the thread's activity; in a shared mailbox the row
		// would re-derive as unread. Keep the open thread read.
		await markOpenRead();
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
		// Header + list flip instantly via the overlay; the thread refetch is only
		// to pull the "assigned to X" system-event into the timeline (a real
		// server-side effect, unlike star), not to sync the badge.
		openFlagOverride = { ...openFlagOverride, assigneeUserId: userId };
		patchItem(id, { assigneeUserId: userId });
		await assignThread({ mailboxId, threadId: id, assigneeUserId: userId });
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

	// Open a thread and mark it read (clears the unread dot + badge). Skip the
	// write when we already know the row is read — reopening an already-read
	// thread shouldn't fire a redundant markThreadRead (a wasted D1 write). An
	// item we don't have (direct URL / search nav) is treated as maybe-unread.
	// Keyboard-nav cursor: j/k move this highlight instantly, but the actual
	// open (URL nav + thread fetch + mark-read) is debounced so flying through
	// the list doesn't fetch/read every thread skimmed past — only the one you
	// land on. Enter (or the pause) commits. Superhuman's model.
	let navCursor = $state<string | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | null = null;
	function cancelPendingOpen() {
		if (openTimer) clearTimeout(openTimer);
		openTimer = null;
	}
	function moveCursor(dir: 1 | -1) {
		if (!items.length) return;
		const base = navCursor ?? threadId;
		const idx = items.findIndex((x) => x.threadId === base);
		const next = idx === -1 ? 0 : Math.min(Math.max(idx + dir, 0), items.length - 1);
		const target = items[next];
		if (!target) return;
		navCursor = target.threadId;
		listEl?.querySelector(`[data-row="${target.threadId}"]`)?.scrollIntoView({ block: 'nearest' });
		cancelPendingOpen();
		openTimer = setTimeout(() => commitCursor(), 220);
	}
	function commitCursor() {
		cancelPendingOpen();
		const id = navCursor;
		if (id && id !== threadId) void selectThread(id);
	}

	async function selectThread(id: string) {
		cancelPendingOpen();
		navCursor = null;
		nav({ thread: id });
		if (!mailboxId) return;
		{
			const row = items.find((t) => t.threadId === id);
			pushRecentThread({ threadId: id, mailboxId, subject: row?.subject ?? null, from: row?.from ?? null });
		}
		const item = items.find((t) => t.threadId === id);
		if (item && !item.unread) return;
		await markThreadRead({ mailboxId, threadId: id });
		patchItem(id, { unread: false });
		void refreshUnread();
	}

	// Undo for triage moves (Gmail's safety net): every archive/spam/trash/inbox
	// move toasts with Undo for ~6s, restoring each thread's PREVIOUS placement.
	const MOVE_LABEL: Record<string, string> = {
		archived: 'Archived',
		spam: 'Marked as spam',
		trash: 'Moved to trash',
		inbox: 'Moved to inbox'
	};
	const MOVE_BUSY: Record<string, string> = {
		archived: 'Archiving…',
		spam: 'Marking as spam…',
		trash: 'Moving to trash…',
		inbox: 'Moving to inbox…'
	};
	// Promise-toast helper: a loading toast tracks the write in the background so
	// the (already-optimistic) UI never blocks. Returns the toast id — pass it to
	// a follow-up toast (Undo / success) to replace the spinner in place, or let
	// `error` land on the same toast. `done` closes it silently (caller shows its
	// own success/Undo); `error` is the rollback message.
	async function runWithToast(
		loading: string,
		error: string,
		run: () => Promise<unknown>,
		opts?: { done?: (id: string | number) => void }
	): Promise<boolean> {
		const id = toast.loading(loading);
		try {
			await run();
			if (opts?.done) opts.done(id);
			else toast.dismiss(id);
			return true;
		} catch {
			toast.error(error, { id });
			return false;
		}
	}
	// `id` updates an existing (loading) toast in place — the promise-toast flow:
	// spinner while the write is in flight, then this Undo toast replaces it.
	function toastUndoMove(entries: { threadId: string; prev: string }[], target: string, id?: string | number) {
		const mb = mailboxId;
		if (!mb) return;
		const label = MOVE_LABEL[target] ?? 'Moved';
		toast(entries.length > 1 ? `${label} · ${entries.length} conversations` : label, {
			id,
			duration: 6000,
			action: {
				label: 'Undo',
				onClick: async () => {
					for (const e of entries) {
						try {
							await moveThread({ mailboxId: mb, threadId: e.threadId, placement: e.prev as never });
						} catch {
							// row may have moved again meanwhile — restore the rest
						}
					}
					await loadThreads(true);
					void refreshUnread();
				}
			}
		});
	}
	/** A row's current placement (for undo): the row's own placement (Sent view
	 * rows differ), else the open folder. */
	const rowPrev = (id: string) =>
		items.find((t) => t.threadId === id)?.placement ?? (placement === 'sent' ? 'inbox' : placement);

	// Move one LIST ROW (swipe path — no open-thread nav involved). Optimistic:
	// the row leaves the instant the swipe commits (no red-reveal stall while the
	// server round-trips); a loading toast flips to the Undo toast on success and
	// the list restores on failure.
	async function moveRow(id: string, target: 'inbox' | 'archived' | 'spam' | 'trash') {
		if (!mailboxId) return;
		const mb = mailboxId;
		const prev = rowPrev(id);
		rowFx.set(id, target === 'inbox' ? 'inbox' : target === 'archived' ? 'archived' : 'delete');
		items = items.filter((t) => t.threadId !== id);
		swipeProg.delete(id); // stale progress would re-render the reveal if the row returns via Undo
		if (threadId === id) nav({ thread: null });
		const tid = toast.loading(MOVE_BUSY[target] ?? 'Moving…');
		try {
			await moveThread({ mailboxId: mb, threadId: id, placement: target });
			toastUndoMove([{ threadId: id, prev }], target, tid);
			void refreshUnread();
		} catch {
			toast.error('Action failed — restoring the list.', { id: tid });
			void loadThreads(true);
		} finally {
			setTimeout(() => rowFx.delete(id), 350);
		}
	}

	// Live swipe progress per row (-1..1) — drives the action reveal underneath.
	// Rendered only while non-zero, so translucent row tints never leak icons.
	const swipeProg = new SvelteMap<string, number>();
	const coarsePointer = () =>
		typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

	// Pull-to-refresh (touch): reloads whatever the list pane currently shows.
	let pullProg = $state(0);
	let pullBusy = $state(false);
	async function refreshCurrentList() {
		if (searchQ) {
			await searchResultsQ?.refresh();
		} else if (placement === 'drafts') {
			await myDrafts().refresh();
		} else if (placement === 'scheduled') {
			await scheduledSends().refresh();
		} else {
			await loadThreads(true);
			void refreshUnread();
		}
	}

	// Triage: move to a placement (archive/spam/trash/inbox), then leave the thread.
	// Optimistic like moveRow: leave the thread and drop the row immediately; the
	// server write settles behind the loading→Undo toast.
	async function move(placement: string) {
		if (!mailboxId || !threadId) return;
		const mb = mailboxId;
		const id = threadId;
		const prev = rowPrev(id);
		nav({ thread: null });
		items = items.filter((t) => t.threadId !== id);
		const tid = toast.loading(MOVE_BUSY[placement] ?? 'Moving…');
		try {
			await moveThread({ mailboxId: mb, threadId: id, placement: placement as never });
			toastUndoMove([{ threadId: id, prev }], placement, tid);
			void refreshUnread();
		} catch {
			toast.error('Action failed — restoring the list.', { id: tid });
			void loadThreads(true);
		}
	}
	async function toggleStar(current: boolean) {
		if (!mailboxId || !threadId) return;
		const id = threadId;
		const next = !current;
		// Optimistic + coherent: flip both surfaces, no thread refetch. Roll back on
		// failure (star carries no server-side side effects to re-pull).
		openFlagOverride = { ...openFlagOverride, isStarred: next };
		patchItem(id, { isStarred: next });
		try {
			await starThread({ mailboxId, threadId: id, starred: next });
		} catch {
			openFlagOverride = { ...openFlagOverride, isStarred: current };
			patchItem(id, { isStarred: current });
		}
	}

	// Which message the docked composer replies to. null = default (latest
	// inbound); a per-message Reply/Reply-all button sets an explicit target so
	// the audience is computed from THAT message, not guessed from the thread.
	let replyTarget = $state<{ msgId: string; scope: 'reply' | 'reply_all' } | null>(null);
	let composerEl = $state<HTMLElement>();
	let composerFlash = $state(false);
	// Every action needs a response: retarget, then scroll the (docked, easy-to-miss)
	// composer into view and flash it so the click is unmistakably acknowledged.
	async function replyTo(m: MessageDTO, scope: 'reply' | 'reply_all') {
		replyTarget = { msgId: m.id, scope };
		await tick(); // let the composer remount with the new audience first
		composerEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		composerFlash = true;
		setTimeout(() => (composerFlash = false), 900);
		// Move focus into the editor (keyboard/screen-reader users otherwise land
		// nowhere after the scroll). preventScroll: the smooth scroll above owns it.
		composerEl
			?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input')
			?.focus({ preventScroll: true });
	}
	// Subaddress-normalize: you+tag@x and you@x are the same inbox, so both count
	// as "self" — otherwise reply-all to mail sent at you+shop@ mails yourself.
	const baseAddr = (a: string) => a.toLowerCase().replace(/^([^@+]+)\+[^@]*@/, '$1@');
	const selfSet = () => new Set(identities.map((i) => baseAddr(i.address)));
	// Everyone who's appeared on the thread (from/to/cc across all messages).
	function threadParticipants(msgs: MessageDTO[]): Set<string> {
		const s = new Set<string>();
		for (const m of msgs) for (const a of [m.from, ...m.to, ...m.cc]) if (a) s.add(a.toLowerCase());
		return s;
	}
	// A message whose audience is a strict subset of the thread's participants is
	// PRIVATE — a reply that dropped people. Returns who (besides you) can see it,
	// or null when everyone on the thread is on the message. Drives the "only
	// visible to you" chip so a reply-to-one never looks like it reached everyone.
	function msgPrivateTo(m: MessageDTO, parts: Set<string>): string[] | null {
		const aud = new Set<string>();
		for (const a of [m.from, ...m.to, ...m.cc]) if (a) aud.add(a.toLowerCase());
		if (aud.size >= parts.size) return null; // reaches everyone on the thread
		const self = selfSet();
		return [...aud].filter((a) => !self.has(baseAddr(a)));
	}
	// Reply-all only means something when the message reaches ≥2 people besides you.
	function msgCanReplyAll(m: MessageDTO): boolean {
		const self = selfSet();
		const all = new Set([m.from ?? '', ...m.to, ...m.cc].filter(Boolean).map(baseAddr));
		for (const s of self) all.delete(s);
		return all.size >= 2;
	}

	// Reply context. Audience is derived from ONE message — the explicitly chosen
	// target, else the latest inbound (falling back to the newest). reply-one goes
	// to the sender (inbound) or the person you wrote to (outbound); reply-all adds
	// the rest of that message's To/Cc, minus your own identities.
	function replyCtx(msgs: MessageDTO[], target: { msgId: string; scope: 'reply' | 'reply_all' } | null) {
		const chosen = target ? msgs.find((m) => m.id === target.msgId) : undefined;
		// A base must yield a reply address, or the whole reply bar vanishes —
		// e.g. a DSN/bounce with no From as the latest inbound. Skip those.
		const usable = (m: MessageDTO) =>
			m.outbound ? !!(m.to[0] ?? m.cc[0]) : !!(m.replyTo || m.from);
		const rev = [...msgs].reverse();
		const base =
			chosen ?? rev.find((m) => !m.outbound && usable(m)) ?? rev.find(usable) ?? msgs.at(-1);
		const self = selfSet();
		const notSelf = (a: string) => a && !self.has(baseAddr(a));
		const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean).map((x) => x.toLowerCase()))];
		let primary = base?.outbound
			? (base.to[0] ?? base.cc[0] ?? '')
			: base?.replyTo || base?.from || '';
		// Audience: an explicit per-message Reply(-all) scopes to THAT message; the
		// default docked composer is thread-level, so its Reply-all reaches every
		// participant — else a private reply-to-one as the latest inbound would
		// hide the Reply/Reply-all switch even on a multi-party thread.
		const audMsgs = chosen ? [chosen] : msgs;
		const toAll = uniq([
			primary,
			...audMsgs.flatMap((m) => [m.from ?? '', ...m.to])
		]).filter(notSelf);
		const ccAll = uniq(audMsgs.flatMap((m) => m.cc)).filter((a) => notSelf(a) && !toAll.includes(a));
		// Last resort (explicitly-targeted message without a From): reply to the
		// first non-self participant rather than hiding the composer.
		if (!primary) primary = toAll[0] ?? ccAll[0] ?? '';
		return {
			target: primary,
			toAll,
			ccAll,
			aliasId: base?.viaAliasId ?? null,
			parent: base,
			// Explicit target drives the composer's opening scope + auto-expand.
			scope: (chosen ? target!.scope : 'reply') as 'reply' | 'reply_all',
			autoOpen: !!chosen
		};
	}

	// Remote images (tracking pixels) are blocked by default via CSP inside the
	// sandboxed iframe; the user can opt in per message. The doc body is
	// transparent with a mode-matched text color, so plain emails follow the app
	// theme (the iframe element paints bg-card); emails that hardcode their own
	// background keep it — same stance as Gmail's "original" view.
	const loadedImages = new SvelteSet<string>();
	// "Always load images from this sender" (Gmail/Fastmail): flips the reader's
	// default for that sender server-side; senderTrusted comes back via getThread.
	async function setSenderTrust(m: MessageDTO, trusted: boolean) {
		if (!m.from) return;
		if (trusted) loadedImages.add(m.id); // instant feedback, refresh confirms
		else loadedImages.delete(m.id);
		await setSenderImageTrust({ sender: m.from, trusted });
		await threadQ?.refresh();
	}

	// Local RSVP for calendar invites (organizer NOT notified). Optimistic: the
	// override map flips the card's pressed state instantly; a failed persist
	// reverts. Keyed by event UID so every message of the same event agrees.
	const inviteRsvp = new SvelteMap<string, InviteRsvpStatus>();
	function inviteFor(m: MessageDTO): CalendarInviteDTO {
		const inv = m.calendarInvite!;
		return { ...inv, myRsvp: inviteRsvp.get(inv.uid) ?? inv.myRsvp };
	}
	// The original .ics attachment (organiser's exact copy) — powers "Download
	// invite" over the card's re-serialised fallback.
	function inviteIcsHref(m: MessageDTO): string | null {
		const a = m.attachments.find(
			(x) => x.contentType?.includes('calendar') || x.filename?.toLowerCase().endsWith('.ics')
		);
		return a ? `/api/attachments/${a.id}` : null;
	}
	// Invite messages hide the providers' boilerplate mail body by default (the
	// card IS the content); "Show original message" reveals it per message.
	const showOriginal = new SvelteSet<string>();
	async function rsvp(m: MessageDTO, status: InviteRsvpStatus) {
		const inv = m.calendarInvite;
		if (!mailboxId || !threadId || !inv) return;
		const prev = inviteRsvp.get(inv.uid) ?? inv.myRsvp;
		inviteRsvp.set(inv.uid, status);
		try {
			await setInviteRsvp({ mailboxId, threadId, uid: inv.uid, status });
		} catch {
			if (prev) inviteRsvp.set(inv.uid, prev);
			else inviteRsvp.delete(inv.uid);
			toast.error('Could not save your response.');
		}
	}

	// In-thread retry for a failed send (visible to its author only — server
	// re-checks ownership). The live mailEvents stream refreshes ticks as the
	// requeued submission moves; the immediate refresh() clears the banner.
	let retryingSubId = $state<string | null>(null);
	async function retrySend(submissionId: string) {
		retryingSubId = submissionId;
		try {
			await runWithToast('Retrying send…', 'Retry failed — try again in a moment.', () => retrySendById({ submissionId }), {
				done: (id) => {
					toast.success('Retrying — sending again.', { id });
					void refresh();
				}
			});
		} finally {
			retryingSubId = null;
		}
	}

	// Single-pane slide (mobile): opening a thread slides it in from the right,
	// closing slides back — the list↔thread swap reads as navigation instead of a
	// hard swap. View Transitions API; skipped for two-pane widths, reduced
	// motion, and unsupported browsers (hard swap remains the fallback).
	onNavigate((navigation) => {
		if (!('startViewTransition' in document)) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		if (matchMedia('(min-width: 72rem)').matches) return; // two-pane: no slide
		const from = navigation.from?.url.searchParams.get('thread');
		const to = navigation.to?.url.searchParams.get('thread');
		if (!!from === !!to) return; // only the open/close swap animates
		document.documentElement.dataset.threadNav = to ? 'open' : 'close';
		return new Promise((resolve) => {
			const t = (document as Document & { startViewTransition: (cb: () => Promise<void>) => { finished: Promise<void> } }).startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
			t.finished.finally(() => delete document.documentElement.dataset.threadNav);
		});
	});

	// "[Message clipped] View entire message" — shallow-routed (back button/swipe
	// closes it): desktop gets a dialog, mobile the drawer, both loading the
	// raised-cap ?full=1 render in the same sandboxed frame.
	// Image-attachment lightbox — shallow-routed like the full-message view.
	function openLightbox(att: { id: string; filename: string | null }) {
		pushState('', { lightbox: { id: att.id, name: att.filename ?? 'image' } });
	}

	function openFullView(id: string, images: boolean) {
		pushState('', { fullMessage: { id, images } });
	}

	// A mailto: link inside a message opens Doota's composer, not the OS handler.
	// ?subject=&body= params prefill the draft, like OS mail handlers do.
	function openMailto(address: string, extra?: { subject?: string; body?: string }) {
		if (!mailboxId || !address) return;
		compose.start({
			prefill: { kind: 'new', mailboxId, to: address, subject: extra?.subject || undefined, body: extra?.body || undefined }
		});
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
	// Prefer the display name the sending provider actually put in the mail data
	// (fromName) over splitting the email — falls back to the header parse / local
	// part when a bare address is all we have (e.g. pre-fromName mail).
	const senderLabel = (m: { fromName?: string | null; from: string | null }): string =>
		m.fromName?.trim() || senderName(m.from);
	// The bare email out of a `from` header ("Name <addr>" or a bare address) —
	// the contact hover card keys on this.
	const senderAddr = (from: string | null): string =>
		(from?.match(/<([^>]+)>/)?.[1] ?? from ?? '').trim();

	// Everyone the conversation has touched: the union of from/to/cc across ALL
	// messages — so a bcc'd party who replies-all enters the list the moment
	// their own message (with them in `from`) lands in the thread.
	function participants(msgs: MessageDTO[]): { address: string; name: string; mine: boolean }[] {
		const mine = new Set(
			[activeMailbox?.address, ...msgs.map((m) => m.viaAlias)]
				.filter((a): a is string => !!a)
				.map((a) => a.toLowerCase())
		);
		const seen = new Map<string, { address: string; name: string; mine: boolean }>();
		const add = (raw: string | null) => {
			if (!raw) return;
			const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
			if (!address.includes('@') || seen.has(address)) return;
			seen.set(address, { address, name: senderName(raw), mine: mine.has(address) });
		};
		for (const m of msgs) {
			add(m.from);
			for (const a of m.to) add(a);
			for (const a of m.cc) add(a);
		}
		return [...seen.values()];
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
	// Briefly highlight a message after jumping to it (WhatsApp reply-jump feel).
	let flashMsgId = $state<string | null>(null);
	/** Scroll a message into view; in mail view, expand it first if collapsed.
	 * On mobile the drawer covers the stream, so jumping closes it. */
	function jumpToMsg(id: string, isLast: boolean) {
		if (isMobile.current) attachmentsOpen = false;
		if (threadView.current === 'mail' && !msgOpen(id, isLast)) toggleMsg(id);
		const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
		requestAnimationFrame(() => {
			streamEl?.querySelector(`[data-msg="${id}"]`)?.scrollIntoView({ behavior, block: 'center' });
		});
		flashMsgId = id;
		setTimeout(() => {
			if (flashMsgId === id) flashMsgId = null;
		}, 1300);
	}

	// Find-in-thread: a lightweight Cmd-F scoped to the open conversation. Matches
	// against the plaintext we already hold (subject / stripped body / sender) and
	// jumps between matching messages — rich HTML lives in the sandboxed frame, so
	// this locates the message, it doesn't highlight inside the frame. Client-only.
	let findOpen = $state(false);
	let findQ = $state('');
	let findIdx = $state(0);
	const threadMsgs = $derived(
		(openDto?.items ?? []).filter((i): i is MessageDTO => i.type === 'external_message')
	);
	const lastMsgId = $derived(threadMsgs.at(-1)?.id);
	const findMatches = $derived.by(() => {
		const term = findQ.trim().toLowerCase();
		if (!term) return [] as string[];
		return threadMsgs
			.filter((m) =>
				[m.subject, m.bodyStripped, m.bodyFull, m.from].some((s) => s?.toLowerCase().includes(term))
			)
			.map((m) => m.id);
	});
	// Single jump driver: whenever the match set or cursor changes (typing, or
	// prev/next), clamp and jump to the current match. findStep only moves the
	// cursor; this effect does the scrolling.
	$effect(() => {
		const n = findMatches.length;
		if (!n) return;
		if (findIdx >= n) findIdx = 0;
		const id = findMatches[findIdx];
		if (id) jumpToMsg(id, id === lastMsgId);
	});
	function findStep(dir: 1 | -1) {
		const n = findMatches.length;
		if (!n) return;
		findIdx = (findIdx + dir + n) % n;
	}
	function closeFind() {
		findOpen = false;
		findQ = '';
		findIdx = 0;
	}
	// Reset find when the open thread changes — a query from one conversation
	// shouldn't carry into the next.
	$effect(() => {
		void openDto?.id;
		untrack(() => {
			if (findOpen || findQ) closeFind();
		});
	});

	// Compose (Forward / resume Draft / new) routes through the shared controller;
	// the single ComposePanel is mounted in the (app) layout.
	// The composer editor reads HTML, so forwarded content is built as HTML — a
	// plain-text body with \n renders as one flat line. Text twin + <br> keeps it
	// reliable in the editor (rich-template fidelity is limited by TipTap).
	const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	function fwdBlock(m: MessageDTO): string {
		const orig = escHtml(m.bodyFull ?? m.bodyStripped ?? '').replace(/\r?\n/g, '<br>');
		const header = [
			`From: ${m.from ?? ''}`,
			m.sentAt ? `Date: ${new Date(m.sentAt).toLocaleString()}` : '',
			`Subject: ${m.subject ?? ''}`,
			m.to.length ? `To: ${m.to.join(', ')}` : ''
		]
			.filter(Boolean)
			.map((l) => `<p>${escHtml(l)}</p>`)
			.join('');
		return `${header}<blockquote>${orig}</blockquote>`;
	}
	// A forward starts a NEW conversation (Gmail/Superhuman/Fastmail): no threadId,
	// no In-Reply-To — otherwise it threads into the source conversation.
	function startForward(subject: string | null, header: string, blocks: string) {
		if (!mailboxId) return;
		compose.start({
			prefill: {
				kind: 'forward',
				mailboxId,
				threadId: null,
				inReplyToMessageId: null,
				subject: replySubject(subject, 'forward'),
				body: `<p></p><p>${header}</p>${blocks}`
			}
		});
	}
	function forward(parent: MessageDTO, subject: string | null) {
		startForward(parent.subject ?? subject, '---------- Forwarded message ----------', fwdBlock(parent));
	}
	// Whole-thread forward: every message stacked oldest→newest as quoted blocks.
	function forwardThread(msgs: MessageDTO[], subject: string | null) {
		const blocks = msgs.map((m) => fwdBlock(m)).join('<p></p>');
		startForward(subject, '---------- Forwarded conversation ----------', blocks);
	}
	function openDraft(id: string) {
		compose.start({ resumeDraftId: id });
	}
	function composeNew() {
		if (!mailboxId) return;
		compose.start({ prefill: { kind: 'new', mailboxId } });
	}
	// Optimistic: hide the row the instant Cancel/Edit is clicked so it feels
	// instant, while the undo RPC (which does a chain of DB work) runs in the
	// background. On failure we restore the row.
	let hiddenScheduled = $state<string[]>([]);
	async function cancelScheduled(submissionId: string) {
		hiddenScheduled = [...hiddenScheduled, submissionId];
		try {
			await undoDraftById({ submissionId });
		} catch {
			hiddenScheduled = hiddenScheduled.filter((x) => x !== submissionId);
			toast.error('Could not cancel — it may have already sent.');
			return;
		}
		await scheduledSends().refresh();
		// Row is gone from the source now — drop the optimistic-hide entry so the
		// set can't grow unbounded across a session.
		hiddenScheduled = hiddenScheduled.filter((x) => x !== submissionId);
	}
	async function editScheduled(submissionId: string, sendAt: number) {
		hiddenScheduled = [...hiddenScheduled, submissionId];
		let res: Awaited<ReturnType<typeof undoDraftById>>;
		try {
			res = await undoDraftById({ submissionId });
		} catch {
			hiddenScheduled = hiddenScheduled.filter((x) => x !== submissionId);
			toast.error('Could not edit — it may have already sent.');
			return;
		}
		if (res.restored && res.draft) {
			// Reopen the restored draft with its original send time preserved.
			compose.start({ resumeDraftId: res.draft.id, scheduleAt: sendAt });
			await scheduledSends().refresh();
			hiddenScheduled = hiddenScheduled.filter((x) => x !== submissionId);
		} else {
			hiddenScheduled = hiddenScheduled.filter((x) => x !== submissionId);
			toast.error('This send already went out.');
		}
	}

	// Escape walks back out: attachments panel first, then the open thread.
	// Dialogs/drawers (composer, palette) preventDefault their own Esc — skip those.
	// Keyboard shortcuts (Gmail/Superhuman baseline). `c` compose lives in the
	// (app) layout; ⌘K search in the command palette. Guard: never while typing
	// or inside a dialog, and only unmodified keys.
	function onPageKeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement;
		if (t?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
		if (e.key === 'Escape') {
			if (findOpen) {
				closeFind();
			} else if (attachmentsOpen) {
				attachmentsOpen = false;
			} else if (threadId) {
				nav({ thread: null });
			}
			return;
		}
		// `/` opens find-in-thread when a thread is open (Gmail/Superhuman).
		if (e.key === '/' && threadId) {
			e.preventDefault();
			findOpen = true;
			return;
		}
		if (e.key === 'j' || e.key === 'k') {
			// Move the cursor highlight; the open is debounced (see moveCursor).
			if (!items.length) return;
			e.preventDefault();
			moveCursor(e.key === 'j' ? 1 : -1);
			return;
		}
		// Enter opens the cursor's thread now, skipping the debounce.
		if (e.key === 'Enter' && navCursor && navCursor !== threadId) {
			e.preventDefault();
			commitCursor();
			return;
		}
		if (e.key === 'e') {
			if (!threadId) return;
			e.preventDefault();
			void move('archived');
			return;
		}
		if (e.key === 'r' || e.key === 'a' || e.key === 'f') {
			const msgs = (openDto?.items ?? []).filter((i) => i.type === 'external_message') as MessageDTO[];
			if (!msgs.length) return;
			e.preventDefault();
			if (e.key === 'f') {
				forward(msgs.at(-1)!, openDto?.subject ?? null);
			} else {
				// Same default audience as the docked composer: latest inbound, else newest.
				const base = [...msgs].reverse().find((m) => !m.outbound) ?? msgs.at(-1)!;
				void replyTo(base, e.key === 'a' ? 'reply_all' : 'reply');
			}
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

<!-- End-of-list marker: shown only once real pagination is exhausted (≥ a full
     page loaded). A hand-drawn curled cat keeps the empty space warm instead of
     an abrupt cutoff. currentColor inherits the muted tone; ears/body use a
     faint fill of the same. -->
{#snippet listEnd()}
	<div class="text-faint flex flex-col items-center gap-2 py-8 select-none">
		<svg viewBox="0 0 72 52" width="64" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<!-- curled loaf body -->
			<path d="M12 42 C12 26 22 20 36 20 C50 20 60 26 60 42 Z" fill="currentColor" fill-opacity="0.08" />
			<!-- ears -->
			<path d="M25 22 L22 13 L31 18 Z" fill="currentColor" fill-opacity="0.08" />
			<path d="M47 22 L50 13 L41 18 Z" fill="currentColor" fill-opacity="0.08" />
			<!-- sleepy closed eyes -->
			<path d="M27 31 q3 2.5 6 0" />
			<path d="M39 31 q3 2.5 6 0" />
			<!-- nose + mouth -->
			<path d="M35 35 l1 1.2 l1 -1.2" />
			<!-- whiskers -->
			<path d="M29 36 h-8" />
			<path d="M43 36 h8" />
			<!-- tail curling back over the loaf -->
			<path d="M60 42 q9 -1 7 -11 q-1 -6 -7 -3" />
		</svg>
		<p class="text-xs font-medium">That's the end of {folder.name.toLowerCase()}</p>
		<p class="text-[11px]">The cat's got the rest. Nothing more to load.</p>
	</div>
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
		{#if sub.mine && (FAILED_SEND_STATUSES as readonly string[]).includes(sub.status)}
			<button
				type="button"
				disabled={retryingSubId === sub.id}
				onclick={() => retrySend(sub.id)}
				class="border-destructive/40 hover:bg-destructive/15 focus-visible:ring-ring/50 mt-1.5 rounded border px-2 py-0.5 font-semibold transition-colors outline-none focus-visible:ring-2 disabled:opacity-50"
			>
				{retryingSubId === sub.id ? 'Retrying…' : 'Retry send'}
			</button>
		{/if}
	</div>
{/snippet}

<!-- Per-message reply/reply-all/forward. Retargets the docked composer to THIS
     message (unambiguous audience) instead of the thread-level guess. -->
{#snippet msgActions(m: MessageDTO, align: 'start' | 'end', subject: string | null)}
	<div class="mt-1 flex items-center gap-0.5 {align === 'end' ? 'justify-end' : ''}">
		<button
			type="button"
			title="Reply"
			onclick={() => replyTo(m, 'reply')}
			class="text-faint hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-6 place-items-center rounded-md transition-colors outline-none focus-visible:ring-2"
		>
			<ReplyIcon class="size-3.5" />
		</button>
		{#if msgCanReplyAll(m)}
			<button
				type="button"
				title="Reply all"
				onclick={() => replyTo(m, 'reply_all')}
				class="text-faint hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-6 place-items-center rounded-md transition-colors outline-none focus-visible:ring-2"
			>
				<ReplyAllIcon class="size-3.5" />
			</button>
		{/if}
		<button
			type="button"
			title="Forward"
			onclick={() => forward(m, subject)}
			class="text-faint hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-6 place-items-center rounded-md transition-colors outline-none focus-visible:ring-2"
		>
			<ForwardIcon class="size-3.5" />
		</button>
	</div>
{/snippet}

<!-- "Only visible to you" chip: shows on a message that reached fewer people than
     the thread has (a reply-to-one), so the sender knows it's private. -->
{#snippet visibilityChip(m: MessageDTO, parts: Set<string>)}
	{@const priv = msgPrivateTo(m, parts)}
	{#if priv}
		<span
			class="text-warn border-warn/25 bg-warn/10 mt-1 inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium"
			title="Not everyone on this thread can see this message"
		>
			<LockIcon class="size-2.5 shrink-0" />
			Only you{priv.length ? ` & ${priv.map((a) => senderName(a)).join(', ')}` : ''} can see this
		</span>
	{/if}
{/snippet}

<!-- Plain-text bodies with URLs/emails made clickable — segment render, no
     {@html}, so linkification can never introduce markup. Kept on single lines:
     the container is whitespace-pre-wrap and template newlines would show. -->
{#snippet linkedText(text: string)}
	{#each linkifySegments(text) as s, i (i)}{#if s.type === 'link'}<a href={s.href} target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 break-all">{s.value}</a>{:else if s.type === 'email'}<button type="button" class="underline underline-offset-2 break-all" onclick={() => openMailto(s.address)}>{s.value}</button>{:else}{s.value}{/if}{/each}
{/snippet}

<!-- Reply context above a reply. parentId set → the parent is in this thread: a
     one-line clickable jump. parentId null → this Cc'd mailbox can't see the
     parent, so show the FULL prior message (never half). -->
{#snippet replyContextNote(m: MessageDTO)}
	{#if m.replyContext}
		{@const rc = m.replyContext}
		{#if rc.parentId}
			<button
				type="button"
				title="Go to the replied message"
				onclick={() => jumpToMsg(rc.parentId!, false)}
				class="border-brand/40 bg-brand/5 text-muted-foreground hover:bg-brand/10 mb-1.5 flex w-full max-w-full items-center gap-1 rounded border-l-2 py-0.5 pr-1 pl-2 text-left text-[11px] leading-snug transition-colors"
			>
				<span class="text-brand shrink-0 font-medium">{senderName(rc.from)}</span>
				<span class="truncate opacity-80">{rc.text}</span>
			</button>
		{:else}
			<!-- Hidden ancestor chain (added-on-Cc): oldest first, immediate parent last. -->
			{#each rc.ancestors ?? [] as a (a.sentAt ?? a.text)}
				<div class="border-border text-faint mb-1.5 rounded border-l-2 py-1 pr-1 pl-2 text-[11px] leading-snug">
					<div class="text-muted-foreground mb-0.5">↳ Earlier from {senderName(a.from)}</div>
					<div class="max-h-40 overflow-y-auto whitespace-pre-wrap opacity-70">{a.text}</div>
				</div>
			{/each}
			<div class="border-border text-faint mb-1.5 rounded border-l-2 py-1 pr-1 pl-2 text-[11px] leading-snug">
				<div class="text-muted-foreground mb-0.5">↳ Earlier from {senderName(rc.from)}</div>
				<div class="max-h-40 overflow-y-auto whitespace-pre-wrap opacity-70">{rc.text}</div>
			</div>
		{/if}
	{/if}
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
			{#if !searchQ}
				<button
					type="button"
					title="Refresh"
					aria-label="Refresh"
					disabled={refreshing}
					onclick={manualRefresh}
					class="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring/50 grid size-8 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 disabled:opacity-60"
				>
					<RefreshCwIcon class="size-4 {refreshing ? 'animate-spin' : ''}" />
				</button>
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
		{#if !isVirtual && !searchQ}
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

		<!-- Persistent selection bar (threads + drafts): select-all always
		     available, actions disabled until something is selected, count shown
		     in the bar and as a badge on Delete. Always mounted → zero shift. -->
		{#if (!isVirtual && !searchQ) || placement === 'drafts'}
			{@const inDrafts = placement === 'drafts'}
			{@const visibleIds = inDrafts
				? (myDrafts().current ?? []).map((d) => d.id)
				: applyListFilters(items).map((t) => t.threadId)}
			{@const sel = inDrafts ? draftSel : threadSel}
			{@const n = sel.size}
			{@const allSelected = visibleIds.length > 0 && visibleIds.every((id) => sel.has(id))}
			<div class="bg-card/60 flex h-10 items-center gap-2 border-b px-3">
				<!-- Gmail semantics: empty → select all visible; anything → clear. -->
				<Checkbox
					checked={allSelected}
					indeterminate={n > 0 && !allSelected}
					aria-label={n > 0 ? 'Clear selection' : 'Select all'}
					onCheckedChange={() => {
						if (n > 0) sel.clear();
						else for (const id of visibleIds) sel.add(id);
					}}
				/>
				<span class="text-muted-foreground text-xs tabular-nums">
					{n > 0 ? `${n} selected` : 'Select all'}
				</span>
				<div class="ml-auto flex items-center gap-0.5">
					{#if !inDrafts}
						<Button variant="ghost" size="icon" class="size-7" title="Mark read" disabled={!n || bulkBusy} onclick={() => bulkRead(true)}>
							<MailOpenIcon class="size-4" />
						</Button>
						<Button variant="ghost" size="icon" class="size-7" title="Mark unread" disabled={!n || bulkBusy} onclick={() => bulkRead(false)}>
							<MailIcon class="size-4" />
						</Button>
						{#if placement !== 'inbox'}
							<Button variant="ghost" size="icon" class="size-7" title="Move to inbox" disabled={!n || bulkBusy} onclick={() => bulkMove('inbox')}>
								<InboxIcon class="size-4" />
							</Button>
						{/if}
						{#if placement !== 'archived'}
							<Button variant="ghost" size="icon" class="size-7" title="Archive" disabled={!n || bulkBusy} onclick={() => bulkMove('archived')}>
								<ArchiveIcon class="size-4" />
							</Button>
						{/if}
						{#if placement !== 'spam'}
							<Button variant="ghost" size="icon" class="size-7" title="Mark spam" disabled={!n || bulkBusy} onclick={() => bulkMove('spam')}>
								<ShieldAlertIcon class="size-4" />
							</Button>
						{/if}
					{/if}
					{#if inDrafts || placement !== 'trash'}
						<Button
							variant="ghost"
							size="icon"
							class="hover:text-destructive relative size-7"
							title="Delete"
							disabled={!n || (inDrafts ? deletingDrafts : bulkBusy)}
							onclick={() => (inDrafts ? deleteDrafts([...draftSel]) : bulkMove('trash'))}
						>
							{#if inDrafts && deletingDrafts}
								<Spinner class="size-4" />
							{:else}
								<Trash2Icon class="size-4" />
							{/if}
							{#if n > 0}
								<span class="bg-destructive text-destructive-foreground absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full px-0.5 text-[9px] leading-4 font-semibold tabular-nums">
									{n > 99 ? '99+' : n}
								</span>
							{/if}
						</Button>
					{/if}
				</div>
			</div>
		{/if}
		<!-- min-h-0: without it a flex-1 overflow child won't bound/scroll on iOS
		     Safari (the dead search scroll). overscroll-contain stops the rubber-band
		     from propagating to the page (the inbox bounce). -->
		<div
			bind:this={listEl}
			class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
			onscroll={onListScroll}
			use:pullToRefresh={{
				enabled: coarsePointer,
				onRefresh: refreshCurrentList,
				onProgress: (r) => (pullProg = r),
				onBusy: (b) => (pullBusy = b)
			}}
		>
			<!-- Pull-to-refresh indicator: floats over the list top, travels with the
			     pull, arms (accent + full rotation) past the threshold, spins while
			     the reload runs. Zero-height sticky wrapper — no layout shift. -->
			{#if pullProg > 0 || pullBusy}
				<div class="pointer-events-none sticky top-0 z-10 flex h-0 justify-center">
					<div
						class="bg-card grid size-9 place-items-center rounded-full border shadow-sm"
						style="transform: translateY({Math.round(pullProg * 52 - 44)}px); opacity: {Math.min(pullProg * 1.6, 1)}"
					>
						<!-- Arrow tracks the pull (points up once armed), then morphs into
						     the spinner on release — scale/blur crossfade, no icon jump. -->
						<ArrowDownIcon
							class="col-start-1 row-start-1 size-4 transition-all duration-200 motion-reduce:transition-none {pullProg >= 1 ? 'text-brand' : 'text-muted-foreground'} {pullBusy ? 'scale-50 opacity-0 blur-[2px]' : ''}"
							style="transform: rotate({Math.round(Math.min(pullProg, 1) * 180)}deg)"
						/>
						<LoaderCircleIcon
							class="text-brand col-start-1 row-start-1 size-4 animate-spin transition-all duration-200 motion-reduce:animate-none motion-reduce:transition-none {pullBusy ? '' : 'scale-50 opacity-0 blur-[2px]'}"
						/>
					</div>
				</div>
			{/if}
			<!-- The list itself rides the pull (native feel): follows the finger
			     with no transition mid-drag, holds down while refreshing, eases
			     back once done. Transform only exists during the gesture. -->
			<div
				class={pullBusy || pullProg === 0 ? 'transition-transform duration-200 ease-out motion-reduce:transition-none' : ''}
				style={pullProg > 0 ? `transform: translateY(${Math.round(pullProg * 56)}px)` : ''}
			>
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
									<span class="block truncate text-[13px] text-muted-foreground">
										{#if hit.subject}<Highlight text={hit.subject} terms={hit.terms} />{:else}(no subject){/if}
									</span>
									<span class="text-muted-foreground line-clamp-1 text-xs"><Highlight text={hit.snippet} terms={hit.terms} /></span>
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
							{@const dfx = rowFx.get(d.id)}
							{@const deleting = pendingDelete.has(d.id)}
							<div
								animate:flip={{ duration: 200 }}
								out:exitFx={{ kind: dfx }}
								aria-busy={deleting}
								class="group/row group/draft flex items-start border-b py-2.5 pl-3 transition-[opacity,background-color] duration-150 {deleting ? 'pointer-events-none opacity-45' : ''} {draftSel.has(d.id) ? 'bg-accent/50' : 'hover:bg-muted/50'}"
							>
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
									disabled={deleting}
									onclick={() => deleteDrafts([d.id])}
									class="text-muted-foreground hover:text-destructive focus-visible:ring-ring/50 pointer-coarse:opacity-100 mr-2 grid size-8 shrink-0 place-items-center self-center rounded-lg opacity-0 transition-opacity outline-none group-hover/draft:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 {deleting ? 'opacity-100' : ''}"
								>
									{#if deleting}<Spinner class="size-4" />{:else}<Trash2Icon class="size-4" />{/if}
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
					{@const items = schedQ.current.filter((s) => !hiddenScheduled.includes(s.submissionId))}
					{#if items.length}
						{#each items as s (s.submissionId)}
							<div class="flex gap-3 border-b px-3 py-2.5">
								{@render monogram(s.to ?? null, 'mt-0.5 size-9 text-xs')}
								<div class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{s.to ? senderName(s.to) : '—'}</span>
									<span class="block truncate text-[13px] text-muted-foreground">{s.subject || '(no subject)'}</span>
									<div class="mt-1 flex items-center justify-between">
										<span class="text-brand inline-flex items-center gap-1 text-xs font-medium"><ClockIcon class="size-3" /> Sends {fmtTime(s.sendAt)}</span>
										<div class="flex items-center gap-3">
												<button type="button" class="text-muted-foreground hover:text-foreground text-xs underline" onclick={() => editScheduled(s.submissionId, s.sendAt)}>Edit</button>
												<button type="button" class="text-muted-foreground hover:text-destructive text-xs underline" onclick={() => cancelScheduled(s.submissionId)}>Cancel</button>
											</div>
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
							{@const selected = (navCursor ?? threadId) === t.threadId}
							{@const checked = threadSel.has(t.threadId)}
							{@const fx = rowFx.get(t.threadId)}
							{@const prog = swipeProg.get(t.threadId) ?? 0}
							{@const rightTarget = (placement === 'archived' ? 'inbox' : 'archived') as 'inbox' | 'archived'}
							<div
								data-row={t.threadId}
								animate:flip={{ duration: 200 }}
								out:exitFx={{ kind: fx }}
								class="relative overflow-hidden border-b {fx === 'pulse' ? PULSE_CLASS : ''}"
							>
								<!-- Swipe action reveal — rendered only mid-gesture, never idle. -->
								{#if prog > 0}
									<div class="absolute inset-0 flex items-center {rightTarget === 'inbox' ? 'bg-brand/15' : 'bg-ok/15'} pl-5">
										{#if rightTarget === 'inbox'}<InboxDownIcon class="text-brand size-5" />{:else}<ArchiveIcon class="text-ok size-5" />{/if}
									</div>
								{:else if prog < 0}
									<div class="bg-destructive/15 absolute inset-0 flex items-center justify-end pr-5">
										<Trash2Icon class="text-destructive size-5" />
									</div>
								{/if}
								<div
									use:swipeX={{
										enabled: () => coarsePointer() && !threadSel.size,
										onRight: () => moveRow(t.threadId, rightTarget),
										onLeft: placement === 'trash' ? undefined : () => moveRow(t.threadId, 'trash'),
										onProgress: (r) => {
											if (r === 0) swipeProg.delete(t.threadId);
											else swipeProg.set(t.threadId, r);
										}
									}}
									class="group/row bg-background relative flex items-start py-2.5 pl-3 transition-colors {selected ? 'bg-accent' : checked ? 'bg-accent' : 'hover:bg-muted/50'}"
								>
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
										<span class="flex-1 truncate text-sm {t.unread ? 'text-foreground font-semibold' : 'text-foreground/90 font-medium'}">{senderLabel(t)}</span>
										<span class="text-faint shrink-0 text-[11px] tabular-nums">{relTime(t.lastMessageAt)}</span>
									</div>
									<div class="flex items-center gap-1.5">
										{#if t.unread}<span class="bg-brand size-1.5 shrink-0 rounded-full"></span>{/if}
										<!-- Sent is a cross-cut view — flag rows that also live in the Inbox. -->
										{#if placement === 'sent' && t.placement === 'inbox'}
											<span class="bg-brand/10 text-brand shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">Inbox</span>
										{/if}
										<span class="min-w-0 flex-1 truncate text-[13px] {t.unread ? 'text-foreground font-medium' : 'text-muted-foreground'}">{t.subject ?? '(no subject)'}</span>
										{#if t.hasNotes}<StickyNoteIcon class="text-warn size-3.5 shrink-0" />{/if}
										{#if t.assigneeUserId}<UserRoundIcon class="text-brand size-3.5 shrink-0" />{/if}
										{#if t.isStarred}<StarIcon class="text-p3 size-3.5 shrink-0 fill-current" />{/if}
									</div>
									<span class="text-muted-foreground mt-0.5 line-clamp-1 text-xs">{t.snippet ?? ''}</span>
								</div>
							</button>
								</div>
							</div>
						{/each}
						{#if loadingList}
							<div class="flex justify-center py-3"><Spinner class="text-muted-foreground size-4" /></div>
						{:else if reachedEnd && applyListFilters(items).length}
							{@render listEnd()}
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
		</div>

		<!-- Compose FAB for every single-pane width: the sidebar (and its Compose)
		     is a sheet until md, and the top bar carries no compose — without this
		     there is NO way to start a mail on phones/small tablets. Hidden only
		     once the container splits two-pane (@4xl), where the docked sidebar's
		     Compose takes over. Lives inside the list pane so opening a thread
		     (which hides the pane) hides it too. -->
		{#if mailboxId}
			<button
				type="button"
				aria-label="Compose"
				onclick={composeNew}
				class="bg-brand text-brand-foreground focus-visible:ring-ring/50 @4xl:hidden absolute right-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-10 grid size-13 place-items-center rounded-full shadow-lg transition-transform outline-none focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-95"
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
					{@const parts = threadParticipants(msgs)}
					{@const ctx = replyCtx(msgs, replyTarget)}
					{@const attTotal = msgs.reduce((n, m) => n + m.attachments.length, 0)}
					{@const ppl = participants(msgs)}
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
						<!-- Who's on the thread, at a glance (group threads read instantly). -->
						{#if ppl.length > 1}
							<div class="hidden items-center gap-1.5 md:flex" title={ppl.map((pp) => pp.name).join(', ')}>
								<AvatarGroup>
									{#each ppl.slice(0, 4) as pp (pp.address)}
										<SenderAvatar from={pp.address} class="ring-background size-6 rounded-full text-[9px] ring-2" />
									{/each}
								</AvatarGroup>
								{#if ppl.length > 4}<span class="text-faint text-[10px] tabular-nums">+{ppl.length - 4}</span>{/if}
							</div>
						{/if}
						{#if isShared && !canManageActive}
							<!-- Assignment is manager-only; everyone else just sees who holds it. -->
							<span class="text-muted-foreground inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs">
								<UserRoundIcon class="size-3.5 {openAssignee ? 'text-brand' : ''}" />
								<span class="max-w-[12ch] truncate">{openAssignee ? short(openAssignee, members) : 'Unassigned'}</span>
							</span>
						{:else if isShared}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button variant="outline" size="sm" class="h-8 gap-1.5" {...props}>
											<UserRoundIcon class="size-3.5 {openAssignee ? 'text-brand' : ''}" />
											<span class="max-w-[12ch] truncate text-xs">{openAssignee ? short(openAssignee, members) : 'Unassigned'}</span>
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content class="w-56" align="end">
									<DropdownMenu.Label class="text-muted-foreground text-xs">Assign to</DropdownMenu.Label>
									{#each members as mem (mem.userId)}
										<DropdownMenu.Item onSelect={() => assign(mem.userId)}>
											<span class="flex-1 truncate">{mem.name}</span>
											{#if openAssignee === mem.userId}<CheckIcon class="size-4" />{/if}
										</DropdownMenu.Item>
									{/each}
									{#if openAssignee}
										<DropdownMenu.Separator />
										<DropdownMenu.Item onSelect={() => assign(null)}>Unassign</DropdownMenu.Item>
									{/if}
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}

						<!-- Who's in this conversation — union of every message's from/to/cc,
						     so late reply-all joiners (even originally bcc'd) show up. -->
						{#if ppl.length}
							<Popover.Root>
								<Popover.Trigger>
									{#snippet child({ props })}
										<!-- Plain button, same shape as the attachments-badge button — the
										     Button component's slot styling displaced the corner badge. -->
										<button
											type="button"
											title="Participants"
											{...props}
											class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 relative grid size-8 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2"
										>
											<UsersIcon class="size-4" />
											<span class="bg-card text-muted-foreground absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full border text-[9px] font-semibold shadow-xs">{ppl.length > 9 ? '9+' : ppl.length}</span>
										</button>
									{/snippet}
								</Popover.Trigger>
								<Popover.Content class="w-72 p-2" align="end">
									<p class="text-muted-foreground px-2 pt-1 pb-1.5 text-xs font-medium">In this conversation</p>
									<div class="flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain">
										{#each ppl as p (p.address)}
											<div class="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
												{@render monogram(p.address, 'size-7 text-[10px]')}
												<div class="min-w-0 flex-1">
													<p class="truncate text-sm leading-tight">{p.name}</p>
													<p class="text-muted-foreground truncate font-mono text-[11px] leading-tight">{p.address}</p>
												</div>
												{#if p.mine}
													<span class="bg-brand/10 text-brand shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">You</span>
												{/if}
											</div>
										{/each}
									</div>
								</Popover.Content>
							</Popover.Root>
						{/if}

						<!-- Interact: find-in-thread + star + forward (step back on phones — star also lives on list rows) -->
						{#if msgs.length}
							<Tooltip.Provider delayDuration={600}>
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<Button {...props} variant="ghost" size="icon" class="text-muted-foreground hidden size-8 sm:inline-flex" aria-pressed={findOpen} onclick={() => (findOpen ? closeFind() : (findOpen = true))}>
												<SearchIcon class="size-4" />
												<span class="sr-only">Find in conversation</span>
											</Button>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content class="flex items-center gap-1.5">Find in conversation <Kbd>/</Kbd></Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
						{/if}
						<Button variant="ghost" size="icon" class="text-muted-foreground hidden size-8 sm:inline-flex" title={openStarred ? 'Unstar' : 'Star'} onclick={() => toggleStar(openStarred)}>
							<StarIcon class="size-4 {openStarred ? 'text-p3 fill-current' : ''}" />
						</Button>
						{#if msgs.length}
							<Button variant="ghost" size="icon" class="text-muted-foreground hidden size-8 sm:inline-flex" title="Forward conversation" onclick={() => forwardThread(msgs, thread.subject)}>
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

						<!-- Triage: grouped as one control cluster, separate from interact.
						     Below sm the whole cluster (plus star/forward) folds into the
						     kebab menu — the bar was overflowing and star fell off entirely. -->
						<div class="bg-muted/60 hidden items-center gap-0.5 rounded-xl p-0.5 sm:flex">
							{#if placement !== 'inbox'}
								<button type="button" title="Move to inbox" onclick={() => move('inbox')} class="text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg shadow-none transition-colors outline-none hover:shadow-xs focus-visible:ring-2">
									<InboxDownIcon class="size-4" />
								</button>
							{/if}
							{#if placement !== 'archived'}
								<Tooltip.Provider delayDuration={600}>
									<Tooltip.Root>
										<Tooltip.Trigger>
											{#snippet child({ props })}
												<button {...props} type="button" onclick={() => move('archived')} class="text-muted-foreground hover:text-foreground hover:bg-card focus-visible:ring-ring/50 grid size-7 place-items-center rounded-lg transition-colors outline-none hover:shadow-xs focus-visible:ring-2">
													<ArchiveIcon class="size-4" />
													<span class="sr-only">Archive</span>
												</button>
											{/snippet}
										</Tooltip.Trigger>
										<Tooltip.Content class="flex items-center gap-1.5">Archive <Kbd>E</Kbd></Tooltip.Content>
									</Tooltip.Root>
								</Tooltip.Provider>
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

						<!-- Phone overflow menu: everything the narrow bar can't fit —
						     star, forward, and the triage actions. -->
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button variant="ghost" size="icon" class="text-muted-foreground size-8 sm:hidden" title="More actions" {...props}>
										<EllipsisVerticalIcon class="size-4" />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content class="w-48" align="end">
								<DropdownMenu.Item onSelect={() => toggleStar(openStarred)}>
									<StarIcon class="size-4 {openStarred ? 'text-p3 fill-current' : ''}" />
									{openStarred ? 'Unstar' : 'Star'}
								</DropdownMenu.Item>
								{#if msgs.length}
									<DropdownMenu.Item onSelect={() => forwardThread(msgs, thread.subject)}>
										<ForwardIcon class="size-4" /> Forward conversation
									</DropdownMenu.Item>
								{/if}
								<DropdownMenu.Separator />
								{#if placement !== 'inbox'}
									<DropdownMenu.Item onSelect={() => move('inbox')}>
										<InboxDownIcon class="size-4" /> Move to inbox
									</DropdownMenu.Item>
								{/if}
								{#if placement !== 'archived'}
									<DropdownMenu.Item onSelect={() => move('archived')}>
										<ArchiveIcon class="size-4" /> Archive
									</DropdownMenu.Item>
								{/if}
								{#if placement !== 'spam'}
									<DropdownMenu.Item onSelect={() => move('spam')}>
										<ShieldAlertIcon class="size-4" /> Mark spam
									</DropdownMenu.Item>
								{/if}
								{#if placement !== 'trash'}
									<DropdownMenu.Item variant="destructive" onSelect={() => move('trash')}>
										<Trash2Icon class="size-4" /> Trash
									</DropdownMenu.Item>
								{/if}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</div>

					<!-- Find-in-thread bar: locates + jumps between messages matching the
					     query (plaintext we hold; rich bodies live in the sandboxed frame). -->
					{#if findOpen}
						<div
							transition:slide={{ duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160, easing: cubicOut }}
							class="bg-card/60 flex items-center gap-2 border-b px-3 py-1.5 md:px-4"
						>
							<SearchIcon class="text-muted-foreground size-4 shrink-0" />
							<!-- svelte-ignore a11y_autofocus -->
							<input
								type="text"
								autofocus
								bind:value={findQ}
								aria-label="Find in conversation"
								placeholder="Find in conversation…"
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										findStep(e.shiftKey ? -1 : 1);
									} else if (e.key === 'Escape') {
										e.preventDefault();
										closeFind();
									}
								}}
								class="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
							/>
							<span class="text-muted-foreground shrink-0 text-xs tabular-nums">
								{findQ.trim() ? (findMatches.length ? `${findIdx + 1}/${findMatches.length}` : '0/0') : ''}
							</span>
							<button type="button" title="Previous (Shift+Enter)" disabled={!findMatches.length} onclick={() => findStep(-1)} class="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded transition-colors disabled:opacity-40">
								<ChevronUpIcon class="size-4" />
							</button>
							<button type="button" title="Next (Enter)" disabled={!findMatches.length} onclick={() => findStep(1)} class="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded transition-colors disabled:opacity-40">
								<ChevronDownIcon class="size-4" />
							</button>
							<button type="button" title="Close (Esc)" onclick={closeFind} class="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded transition-colors">
								<XIcon class="size-4" />
							</button>
						</div>
					{/if}

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
									{@const outbound = m.outbound}
									<div data-msg={m.id} data-newest={m.id === msgs.at(-1)?.id} class="flex gap-2.5 {outbound ? 'flex-row-reverse' : ''}">
										{#if !outbound}{@render monogram(m.from, 'mt-5 size-7 text-[10px]')}{/if}
										<div class="flex min-w-0 max-w-[80%] flex-col {outbound ? 'items-end' : 'items-start'}">
											{#if !outbound && m.from}
											<ContactHoverCard address={senderAddr(m.from)} name={senderLabel(m)} {mailboxId} class="text-muted-foreground mb-1 px-1 text-[11px] font-medium">
												{#snippet children()}{senderLabel(m)}{/snippet}
											</ContactHoverCard>
										{:else if !outbound}
											<span class="text-muted-foreground mb-1 px-1 text-[11px] font-medium">{senderLabel(m)}</span>
										{/if}
											<div class="w-full rounded-2xl px-3.5 py-2.5 text-sm shadow-xs ring-brand transition-shadow duration-300 motion-reduce:transition-none {flashMsgId === m.id ? 'ring-2' : 'ring-0'} {outbound ? 'bg-foreground text-background rounded-tr-md' : 'bg-card rounded-tl-md border'}">
												{@render replyContextNote(m)}
												{#if m.calendarInvite}
													<div class="mb-2 w-[min(70vw,32rem)]">
														<InviteCard invite={inviteFor(m)} originalHref={inviteIcsHref(m)} onRsvp={(s) => rsvp(m, s)} />
													</div>
													<button
														type="button"
														class="mb-1 text-xs font-medium hover:underline {outbound ? 'text-background/80' : 'text-muted-foreground hover:text-foreground'}"
														onclick={() => (showOriginal.has(m.id) ? showOriginal.delete(m.id) : showOriginal.add(m.id))}
													>
														{showOriginal.has(m.id) ? 'Hide' : 'Show'} original message
													</button>
												{/if}
												{#if !m.calendarInvite || showOriginal.has(m.id)}
												{#if m.htmlKind === 'rich'}
													{@const allow = loadedImages.has(m.id) || !!m.senderTrusted}
													<div class="w-[min(70vw,32rem)]">
														<!-- Server-sanitized, opaque-origin frame (MailFrame loads the route). -->
														<MailFrame
															src={`/api/messages/${m.id}/body?images=${allow ? 1 : 0}`}
															fadeClass={outbound ? 'from-foreground' : 'from-card'}
															linkClass={outbound ? 'text-background/80' : 'text-brand'}
															onmailto={openMailto}
															onviewfull={() => openFullView(m.id, allow)}
														/>
														{#if !allow && m.hasRemoteImages}
															<div class="mt-1 flex flex-wrap gap-x-2 text-xs {outbound ? 'text-background/80' : 'text-brand'}">
																<button type="button" class="hover:underline" onclick={() => loadedImages.add(m.id)}>
																	Images blocked · Load anyway
																</button>
																{#if !outbound && m.from}
																	<button type="button" class="opacity-75 hover:underline" onclick={() => setSenderTrust(m, true)}>
																		Always load from this sender
																	</button>
																{/if}
															</div>
														{:else if m.senderTrusted && m.hasRemoteImages && !outbound}
															<button type="button" class="text-faint mt-1 text-[11px] hover:underline" onclick={() => setSenderTrust(m, false)}>
																Images load automatically · Stop for this sender
															</button>
														{/if}
													</div>
												{:else}
													<div class="whitespace-pre-wrap">{@render linkedText(m.bodyStripped ?? m.bodyFull ?? '')}</div>
												{/if}
												{/if}
												{#if m.attachments.length}
													<!-- WhatsApp split: visual parts (image/video/pdf) as a media grid,
													     documents as compact rows. Parts the HTML references by cid already
													     render inline — skip their tiles to avoid doubles. -->
													{@const shown = m.attachments.filter((a) => !a.inline && !(m.calendarInvite && (a.contentType?.includes('calendar') || a.filename?.toLowerCase().endsWith('.ics'))))}
													{@const media = shown.filter((a) => /^(image|video)\//.test(a.contentType ?? '') || a.contentType === 'application/pdf')}
													{@const docsOnly = shown.filter((a) => !media.includes(a))}
													{#if media.length}
														<!-- Capped like WhatsApp media: tiles never span the full bubble. -->
														<div class="mt-2 grid gap-1.5 {media.length === 1 ? 'max-w-60 grid-cols-1' : 'max-w-80 grid-cols-2'}">
															{#each media as a (a.id)}
																<AttachmentTile att={a} variant="grid" onpreview={openLightbox} />
															{/each}
														</div>
													{/if}
													{#if docsOnly.length}
														<div class="mt-2 space-y-1.5">
															{#each docsOnly as a (a.id)}
																<AttachmentTile att={a} variant="row" tone={outbound ? 'inverse' : 'default'} />
															{/each}
														</div>
													{/if}
												{/if}
												<div class="mt-1 flex items-center justify-end gap-1 text-[11px] {outbound ? 'text-background/70' : 'text-faint'}">
													{#if m.viaAlias}<span class="font-mono">via {m.viaAlias}</span>{/if}
													<span>{fmtTime(m.sentAt)}</span>
													{#if outbound && m.submission}
														{#if m.submission.tick === 'clock'}<ClockIcon class="size-3" />
														{:else if m.submission.tick === 'warning'}<TriangleAlertIcon class="text-destructive size-3" />{/if}
													{/if}
												</div>
											</div>
											{#if m.submission?.tick === 'warning'}
												{@render sendFailure(m.submission)}
											{/if}
											{@render visibilityChip(m, parts)}
											{@render msgActions(m, outbound ? 'end' : 'start', thread.subject)}
										</div>
									</div>
								{:else if item.type === 'external_message'}
								{@const m = item}
								{@const outbound = m.outbound}
								{@const isLast = m.id === msgs.at(-1)?.id}
								{@const open = msgOpen(m.id, isLast)}
								<article data-msg={m.id} data-newest={isLast} class="overflow-hidden rounded-2xl border shadow-xs ring-brand transition-shadow duration-300 motion-reduce:transition-none {flashMsgId === m.id ? 'ring-2' : 'ring-0'} {outbound ? 'border-brand/25 bg-card' : 'bg-card'}">
									<button
										type="button"
										aria-expanded={open}
										onclick={() => toggleMsg(m.id)}
										class="hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors outline-none focus-visible:ring-2"
									>
										{@render monogram(m.from, 'size-8 text-[11px]')}
										<div class="min-w-0 flex-1">
											<div class="flex items-baseline gap-2">
												{#if outbound || !m.from}
												<span class="truncate text-sm font-semibold {outbound ? 'text-brand' : ''}">{outbound ? 'You' : senderLabel(m)}</span>
											{:else}
												<ContactHoverCard address={senderAddr(m.from)} name={senderLabel(m)} {mailboxId} class="truncate text-sm font-semibold">
													{#snippet children()}{senderLabel(m)}{/snippet}
												</ContactHoverCard>
											{/if}
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
												{:else if m.submission.tick === 'warning'}<TriangleAlertIcon class="text-destructive size-3" />{/if}
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
											{@render replyContextNote(m)}
											{#if m.calendarInvite}
												<div class="mb-3">
													<InviteCard invite={inviteFor(m)} originalHref={inviteIcsHref(m)} onRsvp={(s) => rsvp(m, s)} />
												</div>
												<!-- The provider's boilerplate mail body is redundant with the card;
												     collapse it behind a toggle. -->
												<button
													type="button"
													class="text-muted-foreground hover:text-foreground text-xs font-medium hover:underline"
													onclick={() => (showOriginal.has(m.id) ? showOriginal.delete(m.id) : showOriginal.add(m.id))}
												>
													{showOriginal.has(m.id) ? 'Hide' : 'Show'} original message
												</button>
											{/if}
											{#if !m.calendarInvite || showOriginal.has(m.id)}
												<div class={m.calendarInvite ? 'mt-2 border-t pt-2' : ''}>
											{#if m.htmlKind === 'rich'}
												{@const allow = loadedImages.has(m.id) || !!m.senderTrusted}
												<!-- Server-sanitized, opaque-origin frame (MailFrame loads the route). -->
												<!-- Mail (Gmail) view: the card is the container — render full height,
												     no second collapse layer. -->
												<MailFrame src={`/api/messages/${m.id}/body?images=${allow ? 1 : 0}`} collapse={false} onmailto={openMailto} onviewfull={() => openFullView(m.id, allow)} />
												{#if !allow && m.hasRemoteImages}
													<div class="mt-1.5 flex flex-wrap gap-x-2 text-xs">
														<button type="button" class="text-brand hover:underline" onclick={() => loadedImages.add(m.id)}>
															Load remote images
														</button>
														{#if !outbound && m.from}
															<button type="button" class="text-brand opacity-75 hover:underline" onclick={() => setSenderTrust(m, true)}>
																Always load from this sender
															</button>
														{/if}
													</div>
												{:else if m.senderTrusted && m.hasRemoteImages && !outbound}
													<button type="button" class="text-faint mt-1.5 text-[11px] hover:underline" onclick={() => setSenderTrust(m, false)}>
														Images load automatically · Stop for this sender
													</button>
												{/if}
											{:else}
												<div class="text-sm whitespace-pre-wrap">{@render linkedText(m.bodyStripped ?? m.bodyFull ?? '')}</div>
											{/if}
												</div>
											{/if}
											{#if m.attachments.length}
												<!-- Gmail attachment strip: fixed-width preview cards, horizontal scroll. -->
												{@const shown = m.attachments.filter((a) => !a.inline && !(m.calendarInvite && (a.contentType?.includes('calendar') || a.filename?.toLowerCase().endsWith('.ics'))))}
												{#if shown.length}
													<div class="no-scrollbar mt-2.5 flex gap-2 overflow-x-auto overscroll-x-contain">
														{#each shown as a (a.id)}
															<AttachmentTile att={a} variant="strip" onpreview={openLightbox} />
														{/each}
													</div>
												{/if}
											{/if}
											<div class="flex justify-end">{@render visibilityChip(m, parts)}</div>
											{@render msgActions(m, 'end', thread.subject)}
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
						<!-- slide on the x-axis animates WIDTH (0→auto), so the stream reflows
						     in step with the panel — a fly/translate would claim the full width
						     instantly and jolt the stream. Inner content is fixed-width and clips. -->
						<aside
							transition:slide={{ axis: 'x', duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, easing: cubicOut }}
							class="bg-card/40 flex w-80 max-w-[45%] shrink-0 flex-col overflow-hidden border-l"
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
							<!-- Re-key on the picked message + scope so a per-message Reply
							     remounts the composer with THAT message's audience. The wrapper
							     is the scroll/flash target that acknowledges the click. -->
							<div
								bind:this={composerEl}
								class="transition-shadow duration-300 motion-reduce:transition-none {composerFlash
									? 'ring-brand/60 rounded-t-2xl ring-2'
									: ''}"
							>
								{#key `${thread.id}:${replyTarget?.msgId ?? ''}:${replyTarget?.scope ?? ''}`}
									<ReplyComposer
										{mailboxId}
										threadId={thread.id}
										parentMessageId={ctx.parent?.messageIdHeader ?? null}
										toAddress={ctx.target}
										subject={thread.subject}
										to={[ctx.target]}
										toAll={ctx.toAll}
										ccAll={ctx.ccAll}
										initialScope={ctx.scope}
										autoOpen={ctx.autoOpen}
										defaultAliasId={ctx.aliasId}
										{identities}
										onchange={refresh}
									/>
								{/key}
							</div>
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

<!-- "[Message clipped] → View entire message" — shallow-routed full render
     (?full=1, raised caps, same sandbox). Back button/gesture closes it. -->
<!-- Image-attachment lightbox — shallow-routed; Esc/backdrop (Dialog) or Back closes. -->
{#if page.state.lightbox}
	{@const img = page.state.lightbox}
	<Dialog.Root open={true} onOpenChange={(o) => { if (!o) history.back(); }}>
		<Dialog.Content class="w-auto max-w-[94vw] border-0 bg-transparent p-0 shadow-none" showCloseButton={false}>
			<Dialog.Header class="sr-only"><Dialog.Title>{img.name}</Dialog.Title></Dialog.Header>
			<img
				src={`/api/attachments/${img.id}`}
				alt={img.name}
				class="max-h-[86vh] max-w-full rounded-lg object-contain"
			/>
			<div class="mt-2 flex items-center justify-between gap-3 px-1">
				<span class="truncate text-xs font-medium text-white/90">{img.name}</span>
				<a
					href={`/api/attachments/${img.id}`}
					download={img.name}
					class="focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white outline-none backdrop-blur transition-colors hover:bg-white/20 focus-visible:ring-2"
				>
					<DownloadIcon class="size-3.5" /> Download
				</a>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}

{#if page.state.fullMessage}
	{@const fm = page.state.fullMessage}
	{#if isMobile.current}
		<Drawer.Root open={true} onOpenChange={(o) => { if (!o) history.back(); }}>
			<Drawer.Content>
				<Drawer.Header class="pb-0"><Drawer.Title>Full message</Drawer.Title></Drawer.Header>
				<div class="max-h-[80vh] overflow-y-auto p-4">
					<MailFrame src={`/api/messages/${fm.id}/body?images=${fm.images ? 1 : 0}&full=1`} collapse={false} onmailto={openMailto} />
				</div>
			</Drawer.Content>
		</Drawer.Root>
	{:else}
		<Dialog.Root open={true} onOpenChange={(o) => { if (!o) history.back(); }}>
			<Dialog.Content class="max-h-[85vh] w-[min(92vw,56rem)] max-w-none overflow-y-auto">
				<Dialog.Header><Dialog.Title>Full message</Dialog.Title></Dialog.Header>
				<MailFrame src={`/api/messages/${fm.id}/body?images=${fm.images ? 1 : 0}&full=1`} collapse={false} onmailto={openMailto} />
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
