<script lang="ts">
	import { onMount, untrack } from 'svelte';
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
		deleteNoteById
	} from '$lib/rpc/thread.remote';
	import { sendIdentities, myDrafts, scheduledSends, undoDraftById } from '$lib/rpc/draft.remote';
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
	import InboxDownIcon from '@lucide/svelte/icons/inbox';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CheckCheckIcon from '@lucide/svelte/icons/check-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import StickyNoteIcon from '@lucide/svelte/icons/sticky-note';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';

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

	// Reset + load page 0 when mailbox/folder changes. `untrack` keeps the loader's
	// own state writes from retriggering this effect.
	$effect(() => {
		const mb = mailboxId,
			virt = isVirtual;
		void placement;
		untrack(() => {
			if (mb && !virt) loadThreads(true);
			else {
				items = [];
				nextOffset = 0;
				reachedEnd = false;
			}
		});
	});

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

	function applyAssignFilter<T extends { assigneeUserId: string | null }>(rows: T[]): T[] {
		if (assignFilter === 'mine') return rows.filter((r) => r.assigneeUserId === currentUserId);
		if (assignFilter === 'unassigned') return rows.filter((r) => !r.assigneeUserId);
		return rows;
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
	// sandboxed iframe; the user can opt in per message.
	const loadedImages = new SvelteSet<string>();
	function frameDoc(html: string, allowRemote: boolean): string {
		const imgSrc = allowRemote ? 'img-src data: https:;' : 'img-src data:;';
		const csp = `default-src 'none'; ${imgSrc} style-src 'unsafe-inline'; font-src data:; media-src data:;`;
		return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:14px system-ui,sans-serif">${html}</body></html>`;
	}

	function fmtTime(ms: number | null): string {
		if (!ms) return '';
		return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
</script>

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

<div class="flex h-full">
	<!-- List pane -->
	<div class="flex w-full flex-col border-r md:w-[360px] md:shrink-0 {threadId ? 'hidden md:flex' : 'flex'}">
		<!-- Active mailbox (switch via the sidebar switcher) -->
		<div class="flex h-11 items-center gap-2 border-b px-3">
			<InboxIcon class="text-muted-foreground size-4" />
			<span class="truncate font-mono text-xs">{activeMailbox?.address ?? '…'}</span>
			{#if canManageActive}
				<a
					href="/mailboxes/{mailboxId}"
					title="Manage mailbox"
					class="text-muted-foreground hover:text-foreground ml-auto"
				>
					<SettingsIcon class="size-4" />
				</a>
			{/if}
		</div>

		<!-- Folder rail -->
		<div class="flex items-center gap-1 border-b px-2 py-1.5">
			{#each FOLDERS as f (f.id)}
				<Button
					variant={placement === f.id ? 'secondary' : 'ghost'}
					size="icon"
					class="size-8"
					title={f.name}
					onclick={() => nav({ folder: f.id, thread: null })}
				>
					<f.icon class="size-4" />
				</Button>
			{/each}
		</div>
		<div class="flex h-9 items-center justify-between px-4">
			<h2 class="font-heading text-sm font-semibold">{folder.name}</h2>
			{#if isShared && !isVirtual}
				<div class="flex items-center gap-0.5 text-xs">
					{#each [['all', 'All'], ['mine', 'Mine'], ['unassigned', 'Unassigned']] as [id, label] (id)}
						<button
							type="button"
							class="rounded px-1.5 py-0.5 {assignFilter === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}"
							onclick={() => (assignFilter = id as typeof assignFilter)}
						>
							{label}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="flex-1 overflow-y-auto" onscroll={onListScroll}>
			{#if placement === 'drafts'}
				{#await myDrafts()}
					{@render listSkeleton()}
				{:then drafts}
					{#if drafts.length}
						{#each drafts as d (d.id)}
							<button type="button" onclick={() => openDraft(d.id)} class="hover:bg-muted/60 flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left">
								<span class="truncate text-sm font-medium">{d.subject || '(no subject)'}</span>
								<span class="text-muted-foreground truncate font-mono text-xs">{d.to.join(', ') || 'No recipients'}</span>
								<span class="text-muted-foreground line-clamp-1 text-xs">{d.snippet ?? ''}</span>
							</button>
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
				{/await}
			{:else if placement === 'scheduled'}
				{@const schedQ = scheduledSends()}
				{#if schedQ.current}
					{@const items = schedQ.current}
					{#if items.length}
						{#each items as s (s.submissionId)}
							<div class="flex flex-col gap-0.5 border-b px-4 py-3">
								<span class="truncate text-sm font-medium">{s.subject || '(no subject)'}</span>
								<span class="text-muted-foreground truncate font-mono text-xs">to {s.to ?? '—'}</span>
								<div class="mt-1 flex items-center justify-between">
									<span class="text-accent text-xs">Sends {fmtTime(s.sendAt)}</span>
									<button type="button" class="text-muted-foreground hover:text-foreground text-xs underline" onclick={() => cancelScheduled(s.submissionId)}>Cancel</button>
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
					{#if applyAssignFilter(items).length}
						{#each applyAssignFilter(items) as t (t.threadId)}
							<button type="button" onclick={() => selectThread(t.threadId)} class="flex w-full flex-col gap-1 border-b px-4 py-3 text-left transition-colors {threadId === t.threadId ? 'bg-accent' : 'hover:bg-muted/60'}">
								<div class="flex items-center gap-2">
									{#if t.unread}<span class="bg-brand size-2 shrink-0 rounded-full"></span>{/if}
									<span class="flex-1 truncate font-mono text-xs {t.unread ? 'font-semibold' : ''}">{t.from ?? '—'}</span>
									{#if t.hasNotes}<StickyNoteIcon class="size-3.5 shrink-0 text-amber-500" />{/if}
									{#if t.assigneeUserId}<UserRoundIcon class="text-accent size-3.5 shrink-0" />{/if}
									{#if t.isStarred}<StarIcon class="text-p3 size-3.5 shrink-0 fill-current" />{/if}
									<span class="text-faint shrink-0 text-[11px]">{fmtTime(t.lastMessageAt)}</span>
								</div>
								<span class="truncate text-sm {t.unread ? 'text-foreground font-medium' : 'text-muted-foreground'}">{t.subject ?? '(no subject)'}</span>
								<span class="text-muted-foreground line-clamp-1 text-xs">{t.snippet ?? ''}</span>
							</button>
						{/each}
						{#if loadingList}
							<div class="flex justify-center py-3"><Spinner class="text-muted-foreground size-4" /></div>
						{/if}
					{:else if loadingList}
						{@render listSkeleton()}
					{:else}
						<EmptyState icon={InboxIcon} title="Nothing here" description="This folder is empty.">
							{#snippet action()}
								<Button size="sm" class="gap-1.5" onclick={composeNew}>
									<PencilIcon class="size-3.5" /> Compose
								</Button>
							{/snippet}
						</EmptyState>
					{/if}
			{/if}
		</div>
	</div>

	<!-- Conversation -->
	<div class="min-w-0 flex-1 flex-col {threadId ? 'flex' : 'hidden md:flex'}">
		{#if threadId && threadQ}
			{#if openDto}
				{@const thread = openDto}
					{@const msgs = thread.items.filter((i): i is MessageDTO => i.type === 'external_message')}
					{@const ctx = replyCtx(msgs)}
					<div class="flex h-12 items-center gap-2 border-b px-3 md:px-4">
						<Button variant="ghost" size="icon" class="text-muted-foreground md:hidden" onclick={() => nav({ thread: null })}>
							<ArrowLeftIcon class="size-4" />
						</Button>
						<p class="min-w-0 flex-1 truncate text-sm font-semibold">{thread.subject ?? '(no subject)'}</p>
						{#if isShared}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button variant="outline" size="sm" class="h-8 gap-1.5" {...props}>
											<UserRoundIcon class="size-3.5" />
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
						<Button variant="ghost" size="icon" class="text-muted-foreground" title={thread.isStarred ? 'Unstar' : 'Star'} onclick={() => toggleStar(thread.isStarred)}>
							<StarIcon class="size-4 {thread.isStarred ? 'text-p3 fill-current' : ''}" />
						</Button>
						{#if ctx.parent}
							{@const p = ctx.parent}
							<Button variant="ghost" size="icon" class="text-muted-foreground" title="Forward" onclick={() => forward(p, thread.subject)}>
								<ForwardIcon class="size-4" />
							</Button>
						{/if}
						{#if placement !== 'inbox'}
							<Button variant="ghost" size="icon" class="text-muted-foreground" title="Move to inbox" onclick={() => move('inbox')}>
								<InboxDownIcon class="size-4" />
							</Button>
						{/if}
						{#if placement !== 'archived'}
							<Button variant="ghost" size="icon" class="text-muted-foreground" title="Archive" onclick={() => move('archived')}>
								<ArchiveIcon class="size-4" />
							</Button>
						{/if}
						{#if placement !== 'spam'}
							<Button variant="ghost" size="icon" class="text-muted-foreground" title="Mark spam" onclick={() => move('spam')}>
								<ShieldAlertIcon class="size-4" />
							</Button>
						{/if}
						{#if placement !== 'trash'}
							<Button variant="ghost" size="icon" class="text-muted-foreground" title="Trash" onclick={() => move('trash')}>
								<Trash2Icon class="size-4" />
							</Button>
						{/if}
					</div>

					<ScrollArea class="min-h-0 flex-1">
						<div class="flex flex-col gap-3 p-4 md:p-6">
							{#each thread.items as item (item.id)}
								{#if item.type === 'external_message'}
								{@const m = item}
								{@const outbound = !!m.submission}
								<div class="flex flex-col {outbound ? 'items-end' : 'items-start'}">
									{#if !outbound}<span class="text-muted-foreground mb-1 px-1 font-mono text-[11px]">{m.from ?? ''}</span>{/if}
									<div class="max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm {outbound ? 'bg-foreground text-background rounded-tr-md' : 'bg-card rounded-tl-md border'}">
										{#if m.contentKind === 'card' && m.bodyHtml}
											{@const allow = loadedImages.has(m.id)}
											<div class="w-[min(70vw,32rem)]">
												<!-- Untrusted email HTML: script-less sandbox + CSP blocking remote content. -->
												<iframe title="Message content" sandbox="" srcdoc={frameDoc(m.bodyHtml, allow)} class="h-72 w-full rounded border-0 bg-white"></iframe>
												{#if !allow}
													<button type="button" class="text-accent mt-1 text-xs hover:underline" onclick={() => loadedImages.add(m.id)}>
														Load remote images
													</button>
												{/if}
											</div>
										{:else}
											{m.bodyStripped ?? m.bodyFull ?? ''}
										{/if}
										{#if m.attachments.length}
											<div class="mt-2 flex flex-wrap gap-1.5">
												{#each m.attachments as a (a.id)}
													<a href={resolve('/api/attachments/[id]', { id: a.id })} class="{outbound ? 'bg-background/15' : 'bg-muted'} flex items-center gap-1 rounded px-1.5 py-0.5 text-xs" target="_blank" rel="noopener">
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
								</div>
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
