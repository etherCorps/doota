<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import ApiKeysCard from '$lib/components/account/api-keys-card.svelte';
	import * as Card from '$lib/components/ui/card/index.js';
	import TerminalIcon from '@lucide/svelte/icons/terminal';

	// Real endpoint contract (src/routes/api/send/+server.ts). Quoted, not invented.
	const example = `curl https://your-domain/api/send \\
  -H "Authorization: Bearer dk_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "mailboxId": "mbx_…",
    "to": ["someone@example.com"],
    "subject": "Hello",
    "text": "Sent via the Doota API"
  }'`;

	const fields: { name: string; note: string }[] = [
		{ name: 'mailboxId', note: 'Required. A mailbox you can send as.' },
		{ name: 'to · cc · bcc', note: 'Recipient arrays — at least one address total.' },
		{ name: 'subject', note: 'Plain string.' },
		{ name: 'text · html', note: 'Message body; send either or both.' },
		{ name: 'fromAliasId', note: 'Optional. Send via one of your aliases.' }
	];
</script>

<div class="flex flex-col gap-6">
	<ApiKeysCard />

	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="flex items-center gap-2">
				<TerminalIcon class="size-4" /> Using the API
			</Card.CardTitle>
			<Card.CardDescription>
				One endpoint — <span class="font-mono">POST /api/send</span>. Bearer-authenticated,
				send-only. A <span class="font-mono">202</span> returns a
				<span class="font-mono">submissionId</span>.
			</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent class="flex flex-col gap-4">
			<pre
				class="bg-muted text-foreground min-w-0 overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed">{example}</pre>
			<dl class="divide-y text-sm">
				{#each fields as f (f.name)}
					<div class="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between sm:gap-4">
						<dt class="font-mono text-xs font-medium">{f.name}</dt>
						<dd class="text-muted-foreground text-xs sm:text-right">{f.note}</dd>
					</div>
				{/each}
			</dl>
		</Card.CardContent>
	</Card.Card>
</div>
