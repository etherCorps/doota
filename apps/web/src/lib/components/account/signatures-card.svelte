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
	<Card.CardContent class="flex flex-col gap-6">
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
				<div class="flex flex-col gap-2">
					<div class="flex min-w-0 items-baseline gap-2">
						<span class="truncate font-mono text-sm">{sig.address}</span>
						{#if sig.displayName}
							<span class="text-muted-foreground truncate text-xs">{sig.displayName}</span>
						{/if}
					</div>
					<div class="rounded-md border">
						<TiptapEditor
							initial={sig.bodyHtml}
							oninput={(html) => (drafts[sig.mailboxId] = html)}
							placeholder={`Signature for ${sig.address}…`}
						/>
					</div>
					<div class="flex justify-end">
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
				</div>
			{/each}
		{/if}
	</Card.CardContent>
</Card.Card>
