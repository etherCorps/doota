<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Hallmark · component: settings-card · genre: modern-minimal · theme: project shadcn tokens
	//  states: default · hover · focus · active · disabled · loading · error · success
	//  contrast: pass (inherits project tokens) · pre-emit critique: P5 H4 E4 S4 R5 V4
	//
	// Account → Mail: per-(user, mailbox) email signature, with a New message /
	// Replies context tab per mailbox (Gmail's "reply signature" split). Dirty
	// state is tracked as a per-(mailbox, context) draft compared against the live
	// server value (cleared on save) — no seed effect. An empty reply signature
	// falls back to the new-message one at use time.
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import TiptapEditor from '$lib/components/mail/tiptap-editor.svelte';
	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';
	import { myMailboxSignatures, setMailboxSignature, type MailboxSignature } from '$lib/rpc/signature.remote';
	import { errorMessage } from '$lib/utils/error-message';

	type SigContext = 'new' | 'reply';

	// Page-level mailbox scope: when set, only that mailbox's signature renders
	// (the page's scope bar already names it, so the address heading drops too).
	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const q = myMailboxSignatures();
	const visible = $derived(
		q.current === undefined
			? undefined
			: mailboxId
				? q.current.filter((sig) => sig.mailboxId === mailboxId)
				: q.current
	);
	const scopedSig = $derived(mailboxId ? q.current?.find((sig) => sig.mailboxId === mailboxId) : undefined);

	// Which context tab each mailbox shows (default: new message).
	let tab = $state<Record<string, SigContext>>({});
	// Unsaved editor HTML per (mailbox, context) — undefined until the user edits,
	// so a row is dirty only when its draft diverges from the server value below.
	let drafts = $state<Record<string, string>>({});
	let saving = $state<string | null>(null);
	// Bumped per (mailbox, context) to remount its editor (TiptapEditor seeds from
	// `initial` once) — that's how Discard resets back to the saved signature.
	let discardNonce = $state<Record<string, number>>({});

	const keyOf = (mailboxId: string, ctx: SigContext) => `${mailboxId}:${ctx}`;
	const savedFor = (sig: MailboxSignature, ctx: SigContext) =>
		ctx === 'reply' ? sig.replyBodyHtml : sig.bodyHtml;
	const draftFor = (key: string, saved: string) => drafts[key] ?? saved;
	const isDirty = (key: string, saved: string) =>
		drafts[key] !== undefined && drafts[key] !== saved;

	async function save(sig: MailboxSignature, ctx: SigContext) {
		if (saving) return;
		const key = keyOf(sig.mailboxId, ctx);
		saving = key;
		try {
			await setMailboxSignature({
				mailboxId: sig.mailboxId,
				bodyHtml: draftFor(key, savedFor(sig, ctx)),
				context: ctx
			});
			// Drop the draft so the refreshed server value (post-sanitize) is the
			// source of truth again — the row settles back to "not dirty".
			delete drafts[key];
			drafts = { ...drafts };
			await q.refresh();
			toast.success(ctx === 'reply' ? 'Reply signature saved.' : 'Signature saved.');
		} catch (err) {
			toast.error(errorMessage(err, 'Could not save the signature.'));
		} finally {
			saving = null;
		}
	}

	function discard(key: string) {
		delete drafts[key];
		drafts = { ...drafts };
		discardNonce[key] = (discardNonce[key] ?? 0) + 1;
	}
</script>

<SettingsCollapsibleCard contentClass="flex flex-col gap-4">
	{#snippet title()}
		<PenLineIcon class="size-4" /> Signature
	{/snippet}
	{#snippet summary()}
		{#if q.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else if scopedSig}
			{scopedSig.bodyHtml ? 'Set' : 'Not set'}{scopedSig.replyBodyHtml ? ' · reply variant set' : ''}
		{:else}
			Not set
		{/if}
	{/snippet}
	<Card.CardDescription>
		A sign-off added automatically to messages you send from each address — with an optional
		separate version for replies. Shared mailboxes keep a separate signature per teammate.
	</Card.CardDescription>
	<div class="flex flex-col">
		{#if visible === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-5 w-40 rounded-md" />
				<Skeleton class="h-24 w-full rounded-md" />
			</div>
		{:else if visible.length === 0}
			<p class="text-muted-foreground text-sm">
				{mailboxId ? "You can't send from this mailbox." : "You don't have any sending addresses yet."}
			</p>
		{:else}
			{#each visible as sig (sig.mailboxId)}
				{@const ctx = tab[sig.mailboxId] ?? 'new'}
				{@const key = keyOf(sig.mailboxId, ctx)}
				{@const saved = savedFor(sig, ctx)}
				{@const dirty = isDirty(key, saved)}
				{@const busy = saving === key}
				<!-- Each sending address is its own region (Common Region): a hairline
				     rule + top padding separates one signature from the next; the first
				     needs neither. Labelled group so the editor isn't anonymous to AT. -->
				<section
					class="flex flex-col gap-3 border-t pt-6 first:border-t-0 first:pt-0"
					aria-label="Signature for {sig.address}"
				>
					{#if !mailboxId || dirty}
						<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
							{#if !mailboxId}
								<span class="min-w-0 truncate font-mono text-sm font-medium">{sig.address}</span>
								{#if sig.displayName}
									<span class="text-muted-foreground min-w-0 truncate text-xs">{sig.displayName}</span>
								{/if}
							{/if}
							{#if dirty}
								<!-- Status cue for an edited-but-unsaved draft; matches the account
								     layout's warn pills. ml-auto floats it right, wraps on narrow. -->
								<span
									class="border-warn/40 text-warn ml-auto inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
								>
									Unsaved
								</span>
							{/if}
						</div>
					{/if}
					<!-- Context tabs: one editor, remounted per (context, discard) so the
					     right saved value seeds it. Switching tabs keeps each tab's draft. -->
					<Tabs.Root value={ctx} onValueChange={(value) => (tab[sig.mailboxId] = value as SigContext)}>
						<Tabs.List>
							<Tabs.Trigger value="new">New message</Tabs.Trigger>
							<Tabs.Trigger value="reply">Replies</Tabs.Trigger>
						</Tabs.List>
					</Tabs.Root>
					<!-- No wrapper frame: TiptapEditor already draws its own border + focus
					     ring. dense sizes it to a signature, not a full message composer. -->
					{#key `${ctx}:${discardNonce[key] ?? 0}`}
						<TiptapEditor
							dense
							initial={draftFor(key, saved)}
							oninput={(html) => (drafts[key] = html)}
							placeholder={ctx === 'reply'
								? `Reply signature for ${sig.address}…`
								: `Signature for ${sig.address}…`}
						/>
					{/key}
					<div class="flex items-center justify-end gap-2">
						{#if ctx === 'reply'}
							<p class="text-muted-foreground mr-auto text-xs">
								Leave empty to use your new-message signature on replies too.
							</p>
						{/if}
						{#if dirty}
							<Button variant="ghost" size="sm" disabled={busy} onclick={() => discard(key)}>
								Discard
							</Button>
						{/if}
						<Button size="sm" disabled={!dirty || busy} onclick={() => save(sig, ctx)}>
							{#if busy}
								<Spinner class="mr-1 size-3.5" /> Saving…
							{:else}
								Save
							{/if}
						</Button>
					</div>
				</section>
			{/each}
		{/if}
	</div>
</SettingsCollapsibleCard>
