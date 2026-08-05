<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';

	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';

	// Reactive (not one-shot await): self-heals if the experimental remote-query
	// cache resolves late or transiently undefined during hydration.
	const mailboxesQ = myMailboxes();
	import { listAliases, generateAlias, toggleAlias, deleteAlias } from '$lib/rpc/alias.remote';
	import { errorMessage } from '$lib/utils/error-message';

	// Page-level mailbox scope (see signatures-card). Aliases exist only on
	// personal mailboxes — a scoped non-personal mailbox gets a one-line note.
	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const scopedBox = $derived(
		mailboxId ? mailboxesQ.current?.find((box) => box.id === mailboxId) : undefined
	);
	const scopedNotPersonal = $derived(scopedBox !== undefined && !scopedBox.isPersonal);
	// Header summary reads the same per-mailbox query the list uses (cached by args).
	const summaryQuery = $derived(
		scopedBox?.isPersonal ? listAliases(scopedBox.id) : undefined
	);

	let busy = $state<string | null>(null);

	async function generate(mailboxId: string) {
		busy = mailboxId;
		const req = generateAlias({ mailboxId });
		toast.promise(req, {
			loading: 'Creating alias…',
			success: (res) => `Created ${res.address}`,
			error: (err) => (errorMessage(err, 'Could not create an alias.'))
		});
		try {
			await req;
			await listAliases(mailboxId).refresh();
		} catch {
			// Error surfaced by toast.promise.
		} finally {
			busy = null;
		}
	}

	async function toggle(mailboxId: string, aliasId: string, enabled: boolean) {
		busy = aliasId;
		try {
			await toggleAlias({ aliasId, enabled });
			await listAliases(mailboxId).refresh();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not update the alias.'));
		} finally {
			busy = null;
		}
	}

	async function remove(mailboxId: string, aliasId: string) {
		busy = aliasId;
		const req = deleteAlias(aliasId);
		toast.promise(req, {
			loading: 'Deleting alias…',
			success: 'Alias deleted.',
			error: (err) => (errorMessage(err, 'Could not delete the alias.'))
		});
		try {
			await req;
			await listAliases(mailboxId).refresh();
		} catch {
			// Error surfaced by toast.promise.
		} finally {
			busy = null;
		}
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied to clipboard.');
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}
</script>

<SettingsCollapsibleCard>
	{#snippet title()}
		<ShuffleIcon class="size-4" /> Email aliases
	{/snippet}
	{#snippet summary()}
		{#if scopedNotPersonal}
			Aliases are available on personal mailboxes.
		{:else if summaryQuery?.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else}
			{summaryQuery.current.filter((alias) => alias.isEnabled).length} active
		{/if}
	{/snippet}
	<Card.CardDescription>
		Hide-my-email: random, revocable addresses that forward to your personal mailbox. Shared
		mailboxes don't support aliases. Disable or delete an alias to stop receiving on it.
	</Card.CardDescription>
	<div class="flex flex-col gap-5">
		{#if mailboxesQ.current === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-8 w-full rounded-md" />
				<Skeleton class="h-8 w-full rounded-md" />
			</div>
		{:else if scopedNotPersonal}
			<p class="text-muted-foreground text-sm">Aliases are available on personal mailboxes.</p>
		{:else}
			{@const personalMailboxes = mailboxesQ.current.filter(
				(mailbox) => mailbox.isPersonal && (!mailboxId || mailbox.id === mailboxId)
			)}
			{#if personalMailboxes.length}
				{#each personalMailboxes as mailbox (mailbox.id)}
					{@const aliasesQuery = listAliases(mailbox.id)}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between gap-2">
							{#if !mailboxId}
								<span class="min-w-0 truncate font-mono text-sm">{mailbox.address}</span>
							{/if}
							<Button
								size="sm"
								variant="outline"
								class="shrink-0"
								disabled={busy === mailbox.id}
								onclick={() => generate(mailbox.id)}
							>
								<ShuffleIcon class="mr-1 size-3.5" /> Generate alias
							</Button>
						</div>
						{#if aliasesQuery.current}
							{@const aliases = aliasesQuery.current}
							{#if aliases.length}
								<ul class="flex flex-col divide-y rounded-md border">
									{#each aliases as alias (alias.id)}
										<li class="flex items-center gap-2 px-3 py-2">
											<span
												class="flex-1 truncate font-mono text-xs {alias.isEnabled
													? ''
													: 'text-muted-foreground line-through'}"
											>
												{alias.address}
											</span>
											<Button
												size="icon"
												variant="ghost"
												class="size-8"
												title="Copy"
												aria-label="Copy {alias.address}"
												onclick={() => copy(alias.address)}
											>
												<CopyIcon class="size-3.5" />
											</Button>
											<Switch
												checked={alias.isEnabled}
												disabled={busy === alias.id}
												onCheckedChange={(enabled) => toggle(mailbox.id, alias.id, enabled)}
												aria-label="{alias.isEnabled ? 'Disable' : 'Enable'} {alias.address}"
											/>
											<AlertDialog.Root>
												<AlertDialog.Trigger>
													{#snippet child({ props })}
														<Button
															{...props}
															size="icon"
															variant="ghost"
															class="text-destructive hover:text-destructive size-8"
															title="Delete"
															aria-label="Delete {alias.address}"
															disabled={busy === alias.id}
														>
															<Trash2Icon class="size-3.5" />
														</Button>
													{/snippet}
												</AlertDialog.Trigger>
												<AlertDialog.Content>
													<AlertDialog.Header>
														<AlertDialog.Title>Delete this alias?</AlertDialog.Title>
														<AlertDialog.Description>
															<span class="font-mono">{alias.address}</span> will stop forwarding and mail sent
															to it will bounce. This can't be undone.
														</AlertDialog.Description>
													</AlertDialog.Header>
													<AlertDialog.Footer>
														<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
														<AlertDialog.Action
															onclick={(event) => {
																event.preventDefault();
																remove(mailbox.id, alias.id);
															}}
															class="bg-destructive text-white hover:bg-destructive/90"
														>
															Delete
														</AlertDialog.Action>
													</AlertDialog.Footer>
												</AlertDialog.Content>
											</AlertDialog.Root>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="text-muted-foreground text-xs">No aliases for this mailbox yet.</p>
							{/if}
						{:else}
							<Skeleton class="h-8 w-full rounded-md" />
						{/if}
					</div>
				{/each}
			{:else}
				<p class="text-muted-foreground text-sm">No personal mailbox to add aliases to.</p>
			{/if}
		{/if}
	</div>
</SettingsCollapsibleCard>
