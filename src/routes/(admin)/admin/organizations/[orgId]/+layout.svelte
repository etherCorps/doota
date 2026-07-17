<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import { cn } from '$lib/utils/ui.js';

	let { data, children } = $props();

	const STATUS_CHIP: Record<string, string> = {
		pending_zone: 'pending',
		pending_nameservers: 'pending',
		wiring: 'pending',
		active: 'active',
		error: 'failed'
	};
	const chip = $derived(STATUS_CHIP[data.org.status] ?? 'pending');

	const base = $derived(`${resolve('/admin/organizations')}/${data.org.id}`);
	const tabs = [
		{ slug: 'dns', label: 'DNS' },
		{ slug: 'members', label: 'Members' },
		{ slug: 'settings', label: 'Settings' }
	];
	const current = $derived(page.url.pathname.split('/').pop());
</script>

<div class="flex w-full flex-col gap-6 p-6 md:p-8">
	<div class="flex items-center gap-3">
		<div class="bg-muted text-muted-foreground flex size-10 items-center justify-center overflow-hidden rounded-md">
			{#if data.org.logo}
				<img src={data.org.logo} alt="" class="size-full object-cover" />
			{:else}
				<GlobeIcon class="size-5" />
			{/if}
		</div>
		<div class="flex flex-col gap-0.5">
			<h1 class="font-heading text-2xl font-semibold tracking-tight">{data.org.name}</h1>
			<span class="flex items-center gap-2">
				<span class="text-muted-foreground font-mono text-sm">{data.org.domain}</span>
				<StatusChip status={chip} />
			</span>
		</div>
	</div>

	<nav class="border-b">
		<div class="-mb-px flex gap-1">
			{#each tabs as t (t.slug)}
				<a
					href="{base}/{t.slug}"
					class={cn(
						'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
						current === t.slug
							? 'border-primary text-foreground'
							: 'text-muted-foreground hover:text-foreground border-transparent'
					)}
				>
					{t.label}
				</a>
			{/each}
		</div>
	</nav>

	{@render children()}
</div>
