<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { myApiKeys, createApiKeyForUser, revokeApiKeyById } from '$lib/rpc/api-keys.remote';
	import { sendIdentities } from '$lib/rpc/draft.remote';

	// Single stable query instance — render from `.current` so a post-mutation
	// refresh() updates in place instead of re-suspending (which blanks the list).
	const keysQ = myApiKeys();

	// Mailboxes the user can send as (for the optional key scope).
	const mailboxOptions = $derived.by(async () => {
		const ids = await sendIdentities();
		const seen = new Map<string, string>();
		for (const i of ids) if (i.kind === 'mailbox') seen.set(i.mailboxId, i.address);
		return [...seen].map(([mailboxId, address]) => ({ mailboxId, address }));
	});

	let createOpen = $state(false);
	let name = $state('');
	let scope = $state<string>(''); // '' = any mailbox
	let creating = $state(false);
	let newSecret = $state<string | null>(null);

	async function create() {
		creating = true;
		try {
			const res = await createApiKeyForUser({ name: name || undefined, mailboxId: scope || null });
			newSecret = res.key;
			name = '';
			scope = '';
			await keysQ.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not create the key.');
		} finally {
			creating = false;
		}
	}

	async function revoke(keyId: string) {
		try {
			await revokeApiKeyById({ keyId });
			toast.success('Key revoked.');
			await keysQ.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not revoke the key.');
		}
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to clipboard.');
	}

	function fmt(ms: number | null): string {
		return ms ? new Date(ms).toLocaleDateString() : '—';
	}

	function closeCreate() {
		createOpen = false;
		newSecret = null;
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<KeyRoundIcon class="size-4" /> API keys
		</Card.CardTitle>
		<Card.CardDescription>
			Bearer keys for programmatic send only (<span class="font-mono">POST /api/send</span>). A key
			can send mail as you and nothing else — no account, admin, or read access — and is limited to
			mailboxes you can send as. The secret is shown once.
		</Card.CardDescription>
		<Card.CardAction>
			<Button size="sm" variant="outline" onclick={() => (createOpen = true)}>New key</Button>
		</Card.CardAction>
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
				<div class="flex flex-col items-center gap-3 py-6 text-center">
					<p class="text-muted-foreground text-sm">No API keys yet.</p>
					<Button size="sm" variant="outline" class="gap-1.5" onclick={() => (createOpen = true)}>
						<KeyRoundIcon class="size-3.5" /> Create a key
					</Button>
				</div>
			{/if}
		{:else}
			<div class="flex flex-col gap-3">
				<Skeleton class="h-10 w-full rounded-md" />
				<Skeleton class="h-10 w-full rounded-md" />
			</div>
		{/if}
	</Card.CardContent>
</Card.Card>

<Dialog.Root open={createOpen} onOpenChange={(o) => !o && closeCreate()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-heading">
				{newSecret ? 'Copy your key' : 'New API key'}
			</Dialog.Title>
			<Dialog.Description>
				{#if newSecret}
					This is the only time the secret is shown. Store it somewhere safe.
				{:else}
					Optionally name it and scope it to one mailbox.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if newSecret}
			<div class="flex items-center gap-2 py-2">
				<Input readonly value={newSecret} class="font-mono text-xs" />
				<Button size="icon" variant="outline" onclick={() => copy(newSecret!)}>
					<CopyIcon class="size-4" />
				</Button>
			</div>
			<div class="flex justify-end">
				<Button onclick={closeCreate}>Done</Button>
			</div>
		{:else}
			<div class="flex flex-col gap-3 py-2">
				<Field.Field>
					<Field.Label>Name (optional)</Field.Label>
					<Input bind:value={name} placeholder="CI deploy bot" autocomplete="off" />
				</Field.Field>
				<Field.Field>
					<Field.Label>Send as</Field.Label>
					<select
						bind:value={scope}
						class="border-input bg-background h-9 rounded-md border px-3 text-sm"
					>
						<option value="">Any mailbox I can send as</option>
						{#await mailboxOptions then opts}
							{#each opts as o (o.mailboxId)}
								<option value={o.mailboxId}>{o.address}</option>
							{/each}
						{/await}
					</select>
				</Field.Field>
				<div class="flex justify-end gap-2 pt-1">
					<Button type="button" variant="ghost" onclick={closeCreate} disabled={creating}>
						Cancel
					</Button>
					<Button type="button" onclick={create} disabled={creating}>
						{#if creating}<Spinner class="mr-1" />{/if}
						Create key
					</Button>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
