<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import {
		refreshDomain,
		domainDnsRecords,
		mailRoutingConfig,
		addMailSubdomain,
		removeMailSubdomain,
		toggleSubaddressing
	} from '$lib/rpc/domains.remote.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

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

	type Routing = {
		enabled: boolean;
		supportSubaddress: boolean;
		status?: string;
		subdomains: string[];
	};
	let routing = $state<Routing | null>(null);
	let subInput = $state('');
	let addingSub = $state(false);
	let subaddrBusy = $state(false);
	let removingSub = $state<string | null>(null);

	onMount(async () => {
		if (!org.zoneId) return;
		dnsLoading = true;
		try {
			[dnsRecords, routing] = await Promise.all([
				domainDnsRecords(org.id),
				mailRoutingConfig(org.id)
			]);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not load DNS records.');
		} finally {
			dnsLoading = false;
		}
	});

	async function onToggleSubaddress(on: boolean) {
		if (!routing) return;
		subaddrBusy = true;
		try {
			const res = await toggleSubaddressing({ orgId: org.id, on });
			if (!res.success) {
				toast.error(res.message);
				return;
			}
			routing.supportSubaddress = on;
			toast.success(`Subaddressing ${on ? 'enabled' : 'disabled'}.`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not update subaddressing.');
		} finally {
			subaddrBusy = false;
		}
	}

	async function addSubdomain() {
		const value = subInput.trim();
		if (!value || !routing) return;
		addingSub = true;
		try {
			const res = await addMailSubdomain({ orgId: org.id, subdomain: value });
			if (!res.success) {
				toast.error(res.message);
				return;
			}
			if (!routing.subdomains.includes(res.subdomain)) {
				routing.subdomains = [...routing.subdomains, res.subdomain].sort();
			}
			subInput = '';
			toast.success(`Added ${res.subdomain}.`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not add subdomain.');
		} finally {
			addingSub = false;
		}
	}

	async function removeSubdomain(host: string) {
		if (!routing) return;
		removingSub = host;
		try {
			await removeMailSubdomain({ orgId: org.id, subdomain: host });
			routing.subdomains = routing.subdomains.filter((s) => s !== host);
			toast.success(`Removed ${host}.`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not remove subdomain.');
		} finally {
			removingSub = null;
		}
	}

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

{#if org.zoneId && org.status === 'active'}
	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="font-heading">Inbound routing</Card.CardTitle>
			<Card.CardDescription>
				Route mail on subdomains of {org.domain} and control plus-addressing.
			</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent class="space-y-6">
			{#if !routing}
				<div class="text-muted-foreground flex items-center gap-2 text-sm">
					<Spinner /> Loading routing…
				</div>
			{:else}
				<div class="flex items-start justify-between gap-4">
					<div class="space-y-0.5">
						<Label for="subaddr" class="text-sm font-medium">Subaddressing</Label>
						<p class="text-muted-foreground text-xs">
							Honor the <code class="font-mono">+</code> separator, e.g.
							<code class="font-mono">you+tag@{org.domain}</code>, when matching routing rules.
						</p>
					</div>
					<Switch
						id="subaddr"
						checked={routing.supportSubaddress}
						disabled={subaddrBusy}
						onCheckedChange={onToggleSubaddress}
					/>
				</div>

				<div class="space-y-3">
					<div class="space-y-0.5">
						<p class="text-sm font-medium">Routing subdomains</p>
						<p class="text-muted-foreground text-xs">
							Each adds MX so <code class="font-mono">*@sub.{org.domain}</code> is delivered to your
							mailbox.
						</p>
					</div>

					{#if routing.subdomains.length}
						<ul class="divide-y rounded-lg border">
							{#each routing.subdomains as host (host)}
								<li class="flex items-center justify-between gap-2 px-3 py-2">
									<code class="font-mono text-sm break-all">{host}</code>
									<Button
										variant="ghost"
										size="icon"
										class="text-muted-foreground hover:text-destructive size-8"
										disabled={removingSub === host}
										onclick={() => removeSubdomain(host)}
									>
										{#if removingSub === host}<Spinner />{:else}<Trash2Icon class="size-4" />{/if}
									</Button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-muted-foreground text-sm">No subdomains configured.</p>
					{/if}

					<form
						class="flex items-center gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							addSubdomain();
						}}
					>
						<Input
							bind:value={subInput}
							placeholder="mail"
							class="max-w-xs"
							disabled={addingSub}
							aria-label="Subdomain label"
						/>
						<span class="text-muted-foreground text-sm">.{org.domain}</span>
						<Button type="submit" size="sm" disabled={addingSub || !subInput.trim()}>
							{#if addingSub}<Spinner class="mr-1" />{:else}<PlusIcon class="mr-1 size-3.5" />{/if}
							Add
						</Button>
					</form>
				</div>
			{/if}
		</Card.CardContent>
	</Card.Card>
{/if}
