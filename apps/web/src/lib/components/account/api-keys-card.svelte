<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { myApiKeys, revokeApiKeyById } from '$lib/rpc/api-keys.remote';
	import { errorMessage } from '$lib/utils/error-message';

	// Read-only: new keys are issued by org admins against service mailboxes (a
	// leaked send key hurts the whole domain's reputation). Users may still revoke
	// their existing legacy keys.
	const keysQ = myApiKeys();

	async function revoke(keyId: string) {
		try {
			await revokeApiKeyById({ keyId });
			toast.success('Key revoked.');
			await keysQ.refresh();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not revoke the key.'));
		}
	}

	function fmt(ms: number | null): string {
		return ms ? new Date(ms).toLocaleDateString() : '—';
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<KeyRoundIcon class="size-4" /> API keys
		</Card.CardTitle>
		<Card.CardDescription>
			Programmatic send (<span class="font-mono">POST /api/send</span>) is issued by your org admins
			against a <span class="font-medium">service mailbox</span> — a send key affects the whole
			domain's reputation, so it isn't self-serve. Ask an admin to provision one. You can revoke any
			legacy key you still hold below.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		{#if keysQ.current}
			{@const keys = keysQ.current}
			{#if keys.length}
				<ul class="flex flex-col divide-y">
					{#each keys as apiKey (apiKey.id)}
						<li class="flex items-center gap-3 py-2.5">
							<div class="flex min-w-0 flex-1 flex-col">
								<span class="truncate text-sm font-medium">{apiKey.name || 'Untitled key'}</span>
								<span class="text-muted-foreground truncate font-mono text-xs">
									{apiKey.prefix}…{#if apiKey.mailboxId} · scoped{/if} · created {fmt(apiKey.createdAt)}
									{#if apiKey.lastUsedAt} · used {fmt(apiKey.lastUsedAt)}{/if}
								</span>
							</div>
							{#if apiKey.revokedAt}
								<Badge variant="outline">Revoked</Badge>
							{:else}
								<AlertDialog.Root>
									<AlertDialog.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												size="sm"
												variant="outline"
												class="text-destructive hover:text-destructive"
											>
												Revoke
											</Button>
										{/snippet}
									</AlertDialog.Trigger>
									<AlertDialog.Content>
										<AlertDialog.Header>
											<AlertDialog.Title>Revoke {apiKey.name || 'this key'}?</AlertDialog.Title>
											<AlertDialog.Description>
												Any client using <span class="font-mono">{apiKey.prefix}…</span> will immediately
												stop working. This can't be undone.
											</AlertDialog.Description>
										</AlertDialog.Header>
										<AlertDialog.Footer>
											<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
											<AlertDialog.Action
												onclick={(event) => {
													event.preventDefault();
													revoke(apiKey.id);
												}}
												class="bg-destructive text-white hover:bg-destructive/90"
											>
												Revoke
											</AlertDialog.Action>
										</AlertDialog.Footer>
									</AlertDialog.Content>
								</AlertDialog.Root>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-muted-foreground text-sm">
					No API keys. Programmatic access is managed by your org admins.
				</p>
			{/if}
		{:else}
			<div class="flex flex-col gap-3">
				<Skeleton class="h-10 w-full rounded-md" />
				<Skeleton class="h-10 w-full rounded-md" />
			</div>
		{/if}
	</Card.CardContent>
</Card.Card>
