<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// "Why is this here?" — explains a thread's placement in a folder view.
	// The caller loads whyHere and passes the result; this sheet only renders it
	// (plus the one write it owns: pausing the responsible rule).
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { updateRule } from '$lib/rpc/rules.remote';
	import { describeConditions, type RuleConditionGroup } from '$lib/mail/rule-text.js';
	import { relTime } from '$lib/utils/reltime';
	import { toast } from 'svelte-sonner';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import { errorMessage } from '$lib/utils/error-message';

	type WhyInfo = {
		placement: string;
		origin: string;
		at: number | null;
		rule: { id: string; name: string | null; conditions: unknown } | null;
		movedBy: { id: string; name: string | null } | null;
	};

	let {
		open = $bindable(false),
		mailboxId,
		info,
		folderName,
		onEditRule,
		onMoveToInbox,
		onRuleDisabled
	}: {
		open?: boolean;
		mailboxId: string | null;
		info: WhyInfo | null;
		folderName: string;
		/** Opens the rules settings sheet. */
		onEditRule?: () => void;
		/** Existing moveToFolder(null) flow, owned by the caller. */
		onMoveToInbox?: () => void;
		/** Fired after the rule was paused — refresh folders/why queries. */
		onRuleDisabled?: () => void;
	} = $props();

	const isMobile = new IsMobile();
	let busy = $state(false);

	async function stopFiling() {
		const rule = info?.rule;
		if (!mailboxId || !rule || busy) return;
		busy = true;
		try {
			await updateRule({ mailboxId, ruleId: rule.id, enabled: false });
			toast.success('Rule paused — new mail like this lands in the Inbox.');
			onRuleDisabled?.();
			open = false;
		} catch (e) {
			toast.error(errorMessage(e, 'Could not pause the rule.'));
		} finally {
			busy = false;
		}
	}
</script>

{#snippet body()}
	<div class="flex flex-col gap-3 p-4 pt-2">
		{#if info?.origin === 'rule'}
			<div class="flex items-start gap-2.5">
				<SparklesIcon class="text-brand mt-0.5 size-4 shrink-0" />
				<div class="min-w-0 text-sm">
					<p>
						Filed to <span class="font-medium">{folderName}</span> by a rule{info.at
							? ` · ${relTime(info.at)}`
							: ''}.
					</p>
					<p class="text-muted-foreground mt-0.5 text-xs">
						{info.rule?.name ?? 'Rule'} — {describeConditions(
							info.rule?.conditions as RuleConditionGroup | null
						)}
					</p>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					class="h-8 gap-1.5"
					onclick={() => {
						open = false;
						onEditRule?.();
					}}
				>
					<PencilIcon class="size-3.5" /> Edit rule
				</Button>
				<Button variant="outline" size="sm" class="h-8 gap-1.5" disabled={busy} onclick={stopFiling}>
					<PauseIcon class="size-3.5" /> Stop filing these
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="h-8 gap-1.5"
					onclick={() => {
						open = false;
						onMoveToInbox?.();
					}}
				>
					<InboxIcon class="size-3.5" /> Move to Inbox
				</Button>
			</div>
		{:else if info?.origin === 'user'}
			<div class="flex items-start gap-2.5">
				<UserRoundIcon class="text-brand mt-0.5 size-4 shrink-0" />
				<p class="text-sm">
					Moved here by <span class="font-medium">{info.movedBy?.name ?? 'someone'}</span>{info.at
						? ` · ${relTime(info.at)}`
						: ''}.
				</p>
			</div>
		{:else}
			<p class="text-muted-foreground text-sm">This conversation landed here by default.</p>
		{/if}
	</div>
{/snippet}

{#if isMobile.current}
	<Drawer.Root bind:open>
		<Drawer.Content class="p-0">
			<Drawer.Header class="pb-0">
				<Drawer.Title class="text-sm">Why is this here?</Drawer.Title>
			</Drawer.Header>
			{@render body()}
		</Drawer.Content>
	</Drawer.Root>
{:else}
	<Dialog.Root bind:open>
		<Dialog.Content class="max-w-sm gap-0 p-0">
			<Dialog.Header class="px-4 pt-4 pb-1">
				<Dialog.Title class="text-sm">Why is this here?</Dialog.Title>
			</Dialog.Header>
			{@render body()}
		</Dialog.Content>
	</Dialog.Root>
{/if}
