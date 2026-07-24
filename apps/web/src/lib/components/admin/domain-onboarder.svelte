<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import { onboardDomain, linkDomain, listCloudflareZones } from '$lib/rpc/domains.remote.js';

	// Called after a successful onboard/link so the host can refresh (e.g. invalidateAll).
	let { onChange }: { onChange?: () => void } = $props();

	type Zone = { id: string; name: string; active: boolean; onboarded: boolean; configured: boolean };
	let zones = $state<Zone[] | null>(null);
	let loadingZones = $state(false);
	let zonesError = $state(false);
	let busy = $state<string | null>(null);
	let subFor = $state<string | null>(null);
	let subValue = $state('');
	let nameservers = $state<{ domain: string; ns: string[] } | null>(null);

	const available = $derived((zones ?? []).filter((z) => !z.onboarded));

	onMount(loadZones);

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
			subFor = null;
			subValue = '';
			await loadZones();
			onChange?.();
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
			await loadZones();
			onChange?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Link failed.');
		} finally {
			busy = null;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<!-- Cloudflare zones -->
	<div class="space-y-2">
		{#if loadingZones}
			<div class="text-muted-foreground flex items-center gap-2 py-3 text-sm">
				<Spinner /> Loading zones…
			</div>
		{:else if zonesError}
			<p class="text-muted-foreground text-sm">
				Couldn't reach Cloudflare. Check <code>APP_CLOUDFLARE_ACCOUNT_ID</code> / <code>APP_CLOUDFLARE_API_TOKEN</code>.
				<Button variant="link" class="px-1" onclick={loadZones}>Retry</Button>
			</p>
		{:else if available.length === 0}
			<p class="text-muted-foreground text-sm">
				Every zone on the account is already onboarded. Add the domain to your Cloudflare account first, then reload.
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
