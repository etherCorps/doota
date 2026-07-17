<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { threads, participant, domains } from '$lib/mock/index.js';
	import EyeIcon from '@lucide/svelte/icons/eye';

	// Read-only oversight across every org. Map each mock thread to a domain for the demo.
	const rows = threads.map((t, i) => ({
		...t,
		domain: domains[i % domains.length].domain,
		from: participant(t.participantIds[0])
	}));
</script>

<div class="flex w-full flex-col gap-6 p-6 md:p-8">
	<div class="flex flex-col gap-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Oversight</h1>
		<p class="text-muted-foreground flex items-center gap-1.5 text-sm">
			<EyeIcon class="size-3.5" /> Read-only mail across all organizations.
		</p>
	</div>

	<Card.Card class="overflow-hidden py-0">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Domain</Table.Head>
					<Table.Head>From</Table.Head>
					<Table.Head>Subject</Table.Head>
					<Table.Head class="text-right">When</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each rows as row (row.id)}
					<Table.Row>
						<Table.Cell class="font-mono text-sm">{row.domain}</Table.Cell>
						<Table.Cell class="font-mono text-muted-foreground text-xs">{row.from.email}</Table.Cell>
						<Table.Cell class="max-w-xs truncate">{row.subject}</Table.Cell>
						<Table.Cell class="text-muted-foreground text-right text-sm">{row.at}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Card>
</div>
