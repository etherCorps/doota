<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { onboardDomain, linkDomain, listCloudflareZones } from '$lib/rpc/domains.remote.js';
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

	// --- Onboarding (superadmin) --------------------------------------------
	type Zone = { id: string; name: string; active: boolean; onboarded: boolean; configured: boolean };
	let addOpen = $state(false);
	let zones = $state<Zone[] | null>(null);
	let loadingZones = $state(false);
	let zonesError = $state(false);
	let busy = $state<string | null>(null);
	let subFor = $state<string | null>(null);
	let subValue = $state('');
	let manualDomain = $state('');
	let manualSub = $state('');
	let nameservers = $state<{ domain: string; ns: string[] } | null>(null);

	const available = $derived((zones ?? []).filter((z) => !z.onboarded));

	onMount(() => {
		if (data.canCreate) loadZones();
	});

	async function loadZones() {
		loadingZones = true;
		zonesError = false;
		try {
			zones = await listCloudflareZones();
		} catch {
			zonesError = true;
			zones = [];
		} finally {
			loadingZones = false;
		}
	}

	async function onboard(domain: string, sendingSubdomain?: string) {
		const d = domain.trim().toLowerCase();
		if (!d) return;
		busy = d;
		nameservers = null;
		try {
			const res = await onboardDomain({ domain: d, sendingSubdomain });
			if (!res.success) {
				toast.error(res.message ?? 'Could not onboard domain.');
				return;
			}
			if (res.status === 'active') {
				toast.success(`${d} is active — mail is wired.`);
			} else {
				toast.success(`${d} added. Delegate the nameservers, then Refresh in its DNS tab.`);
				if (res.nameServers?.length) nameservers = { domain: d, ns: res.nameServers };
			}
			manualDomain = '';
			manualSub = '';
			subFor = null;
			subValue = '';
			await Promise.all([invalidateAll(), loadZones()]);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Onboarding failed.');
		} finally {
			busy = null;
		}
	}

	async function link(domain: string) {
		busy = domain;
		try {
			const res = await linkDomain(domain);
			if (!res.success) {
				toast.error(res.message ?? 'Could not link domain.');
				return;
			}
			toast.success(`${domain} linked — synced from Cloudflare.`);
			await Promise.all([invalidateAll(), loadZones()]);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Link failed.');
		} finally {
			busy = null;
		}
	}
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

		<div class="flex flex-col gap-4">
			<!-- Cloudflare zones -->
			<div class="space-y-2">
				{#if loadingZones}
					<div class="text-muted-foreground flex items-center gap-2 py-3 text-sm">
						<Spinner /> Loading zones…
					</div>
				{:else if zonesError}
					<p class="text-muted-foreground text-sm">
						Couldn't reach Cloudflare. Check <code>CF_ACCOUNT_ID</code> / <code>CF_API_TOKEN</code>.
						<Button variant="link" class="px-1" onclick={loadZones}>Retry</Button>
					</p>
				{:else if available.length === 0}
					<p class="text-muted-foreground text-sm">
						Every zone on the account is already onboarded. Add a new one below.
					</p>
				{:else}
					{#each available as z (z.id)}
						<div class="flex flex-col gap-2 rounded-lg border p-3">
							<div class="flex items-center gap-3">
								<span class="font-mono text-sm font-medium">{z.name}</span>
								{#if z.configured}
									<StatusChip status="active" />
									<span class="text-muted-foreground text-xs">Already set up on Cloudflare</span>
								{:else}
									<StatusChip status={z.active ? 'active' : 'pending'} />
								{/if}
								<div class="ml-auto flex items-center gap-2">
									{#if z.configured}
										<Button size="sm" disabled={busy === z.name} onclick={() => link(z.name)}>
											{#if busy === z.name}<Spinner class="mr-1" />{/if}
											Link
										</Button>
									{:else}
										<Button
											variant="ghost"
											size="sm"
											onclick={() => {
												subFor = subFor === z.name ? null : z.name;
												subValue = '';
											}}
										>
											Sending subdomain
										</Button>
										<Button
											size="sm"
											disabled={busy === z.name}
											onclick={() => onboard(z.name, subFor === z.name ? subValue || undefined : undefined)}
										>
											{#if busy === z.name}<Spinner class="mr-1" />{/if}
											Onboard
										</Button>
									{/if}
								</div>
							</div>
							{#if subFor === z.name && !z.configured}
								<Input class="font-mono" placeholder="send.{z.name} (optional outbound DKIM host)" bind:value={subValue} />
							{/if}
						</div>
					{/each}
				{/if}
			</div>

			<!-- Manual add -->
			<div class="space-y-2 border-t pt-4">
				<p class="text-sm font-medium">Add a new domain</p>
				<Input class="font-mono" placeholder="acme.com" bind:value={manualDomain} />
				<Input class="font-mono" placeholder="send.acme.com (optional sending subdomain)" bind:value={manualSub} />
				<Button
					class="w-full"
					disabled={!manualDomain.trim() || busy === manualDomain.trim().toLowerCase()}
					onclick={() => onboard(manualDomain, manualSub.trim() || undefined)}
				>
					{#if busy === manualDomain.trim().toLowerCase()}<Spinner class="mr-1" />{/if}
					Onboard
				</Button>
			</div>

			{#if nameservers}
				<div class="bg-muted/40 space-y-1 rounded-lg border p-3">
					<p class="text-sm font-medium">Delegate {nameservers.domain}</p>
					<p class="text-muted-foreground text-xs">Point the domain's nameservers at:</p>
					{#each nameservers.ns as ns (ns)}
						<code class="block font-mono text-xs">{ns}</code>
					{/each}
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
