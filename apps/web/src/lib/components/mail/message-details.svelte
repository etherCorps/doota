<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Gmail "show details" envelope for one message, from the DTO we already carry.
     mailed-by (return-path) + signed-by (DKIM d=) are deferred (need extra
     ingest). Rendered under the message header when the details ▼ is toggled. -->
<script lang="ts">
	import type { MessageDTO } from '@doota/mail-core/mail-thread-contract';
	import { fmtDateTime } from '$lib/mail/format';

	let { m }: { m: MessageDTO } = $props();

	// Only rows with a value; Date is formatted locale-aware with a month name.
	const rows = $derived(
		[
			m.from && { label: 'From', value: m.from },
			m.to.length && { label: 'To', value: m.to.join(', ') },
			m.cc.length && { label: 'Cc', value: m.cc.join(', ') },
			m.replyTo && { label: 'Reply-To', value: m.replyTo },
			m.sentAt && { label: 'Date', value: fmtDateTime(m.sentAt) },
			m.viaAlias && { label: 'Via', value: m.viaAlias }
		].filter(Boolean) as { label: string; value: string }[]
	);
</script>

<dl class="bg-muted/40 mb-3 space-y-1 rounded-lg border px-3 py-2 text-[11px]">
	{#each rows as r (r.label)}
		<div class="flex gap-2">
			<dt class="text-faint w-16 shrink-0">{r.label}</dt>
			<dd class="text-muted-foreground min-w-0 flex-1 font-mono break-words">{r.value}</dd>
		</div>
	{/each}
	<div class="flex gap-2">
		<dt class="text-faint w-16 shrink-0">Security</dt>
		<dd class="min-w-0 flex-1">
			{#if m.senderVerified}
				<span class="text-ok font-medium">DMARC passed</span>
			{:else}
				<span class="text-muted-foreground">Not verified</span>
			{/if}
		</dd>
	</div>
</dl>
