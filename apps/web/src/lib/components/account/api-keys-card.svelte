<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { myApiKeys, revokeApiKeyById } from '$lib/rpc/api-keys.remote';

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
			toast.error(err instanceof Error ? err.message : 'Could not revoke the key.');
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
					{#each keys as k (k.id)}
						<li class="flex items-center gap-3 py-2.5">
							<div class="flex min-w-0 flex-1 flex-col">
								<span class="truncate text-sm font-medium">{k.name || 'Untitled key'}</span>
								<span class="text-muted-foreground truncate font-mono text-xs">
									{k.prefix}…{#if k.mailboxId} · scoped{/if} · created {fmt(k.createdAt)}
									{#if k.lastUsedAt} · used {fmt(k.lastUsedAt)}{/if}
								</span>
							</div>
							{#if k.revokedAt}
								<Badge variant="outline">Revoked</Badge>
							{:else}
								<Button
									size="sm"
									variant="outline"
									class="text-destructive hover:text-destructive"
									onclick={() => revoke(k.id)}
								>
									Revoke
								</Button>
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
