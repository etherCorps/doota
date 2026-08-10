<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// "Apply rule to existing mail" flow — shared by the post-move toast and the
	// rules sheet. Call `start(ruleId)`: previews how many conversations the
	// user filed by hand, applies straight away when none exist, otherwise
	// confirms (with the override checkbox) before kicking the backfill.
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import { backfillPreview, applyRuleToExisting } from '$lib/rpc/rules.remote';
	import { toast } from 'svelte-sonner';
	import { errorMessage } from '$lib/utils/error-message';

	let {
		mailboxId,
		onApplied
	}: {
		mailboxId: string | null;
		onApplied?: () => void;
	} = $props();

	let ruleId = $state<string | null>(null);
	let confirmOpen = $state(false);
	let userPlaced = $state(0);
	let includeUserPlaced = $state(false);
	let busy = $state(false);

	async function apply(mb: string, rule: string, overrideUserPlacement: boolean) {
		if (busy) return;
		busy = true;
		try {
			await applyRuleToExisting({ mailboxId: mb, ruleId: rule, overrideUserPlacement });
			toast.success('Applying the rule to existing conversations…');
			confirmOpen = false;
			ruleId = null;
			onApplied?.();
		} catch (e) {
			toast.error(errorMessage(e, 'Could not apply the rule.'));
		} finally {
			busy = false;
		}
	}

	/** Entry point: preview → (confirm with override?) → apply. */
	export async function start(rule: string) {
		const mb = mailboxId;
		if (!mb || busy) return;
		ruleId = rule;
		try {
			// refresh(): the query is arg-cached — a stale count here would hide
			// the "you filed these by hand" warning.
			const previewQ = backfillPreview({ mailboxId: mb });
			await previewQ.refresh();
			const count = previewQ.current?.userPlacedThreads ?? 0;
			if (count > 0) {
				userPlaced = count;
				includeUserPlaced = false;
				confirmOpen = true;
			} else {
				await apply(mb, rule, false);
			}
		} catch (e) {
			toast.error(errorMessage(e, 'Could not check existing mail.'));
			ruleId = null;
		}
	}

	function cancel() {
		confirmOpen = false;
		ruleId = null;
	}
</script>

<Dialog.Root
	open={confirmOpen}
	onOpenChange={(value) => {
		if (!value) cancel();
	}}
>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title class="text-sm">Apply this rule to existing mail?</Dialog.Title>
			<Dialog.Description class="text-xs">
				{userPlaced} conversation{userPlaced === 1 ? '' : 's'} you filed by hand may move. Leave the
				box unchecked to keep them where you put them.
			</Dialog.Description>
		</Dialog.Header>
		<label class="flex cursor-pointer items-center gap-2 text-xs">
			<Checkbox bind:checked={includeUserPlaced} />
			<span>Also move conversations I filed by hand</span>
		</label>
		<div class="flex justify-end gap-2">
			<Button variant="ghost" size="sm" class="h-8" disabled={busy} onclick={cancel}>Cancel</Button>
			<Button
				size="sm"
				class="h-8"
				disabled={busy}
				onclick={() => {
					if (mailboxId && ruleId) void apply(mailboxId, ruleId, includeUserPlaced);
				}}
			>
				Apply
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
