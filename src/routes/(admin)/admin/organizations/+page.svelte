<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import DomainOnboarder from '$lib/components/admin/domain-onboarder.svelte';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let { data } = $props();

	const STATUS: Record<string, string> = {
		pending_zone: 'pending',
		pending_nameservers: 'pending',
		wiring: 'pending',
		active: 'active',
		error: 'failed'
	};
	const chip = (s: string) => STATUS[s] ?? 'pending';

	let addOpen = $state(false);
</script>

<div class="flex w-full flex-col gap-6 p-6 md:p-8">
	<div class="flex items-center justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h1 class="font-heading text-2xl font-semibold tracking-tight">Organizations</h1>
			<p class="text-muted-foreground text-sm">
				One organization per mail domain. Open one to manage DNS, members and settings.
			</p>
		</div>
		{#if data.canCreate}
			<Button class="gap-1.5" onclick={() => (addOpen = true)}>
				<PlusIcon class="size-4" /> Add organization
			</Button>
		{/if}
	</div>

	{#if data.orgs.length}
		<Card.Card class="overflow-hidden py-0">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Organization</Table.Head>
						<Table.Head>Domain</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="text-right">Members</Table.Head>
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.orgs as org (org.id)}
						<Table.Row
							class="hover:bg-muted/50 cursor-pointer"
							onclick={() => goto(`${resolve('/admin/organizations')}/${org.id}`)}
						>
							<Table.Cell>
								<div class="flex items-center gap-3">
									<div class="bg-muted text-muted-foreground flex size-8 items-center justify-center overflow-hidden rounded-md">
										{#if org.logo}
											<img src={org.logo} alt="" class="size-full object-cover" />
										{:else}
											<GlobeIcon class="size-4" />
										{/if}
									</div>
									<span class="font-medium">{org.name}</span>
								</div>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground font-mono text-sm">{org.domain}</Table.Cell>
							<Table.Cell><StatusChip status={chip(org.status)} /></Table.Cell>
							<Table.Cell class="text-right tabular-nums">{org.members}</Table.Cell>
							<Table.Cell>
								<ChevronRightIcon class="text-muted-foreground size-4" />
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Card>
	{:else}
		<Card.Card>
			<Card.CardContent class="flex flex-col items-center gap-3 py-10 text-center">
				<div class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
					<GlobeIcon class="size-5" />
				</div>
				<p class="font-medium">No organizations yet</p>
				<p class="text-muted-foreground text-sm">
					{data.canCreate
						? 'Onboard a domain to create its organization.'
						: 'Ask a super-admin to onboard a domain before you can manage members.'}
				</p>
				{#if data.canCreate}
					<Button onclick={() => (addOpen = true)}>Onboard a domain</Button>
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}
</div>

<!-- Onboard a domain (superadmin) — Cloudflare zone picker + manual add -->
<Dialog.Root bind:open={addOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="font-heading">Add organization</Dialog.Title>
			<Dialog.Description>
				Pick a domain from your Cloudflare account, or add a new one. Active zones wire mail
				immediately; new zones return nameservers to delegate first.
			</Dialog.Description>
		</Dialog.Header>

		<DomainOnboarder onChange={() => invalidateAll()} />
	</Dialog.Content>
</Dialog.Root>
