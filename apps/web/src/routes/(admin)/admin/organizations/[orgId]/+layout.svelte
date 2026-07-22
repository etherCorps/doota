<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import StatusChip from '$lib/components/admin/status-chip.svelte';
	import TabNav from '$lib/components/admin/tab-nav.svelte';
	import GlobeIcon from '@lucide/svelte/icons/globe';

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
	// First path segment after the org base ('' = the overview index).
	const rel = $derived(page.url.pathname.slice(base.length).replace(/^\//, '').split('/')[0]);
	const tabs = $derived(
		[
			{ key: '', label: 'Overview' },
			{ key: 'members', label: 'Members' },
			{ key: 'mailboxes', label: 'Mailboxes' },
			{ key: 'suppressions', label: 'Suppressions' },
			{ key: 'insights', label: 'Insights' },
			{ key: 'domain', label: 'Domain' },
			{ key: 'settings', label: 'Settings' }
		].map((t) => ({ href: t.key ? `${base}/${t.key}` : base, label: t.label, active: rel === t.key }))
	);
</script>

<div class="flex w-full flex-col gap-6 p-4 sm:p-6 md:p-8">
	<div class="flex min-w-0 items-center gap-3">
		<div class="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md">
			{#if data.org.logo}
				<img src={data.org.logo} alt="" class="size-full object-cover" />
			{:else}
				<GlobeIcon class="size-5" />
			{/if}
		</div>
		<div class="flex min-w-0 flex-col gap-0.5">
			<h1 class="font-heading truncate text-xl font-semibold tracking-tight sm:text-2xl">{data.org.name}</h1>
			<span class="flex min-w-0 items-center gap-2">
				<span class="text-muted-foreground truncate font-mono text-sm">{data.org.domain}</span>
				<StatusChip status={chip} />
			</span>
		</div>
	</div>

	<TabNav {tabs} />

	{@render children()}
</div>
