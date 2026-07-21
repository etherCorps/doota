<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import {
		mailRoutingConfig,
		addMailSubdomain,
		removeMailSubdomain,
		toggleSubaddressing
	} from '$lib/rpc/domains.remote.js';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';

	let { data } = $props();
	const org = $derived(data.org);
	const ready = $derived(!!org.zoneId && org.status === 'active');

	type Routing = {
		enabled: boolean;
		supportSubaddress: boolean;
		status?: string;
		subdomains: string[];
	};
	let routing = $state<Routing | null>(null);
	let loading = $state(false);
	let subInput = $state('');
	let addingSub = $state(false);
	let subaddrBusy = $state(false);
	let removingSub = $state<string | null>(null);

	onMount(async () => {
		if (!ready) return;
		loading = true;
		try {
			routing = await mailRoutingConfig(org.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not load routing.');
		} finally {
			loading = false;
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
</script>

{#if !ready}
	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="font-heading">Inbound routing</Card.CardTitle>
			<Card.CardDescription>
				Route mail on subdomains and control plus-addressing.
			</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent>
			<p class="text-muted-foreground text-sm">
				Available once <span class="font-mono">{org.domain}</span> is active. Finish setup in the
				<a href="{resolve('/admin/organizations')}/{org.id}/dns" class="text-foreground underline">DNS</a>
				tab first.
			</p>
		</Card.CardContent>
	</Card.Card>
{:else}
	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="font-heading">Inbound routing</Card.CardTitle>
			<Card.CardDescription>
				Route mail on subdomains of {org.domain} and control plus-addressing.
			</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent class="space-y-6">
			{#if loading || !routing}
				<Skeleton class="h-10 w-full rounded-md" />
				<Skeleton class="h-24 w-full rounded-md" />
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
