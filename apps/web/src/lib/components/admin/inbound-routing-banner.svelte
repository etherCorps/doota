<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Self-contained inbound-routing health banner: probes the org's Email Routing
     catch-all on mount and renders nothing while healthy. Mounted on the org
     OVERVIEW (the page admins actually visit) so a detached catch-all — mail
     silently not arriving — surfaces where it will be seen, with the fix inline.
   Hallmark · component: alert-banner · states: hidden/detached/fixing -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { mailRoutingConfig, refreshDomain } from '$lib/rpc/domains.remote';

	let { orgId, domain }: { orgId: string; domain: string } = $props();

	let detached = $state(false);
	let fixing = $state(false);

	async function check() {
		try {
			detached = (await mailRoutingConfig(orgId)).catchAllAttached === false;
		} catch {
			// Best-effort probe: a CF hiccup (or a non-superadmin viewer, who can't
			// fix this anyway) must not break the overview — stay hidden.
		}
	}
	onMount(check);

	async function reattach() {
		fixing = true;
		try {
			await refreshDomain(orgId);
			await check();
			if (!detached) toast.success('Inbound routing reattached.');
			else toast.error('Still not attached — is the mail worker deployed?');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not reattach routing.');
		} finally {
			fixing = false;
		}
	}
</script>

{#if detached}
	<div class="border-destructive/30 bg-destructive/5 space-y-2 rounded-lg border p-3">
		<p class="flex items-center gap-1.5 text-sm font-medium">
			<TriangleAlertIcon class="text-destructive size-4" /> Inbound routing isn't attached
		</p>
		<p class="text-muted-foreground text-xs">
			Incoming mail for <span class="font-mono">{domain}</span> is not reaching Doota — the Email
			Routing catch-all isn't pointed at the mail worker. Reattach to fix it now.
		</p>
		<Button variant="outline" size="sm" disabled={fixing} onclick={reattach}>
			{#if fixing}<Spinner class="mr-1" />{:else}<RefreshCwIcon class="mr-1 size-3.5" />{/if}
			Reattach
		</Button>
	</div>
{/if}
