<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { refreshDomain, domainDnsRecords } from '$lib/rpc/domains.remote.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	let { data } = $props();
	const org = $derived(data.org);

	const STATUS: Record<string, { label: string; chip: string }> = {
		pending_zone: { label: 'Creating zone…', chip: 'pending' },
		pending_nameservers: { label: 'Awaiting nameservers', chip: 'pending' },
		wiring: { label: 'Wiring mail…', chip: 'pending' },
		active: { label: 'Active', chip: 'active' },
		error: { label: 'Error', chip: 'failed' }
	};
	const stat = $derived(STATUS[org.status] ?? { label: org.status, chip: 'pending' });

	let refreshing = $state(false);
	let nameservers = $state<string[] | null>(null);
	let dnsLoading = $state(false);
	let dnsRecords = $state<
		{ category: string; type: string; name: string; value: string; priority?: number }[]
	>([]);

	onMount(async () => {
		if (!org.zoneId) return;
		dnsLoading = true;
		try {
			dnsRecords = await domainDnsRecords(org.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not load DNS records.');
		} finally {
			dnsLoading = false;
		}
	});

	async function refresh() {
		refreshing = true;
		try {
			const res = await refreshDomain(org.id);
			if (res.status === 'active') toast.success(`${org.domain} is active — mail is wired.`);
			else if (res.nameServers?.length) nameservers = res.nameServers;
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Refresh failed.');
		} finally {
			refreshing = false;
		}
	}
</script>

<Card.Card>
	<Card.CardHeader class="flex-row items-center justify-between gap-2">
		<div class="flex flex-col gap-1">
			<Card.CardTitle class="font-heading">Mail routing</Card.CardTitle>
			<Card.CardDescription class="flex items-center gap-2">
				<StatusChip status={stat.chip} /> {stat.label}
			</Card.CardDescription>
		</div>
		{#if org.status !== 'active' && org.zoneId}
			<Button variant="outline" size="sm" disabled={refreshing} onclick={refresh}>
				{#if refreshing}<Spinner class="mr-1" />{:else}<RefreshCwIcon class="mr-1 size-3.5" />{/if}
				Refresh
			</Button>
		{/if}
	</Card.CardHeader>
	<Card.CardContent class="space-y-4">
		{#if nameservers}
			<div class="bg-muted/40 space-y-1 rounded-lg border p-3">
				<p class="text-sm font-medium">Delegate {org.domain}</p>
				<p class="text-muted-foreground text-xs">Point the domain's nameservers at:</p>
				{#each nameservers as ns (ns)}
					<code class="block font-mono text-xs">{ns}</code>
				{/each}
			</div>
		{/if}

		{#if !org.zoneId}
			<p class="text-muted-foreground text-sm">No Cloudflare zone yet.</p>
		{:else if dnsLoading}
			<div class="text-muted-foreground flex items-center gap-2 text-sm">
				<Spinner /> Loading records…
			</div>
		{:else if dnsRecords.length === 0}
			<p class="text-muted-foreground text-sm">
				No records to populate — Cloudflare-hosted DNS manages them automatically.
			</p>
		{:else}
			<p class="text-muted-foreground text-xs">
				Add these at your DNS provider if the zone isn't Cloudflare-hosted:
			</p>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-20">Type</Table.Head>
						<Table.Head>Name</Table.Head>
						<Table.Head>Value</Table.Head>
						<Table.Head class="w-20 text-right">Priority</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each dnsRecords as r (r.type + r.name + r.value)}
						<Table.Row>
							<Table.Cell class="font-mono">{r.type}</Table.Cell>
							<Table.Cell class="font-mono break-all">{r.name}</Table.Cell>
							<Table.Cell class="font-mono break-all">{r.value}</Table.Cell>
							<Table.Cell class="text-right">{r.priority ?? '—'}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.CardContent>
</Card.Card>
