<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { domains } from '$lib/mock/index.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
	<div class="flex items-center justify-between">
		<div class="flex flex-col gap-1">
			<h1 class="font-heading text-2xl font-semibold tracking-tight">Domains</h1>
			<p class="text-muted-foreground text-sm">Sending domains and their DKIM status.</p>
		</div>
		<Button class="gap-1.5" onclick={() => console.log('TODO: onboard domain')}>
			<PlusIcon class="size-4" /> Onboard domain
		</Button>
	</div>

	<Card.Card class="overflow-hidden py-0">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>Domain</Table.Head>
					<Table.Head>DKIM</Table.Head>
					<Table.Head>Sending</Table.Head>
					<Table.Head class="text-right">Users</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each domains as domain (domain.id)}
					<Table.Row>
						<Table.Cell class="font-mono font-medium">{domain.domain}</Table.Cell>
						<Table.Cell><StatusChip status={domain.dkim} /></Table.Cell>
						<Table.Cell><StatusChip status={domain.sending} /></Table.Cell>
						<Table.Cell class="text-right">{domain.users}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Card.Card>
</div>
