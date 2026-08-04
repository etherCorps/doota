<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// "Move to…" destination picker: search → Inbox → folder tree → inline new
	// folder. Deliberately dumb — the caller owns every rpc write; this component
	// only picks (or creates) a destination and reports it.
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { toast } from 'svelte-sonner';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlusIcon from '@lucide/svelte/icons/plus';

	type Folder = { id: string; name: string; color: string | null; parentId: string | null };

	let {
		open = $bindable(false),
		folders,
		sender = null,
		onMove,
		onCreate
	}: {
		open?: boolean;
		folders: Folder[];
		/** Single-thread move: the sender ADDRESS shown on the rules hook row. */
		sender?: string | null;
		/** null = move to Inbox. The caller closes the sheet + runs the move
		 * (and, when asked, creates the "always file from sender" rule). */
		onMove: (labelId: string | null, opts: { fileFromSender: boolean }) => void;
		/** Create a folder by name; the caller then moves there. */
		onCreate: (name: string, opts: { fileFromSender: boolean }) => Promise<void>;
	} = $props();

	const isMobile = new IsMobile();
	let q = $state('');
	let creating = $state(false);
	let newName = $state('');
	let busy = $state(false);
	// "Always file mail from <sender> here" — the natural rule-creation moment.
	let fileFromSender = $state(false);

	// Tree order: roots name-sorted, each followed by its (sorted) children.
	// Data guarantees max depth 2, so one nesting pass is the whole tree.
	const ordered = $derived.by(() => {
		const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name);
		const out: (Folder & { depth: number })[] = [];
		for (const root of folders.filter((folder) => !folder.parentId).sort(byName)) {
			out.push({ ...root, depth: 0 });
			for (const child of folders.filter((folder) => folder.parentId === root.id).sort(byName)) {
				out.push({ ...child, depth: 1 });
			}
		}
		return out;
	});
	// Searching flattens to name matches (indent kept — parent context reads fine).
	const shown = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		return needle ? ordered.filter((folder) => folder.name.toLowerCase().includes(needle)) : ordered;
	});

	function pick(labelId: string | null) {
		onMove(labelId, { fileFromSender });
	}

	async function createAndMove() {
		const name = newName.trim();
		if (!name || busy) return;
		busy = true;
		try {
			await onCreate(name, { fileFromSender });
			newName = '';
			creating = false;
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create the folder.');
		} finally {
			busy = false;
		}
	}

	// Fresh state each open — a stale search from the last move reads as "my
	// folders vanished".
	function onOpenChange(value: boolean) {
		if (value) {
			q = '';
			creating = false;
			newName = '';
			fileFromSender = false;
		}
	}

	const rowCls =
		'hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2';
</script>

{#snippet body()}
	<div class="border-b p-2">
		<Input
			class="h-8 text-xs pointer-coarse:text-base"
			placeholder="Search folders…"
			aria-label="Search folders"
			bind:value={q}
		/>
	</div>
	<div class="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
		{#if !q.trim()}
			<button type="button" class={rowCls} onclick={() => pick(null)}>
				<InboxIcon class="text-muted-foreground size-4 shrink-0" />
				<span class="truncate">Inbox</span>
			</button>
		{/if}
		{#each shown as folder (folder.id)}
			<button
				type="button"
				class={rowCls}
				style={folder.depth ? 'padding-left: 1.75rem' : ''}
				onclick={() => pick(folder.id)}
			>
				<span
					class="size-2.5 shrink-0 rounded-full"
					style="background: {folder.color ?? 'var(--color-muted-foreground)'}"
				></span>
				<span class="truncate">{folder.name}</span>
			</button>
		{:else}
			{#if q.trim()}
				<p class="text-muted-foreground px-2 py-3 text-center text-xs">No folder matches.</p>
			{/if}
		{/each}
		{#if creating}
			<div class="flex items-center gap-1.5 p-1">
				<Input
					autofocus
					class="h-8 flex-1 text-xs pointer-coarse:text-base"
					placeholder="Folder name"
					aria-label="New folder name"
					bind:value={newName}
					disabled={busy}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							void createAndMove();
						}
					}}
				/>
				<Button size="sm" class="h-8 shrink-0" disabled={!newName.trim() || busy} onclick={createAndMove}>
					Create
				</Button>
			</div>
		{:else}
			<button type="button" class="{rowCls} text-muted-foreground" onclick={() => (creating = true)}>
				<PlusIcon class="size-4 shrink-0" />
				<span>New folder</span>
			</button>
		{/if}
	</div>
	{#if sender}
		<!-- Check + pick a folder → the caller creates a "from sender → folder"
		     rule after the move lands. Picking Inbox ignores the tick. -->
		<label class="hover:bg-muted/50 flex cursor-pointer items-center gap-2 border-t px-3 py-2.5 text-xs transition-colors">
			<Checkbox bind:checked={fileFromSender} />
			<span class="min-w-0 flex-1 truncate">Always file mail from {sender} here</span>
		</label>
	{/if}
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open {onOpenChange}>
		<Drawer.Content class="p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
			<Drawer.Header class="pb-2">
				<Drawer.Title class="text-sm">Move to</Drawer.Title>
			</Drawer.Header>
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Dialog.Root bind:open {onOpenChange}>
		<Dialog.Content class="max-w-sm gap-0 p-0">
			<Dialog.Header class="border-b px-3 pt-3 pb-2.5">
				<Dialog.Title class="text-sm">Move to</Dialog.Title>
			</Dialog.Header>
			{@render body()}
		</Dialog.Content>
	</Dialog.Root>
{/if}
