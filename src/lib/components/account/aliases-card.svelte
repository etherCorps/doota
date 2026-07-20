<script lang="ts">
	import ShuffleIcon from '@lucide/svelte/icons/shuffle';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import { listAliases, generateAlias, toggleAlias, deleteAlias } from '$lib/rpc/alias.remote';

	let busy = $state<string | null>(null);

	async function generate(mailboxId: string) {
		busy = mailboxId;
		try {
			const res = await generateAlias({ mailboxId });
			toast.success(`Created ${res.address}`);
			await listAliases(mailboxId).refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create an alias.');
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
			toast.error(err instanceof Error ? err.message : 'Could not update the alias.');
		} finally {
			busy = null;
		}
	}

	async function remove(mailboxId: string, aliasId: string) {
		busy = aliasId;
		try {
			await deleteAlias(aliasId);
			toast.success('Alias deleted.');
			await listAliases(mailboxId).refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not delete the alias.');
		} finally {
			busy = null;
		}
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to clipboard.');
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<ShuffleIcon class="size-4" /> Email aliases
		</Card.CardTitle>
		<Card.CardDescription>
			Hide-my-email: random, revocable addresses that forward to your personal mailbox. Shared
			mailboxes don't support aliases. Disable or delete an alias to stop receiving on it.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-5">
		{#await myMailboxes() then allBoxes}
			{@const boxes = allBoxes.filter((b) => b.isPersonal)}
			{#if boxes.length}
				{#each boxes as box (box.id)}
					{@const aliasesQ = listAliases(box.id)}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between">
							<span class="font-mono text-sm">{box.address}</span>
							<Button
								size="sm"
								variant="outline"
								disabled={busy === box.id}
								onclick={() => generate(box.id)}
							>
								<ShuffleIcon class="mr-1 size-3.5" /> Generate alias
							</Button>
						</div>
						{#if aliasesQ.current}
							{@const aliases = aliasesQ.current}
							{#if aliases.length}
								<ul class="flex flex-col divide-y rounded-md border">
									{#each aliases as a (a.id)}
										<li class="flex items-center gap-2 px-3 py-2">
											<span
												class="flex-1 truncate font-mono text-xs {a.isEnabled
													? ''
													: 'text-muted-foreground line-through'}"
											>
												{a.address}
											</span>
											<Button
												size="icon"
												variant="ghost"
												class="size-7"
												title="Copy"
												onclick={() => copy(a.address)}
											>
												<CopyIcon class="size-3.5" />
											</Button>
											<Switch
												checked={a.isEnabled}
												disabled={busy === a.id}
												onCheckedChange={(v) => toggle(box.id, a.id, v)}
												aria-label="Enabled"
											/>
											<Button
												size="icon"
												variant="ghost"
												class="text-destructive hover:text-destructive size-7"
												title="Delete"
												disabled={busy === a.id}
												onclick={() => remove(box.id, a.id)}
											>
												<Trash2Icon class="size-3.5" />
											</Button>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="text-muted-foreground text-xs">No aliases for this mailbox yet.</p>
							{/if}
						{/if}
					</div>
				{/each}
			{:else}
				<p class="text-muted-foreground text-sm">No personal mailbox to add aliases to.</p>
			{/if}
		{/await}
	</Card.CardContent>
</Card.Card>
