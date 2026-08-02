<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Hallmark · component: settings-card · genre: modern-minimal · theme: project shadcn tokens
	//  states: default · hover · focus · active · disabled · loading · error · success
	//  contrast: pass (inherits project tokens) · pre-emit critique: P5 H4 E4 S4 R5 V4
	//
	// Account → Mail: per-(user, mailbox) email signature. One rich editor per
	// sending address; a signature is appended to new messages and replies from
	// that address automatically. Dirty state is tracked as a per-mailbox draft
	// compared against the live server value (cleared on save) — no seed effect.
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import TiptapEditor from '$lib/components/mail/tiptap-editor.svelte';
	import { myMailboxSignatures, setMailboxSignature } from '$lib/rpc/signature.remote';

	const q = myMailboxSignatures();

	// Unsaved editor HTML per mailbox — undefined until the user edits, so a row
	// is dirty only when its draft diverges from the server value below.
	let drafts = $state<Record<string, string>>({});
	let saving = $state<string | null>(null);
	// Bumped per mailbox to remount its editor (TiptapEditor seeds from `initial`
	// once) — that's how Discard resets the editor back to the saved signature.
	let discardNonce = $state<Record<string, number>>({});

	const draftFor = (mailboxId: string, saved: string) => drafts[mailboxId] ?? saved;
	const isDirty = (mailboxId: string, saved: string) =>
		drafts[mailboxId] !== undefined && drafts[mailboxId] !== saved;

	async function save(mailboxId: string, saved: string) {
		if (saving) return;
		saving = mailboxId;
		try {
			await setMailboxSignature({ mailboxId, bodyHtml: draftFor(mailboxId, saved) });
			// Drop the draft so the refreshed server value (post-sanitize) is the
			// source of truth again — the row settles back to "not dirty".
			delete drafts[mailboxId];
			drafts = { ...drafts };
			await q.refresh();
			toast.success('Signature saved.');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save the signature.');
		} finally {
			saving = null;
		}
	}

	function discard(mailboxId: string) {
		delete drafts[mailboxId];
		drafts = { ...drafts };
		discardNonce[mailboxId] = (discardNonce[mailboxId] ?? 0) + 1;
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<PenLineIcon class="size-4" /> Signature
		</Card.CardTitle>
		<Card.CardDescription>
			A sign-off added automatically to new messages and replies you send from each address. Shared
			mailboxes keep a separate signature per teammate.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col">
		{#if q.current === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-5 w-40 rounded-md" />
				<Skeleton class="h-24 w-full rounded-md" />
			</div>
		{:else if q.current.length === 0}
			<p class="text-muted-foreground text-sm">You don't have any sending addresses yet.</p>
		{:else}
			{#each q.current as sig (sig.mailboxId)}
				{@const dirty = isDirty(sig.mailboxId, sig.bodyHtml)}
				{@const busy = saving === sig.mailboxId}
				<!-- Each sending address is its own region (Common Region): a hairline
				     rule + top padding separates one signature from the next; the first
				     needs neither. Labelled group so the editor isn't anonymous to AT. -->
				<section
					class="flex flex-col gap-3 border-t pt-6 first:border-t-0 first:pt-0"
					aria-label="Signature for {sig.address}"
				>
					<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span class="min-w-0 truncate font-mono text-sm font-medium">{sig.address}</span>
						{#if sig.displayName}
							<span class="text-muted-foreground min-w-0 truncate text-xs">{sig.displayName}</span>
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
					<!-- No wrapper frame: TiptapEditor already draws its own border + focus
					     ring. dense sizes it to a signature, not a full message composer. -->
					{#key discardNonce[sig.mailboxId] ?? 0}
						<TiptapEditor
							dense
							initial={sig.bodyHtml}
							oninput={(html) => (drafts[sig.mailboxId] = html)}
							placeholder={`Signature for ${sig.address}…`}
						/>
					{/key}
					<div class="flex justify-end gap-2">
						{#if dirty}
							<Button variant="ghost" size="sm" disabled={busy} onclick={() => discard(sig.mailboxId)}>
								Discard
							</Button>
						{/if}
						<Button
							size="sm"
							disabled={!dirty || busy}
							onclick={() => save(sig.mailboxId, sig.bodyHtml)}
						>
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
	</Card.CardContent>
</Card.Card>
