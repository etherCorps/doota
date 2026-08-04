<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Rules settings — the EDITING surface (authoring happens in the move sheet's
	// "always file mail from…" row). List / enable / reorder / delete /
	// apply-to-existing. Opened via ?rules=1 so the sidebar ✱ badges can link
	// here from anywhere.
	// ponytail: no condition editor — rules born in the move sheet are
	// single-condition; add an editor when multi-condition rules exist.
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import ApplyRuleDialog from './apply-rule-dialog.svelte';
	import { mailboxRules, updateRule, deleteRule, reorderRules } from '$lib/rpc/rules.remote';
	import { describeRule } from '$lib/mail/rule-text.js';
	import { toast } from 'svelte-sonner';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';

	let {
		open = false,
		onOpenChange,
		mailboxId,
		folders,
		onChanged
	}: {
		open?: boolean;
		onOpenChange: (open: boolean) => void;
		mailboxId: string | null;
		folders: { id: string; name: string }[];
		/** Fired after any write — the caller refreshes myFolders (✱ badges). */
		onChanged?: () => void;
	} = $props();

	const isMobile = new IsMobile();
	// Query only while open — the sheet is a rare surface, don't fetch eagerly.
	const rulesQ = $derived(open && mailboxId ? mailboxRules({ mailboxId }) : null);
	const rules = $derived(rulesQ?.current ?? []);
	const folderName = (labelId: string) =>
		folders.find((folder) => folder.id === labelId)?.name ?? 'a folder';

	let busy = $state(false);
	let applyRuleDialog = $state<{ start: (ruleId: string) => void } | null>(null);
	let deleteTarget = $state<{ id: string; name: string } | null>(null);

	async function write(action: () => Promise<unknown>) {
		if (busy) return;
		busy = true;
		try {
			await action();
			await rulesQ?.refresh();
			onChanged?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not update rules.');
		} finally {
			busy = false;
		}
	}

	function toggleRule(ruleId: string, enabled: boolean) {
		const mb = mailboxId;
		if (!mb) return;
		void write(() => updateRule({ mailboxId: mb, ruleId, enabled }));
	}

	function moveRule(index: number, delta: number) {
		const mb = mailboxId;
		const target = index + delta;
		if (!mb || target < 0 || target >= rules.length) return;
		const ids = rules.map((rule) => rule.id);
		[ids[index], ids[target]] = [ids[target], ids[index]];
		void write(() => reorderRules({ mailboxId: mb, ruleIds: ids }));
	}

	function confirmDelete() {
		const mb = mailboxId;
		const target = deleteTarget;
		if (!mb || !target) return;
		void write(async () => {
			await deleteRule({ mailboxId: mb, ruleId: target.id });
			deleteTarget = null;
		});
	}

	// A running backfill has no live push — poll gently while the sheet is open
	// so "Applying…" clears itself. ponytail: 5s poll; wire to realtime if
	// backfills ever get events.
	$effect(() => {
		if (!open || !rules.some((rule) => rule.backfill.running)) return;
		const timer = setInterval(() => void rulesQ?.refresh(), 5000);
		return () => clearInterval(timer);
	});
</script>

{#snippet body()}
	<div class="max-h-[60vh] min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
		{#if rulesQ && rulesQ.current === undefined}
			<div class="flex justify-center py-6"><Spinner class="text-muted-foreground size-4" /></div>
		{:else if !rules.length}
			<div class="text-muted-foreground px-4 py-8 text-center text-xs">
				<SparklesIcon class="mx-auto mb-2 size-5" />
				<p class="font-medium">No rules yet</p>
				<p class="mt-1">
					Move a conversation and tick "Always file mail from … here" to create one.
				</p>
			</div>
		{:else}
			{#each rules as rule, index (rule.id)}
				<div class="hover:bg-muted/50 rounded-lg p-2.5 {rule.enabled ? '' : 'opacity-60'}">
					<div class="flex items-center gap-2">
						<span class="min-w-0 flex-1 truncate text-sm font-medium">{rule.name}</span>
						{#if rule.backfill.running}
							<Badge variant="info" class="text-[10px]">
								<Spinner class="size-3" /> Applying to existing…
							</Badge>
						{/if}
						<Switch
							size="sm"
							checked={rule.enabled}
							disabled={busy}
							onCheckedChange={(value) => toggleRule(rule.id, value)}
							aria-label="Rule enabled"
						/>
					</div>
					<p class="text-muted-foreground mt-0.5 truncate text-xs">
						{describeRule(rule, folderName)}{rule.stopProcessing ? ' · stops other rules' : ''}
					</p>
					<div class="mt-1.5 flex items-center gap-0.5">
						<Button
							variant="ghost"
							size="icon"
							class="text-muted-foreground size-7"
							title="Move up"
							aria-label="Move rule up"
							disabled={busy || index === 0}
							onclick={() => moveRule(index, -1)}
						>
							<ChevronUpIcon class="size-4" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							class="text-muted-foreground size-7"
							title="Move down"
							aria-label="Move rule down"
							disabled={busy || index === rules.length - 1}
							onclick={() => moveRule(index, 1)}
						>
							<ChevronDownIcon class="size-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="text-muted-foreground hover:text-foreground h-7 px-1.5 text-xs"
							disabled={busy || rule.backfill.running}
							onclick={() => applyRuleDialog?.start(rule.id)}
						>
							Apply to existing
						</Button>
						<Button
							variant="ghost"
							size="icon"
							class="text-muted-foreground hover:text-destructive ml-auto size-7"
							title="Delete rule"
							aria-label="Delete rule"
							disabled={busy}
							onclick={() => (deleteTarget = { id: rule.id, name: rule.name })}
						>
							<Trash2Icon class="size-4" />
						</Button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
{/snippet}

{#if isMobile.current}
	<Drawer.Root {open} {onOpenChange}>
		<Drawer.Content class="p-0">
			<Drawer.Header class="pb-2">
				<Drawer.Title class="flex items-center gap-1.5 text-sm">
					<ListChecksIcon class="size-4" /> Rules
				</Drawer.Title>
				<Drawer.Description class="text-xs">
					Run top to bottom on new mail in this mailbox.
				</Drawer.Description>
			</Drawer.Header>
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">{@render body()}</div>
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Dialog.Root {open} {onOpenChange}>
		<Dialog.Content class="max-w-lg gap-0 p-0">
			<Dialog.Header class="border-b px-4 pt-4 pb-3">
				<Dialog.Title class="flex items-center gap-1.5 text-sm">
					<ListChecksIcon class="size-4" /> Rules
				</Dialog.Title>
				<Dialog.Description class="text-xs">
					Run top to bottom on new mail in this mailbox.
				</Dialog.Description>
			</Dialog.Header>
			{@render body()}
		</Dialog.Content>
	</Dialog.Root>
{/if}

<ApplyRuleDialog
	bind:this={applyRuleDialog}
	{mailboxId}
	onApplied={() => {
		void rulesQ?.refresh();
		onChanged?.();
	}}
/>

<!-- Delete rule — always confirmed. -->
<Dialog.Root
	open={!!deleteTarget}
	onOpenChange={(value) => {
		if (!value) deleteTarget = null;
	}}
>
	<Dialog.Content class="max-w-xs">
		<Dialog.Header>
			<Dialog.Title class="text-sm">Delete rule “{deleteTarget?.name}”?</Dialog.Title>
			<Dialog.Description class="text-xs">
				Mail already filed stays where it is; only future filing stops.
			</Dialog.Description>
		</Dialog.Header>
		<Button variant="destructive" size="sm" class="h-8 w-full" disabled={busy} onclick={confirmDelete}>
			Delete rule
		</Button>
	</Dialog.Content>
</Dialog.Root>
