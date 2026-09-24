<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: canned responses ("snippets"). A list of the user's titled
	// snippets with one inline editor — new or existing — open at a time, so the
	// card stays a list and not a pile of rich-text editors. Per user, so the
	// page's mailbox scope doesn't apply here (the card renders the same for
	// every mailbox). The composer inserts these from the toolbar.
	import TextQuoteIcon from '@lucide/svelte/icons/text-quote';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import TiptapEditor from '$lib/components/mail/tiptap-editor.svelte';
	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';
	import { mySnippets, saveSnippet, deleteSnippet, type Snippet } from '$lib/rpc/snippet.remote';
	import { errorMessage } from '$lib/utils/error-message';

	const q = mySnippets();

	// The one open editor: null = closed, 'new' = creating, else the id being
	// edited. Title + body are the editor's working copy.
	let editing = $state<string | null>(null);
	// draft* — `title` is taken by the card's title snippet below.
	let draftTitle = $state('');
	let draftBody = $state('');
	let saving = $state(false);
	let deleting = $state<string | null>(null);
	// Bumped on every open so the TiptapEditor (which seeds from `initial` once)
	// remounts with the right body.
	let editorNonce = $state(0);

	const canSave = $derived(draftTitle.trim().length > 0 && !saving);

	function openEditor(snippet?: Snippet) {
		editing = snippet?.id ?? 'new';
		draftTitle = snippet?.title ?? '';
		draftBody = snippet?.bodyHtml ?? '';
		editorNonce += 1;
	}
	function closeEditor() {
		editing = null;
		draftTitle = '';
		draftBody = '';
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			await saveSnippet({
				id: editing && editing !== 'new' ? editing : undefined,
				title: draftTitle,
				bodyHtml: draftBody
			});
			await q.refresh();
			toast.success(editing === 'new' ? 'Snippet added.' : 'Snippet saved.');
			closeEditor();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not save the snippet.'));
		} finally {
			saving = false;
		}
	}

	async function remove(snippet: Snippet) {
		deleting = snippet.id;
		try {
			await deleteSnippet(snippet.id);
			if (editing === snippet.id) closeEditor();
			await q.refresh();
			toast.success(`Deleted “${snippet.title}”.`);
		} catch (err) {
			toast.error(errorMessage(err, 'Could not delete the snippet.'));
		} finally {
			deleting = null;
		}
	}

	/** One-line plain-text teaser for the list row. */
	function preview(html: string): string {
		return html
			.replace(/<[^>]*>/g, ' ')
			.replace(/&nbsp;/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}
</script>

{#snippet editor()}
	<section
		class="bg-muted/30 flex flex-col gap-3 rounded-lg border p-3"
		aria-label={editing === 'new' ? 'New snippet' : 'Edit snippet'}
	>
		<Input
			class="h-8"
			placeholder="Title — how it shows in the picker"
			aria-label="Snippet title"
			maxlength={120}
			bind:value={draftTitle}
			onkeydown={(event) => event.key === 'Enter' && save()}
		/>
		{#key editorNonce}
			<TiptapEditor dense initial={draftBody} oninput={(html) => (draftBody = html)} placeholder="What to insert…" />
		{/key}
		<div class="flex items-center justify-end gap-2">
			<Button variant="ghost" size="sm" disabled={saving} onclick={closeEditor}>Cancel</Button>
			<Button size="sm" disabled={!canSave} onclick={save}>
				{#if saving}
					<Spinner class="mr-1 size-3.5" /> Saving…
				{:else}
					Save
				{/if}
			</Button>
		</div>
	</section>
{/snippet}

<SettingsCollapsibleCard contentClass="flex flex-col gap-4">
	{#snippet title()}
		<TextQuoteIcon class="size-4" /> Snippets
	{/snippet}
	{#snippet summary()}
		{#if q.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else if q.current.length === 0}
			None yet
		{:else}
			{q.current.length} {q.current.length === 1 ? 'snippet' : 'snippets'}
		{/if}
	{/snippet}
	<Card.CardDescription>
		Canned responses you can drop into any message from the composer toolbar — a greeting, your
		hours, a standard answer. They follow you across every address you send from.
	</Card.CardDescription>
	<div class="flex flex-col gap-2">
		{#if q.current === undefined}
			<Skeleton class="h-10 w-full rounded-md" />
			<Skeleton class="h-10 w-full rounded-md" />
		{:else}
			{#each q.current as snippet (snippet.id)}
				{#if editing === snippet.id}
					{@render editor()}
				{:else}
					<div class="flex items-center gap-2 rounded-md border px-3 py-2">
						<div class="flex min-w-0 flex-1 flex-col">
							<span class="truncate text-sm font-medium">{snippet.title}</span>
							<span class="text-muted-foreground truncate text-xs">{preview(snippet.bodyHtml)}</span>
						</div>
						<Button
							variant="ghost"
							size="icon"
							class="size-8 shrink-0"
							title="Edit snippet"
							aria-label="Edit {snippet.title}"
							disabled={saving}
							onclick={() => openEditor(snippet)}
						>
							<PencilIcon class="size-4" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							class="text-muted-foreground hover:text-destructive size-8 shrink-0"
							title="Delete snippet"
							aria-label="Delete {snippet.title}"
							disabled={deleting === snippet.id}
							onclick={() => remove(snippet)}
						>
							{#if deleting === snippet.id}
								<Spinner class="size-4" />
							{:else}
								<Trash2Icon class="size-4" />
							{/if}
						</Button>
					</div>
				{/if}
			{:else}
				{#if editing !== 'new'}
					<p class="text-muted-foreground text-sm">
						No snippets yet. Add one and it appears under the composer's snippet button.
					</p>
				{/if}
			{/each}
			{#if editing === 'new'}
				{@render editor()}
			{:else}
				<div>
					<Button variant="outline" size="sm" disabled={saving} onclick={() => openEditor()}>
						<PlusIcon class="mr-1 size-3.5" /> New snippet
					</Button>
				</div>
			{/if}
		{/if}
	</div>
</SettingsCollapsibleCard>
