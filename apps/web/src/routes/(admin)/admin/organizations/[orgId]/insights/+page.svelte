<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import type { ColumnDef } from '@tanstack/table-core';
	import { toast } from 'svelte-sonner';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import DeliveryChart from '$lib/components/admin/delivery-chart.svelte';
	import { zoneAnalytics, zoneEmailLogs, zoneAudit } from '$lib/rpc/cf-insights.remote';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

	let { data } = $props();
	const org = $derived(data.org);

	type View = 'analytics' | 'logs' | 'audit';
	let view = $state<View>('analytics');

	type Days = 1 | 7 | 30;
	let days = $state<Days>(7);

	type Analytics = Awaited<ReturnType<typeof zoneAnalytics>>;
	type Logs = Awaited<ReturnType<typeof zoneEmailLogs>>;
	type Audit = Awaited<ReturnType<typeof zoneAudit>>;

	let analytics = $state<Analytics | null>(null);
	let logs = $state<Logs | null>(null);
	let audit = $state<Audit | null>(null);
	let loading = $state<Record<View, boolean>>({ analytics: false, logs: false, audit: false });
	// Gate on "attempted" (set even on error) so a failed fetch does NOT re-trigger
	// the effect forever — that was an infinite request loop / hang.
	let loaded = $state<Record<View, boolean>>({ analytics: false, logs: false, audit: false });

	// Live-fetch the active view on first open (and on manual refresh). Cached
	// server-side with a short TTL, so switching back and forth is cheap.
	async function load(targetView: View, force = false) {
		if (loading[targetView] || (!force && loaded[targetView])) return;
		loading = { ...loading, [targetView]: true };
		try {
			if (targetView === 'analytics') analytics = await zoneAnalytics({ orgId: org.id, days });
			else if (targetView === 'logs') logs = await zoneEmailLogs({ orgId: org.id, days });
			else audit = await zoneAudit({ orgId: org.id, days });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not load from Cloudflare.');
		} finally {
			loaded = { ...loaded, [targetView]: true };
			loading = { ...loading, [targetView]: false };
		}
	}

	// Refetch the active view whenever the view OR the range changes. Reading
	// `days` here registers it as a dependency; setDays() clears the flags.
	$effect(() => {
		days;
		load(view);
	});

	function setDays(newDays: Days) {
		if (newDays === days) return;
		analytics = logs = audit = null; // stale for the old range — drop and refetch
		loaded = { analytics: false, logs: false, audit: false };
		days = newDays;
	}

	const segments = [
		{ key: 'analytics' as const, label: 'Analytics' },
		{ key: 'logs' as const, label: 'Email logs' },
		{ key: 'audit' as const, label: 'Audit logs' }
	];
	const ranges = [
		{ key: 1 as const, label: '24h' },
		{ key: 7 as const, label: '7d' },
		{ key: 30 as const, label: '30d' }
	];

	// ---- Analytics rollup ----------------------------------------------------
	const isFail = (status: string) => /fail|bounce|drop|reject/i.test(status);
	const totals = $derived.by(() => {
		const rows = analytics ?? [];
		let delivered = 0,
			failed = 0,
			total = 0;
		for (const row of rows) {
			total += row.count;
			if (row.status === 'delivered') delivered += row.count;
			else if (isFail(row.status)) failed += row.count;
		}
		const rate = total ? Math.round((delivered / total) * 100) : null;
		return { delivered, failed, total, rate };
	});
	// Per-day pivot: date → { delivered, failed, other }.
	const byDay = $derived.by(() => {
		const m = new Map<string, { delivered: number; failed: number; other: number }>();
		for (const row of analytics ?? []) {
			const d = m.get(row.date) ?? { delivered: 0, failed: 0, other: 0 };
			if (row.status === 'delivered') d.delivered += row.count;
			else if (isFail(row.status)) d.failed += row.count;
			else d.other += row.count;
			m.set(row.date, d);
		}
		return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, counts]) => ({ date, ...counts }));
	});
	// Oldest→newest for the chart (the table wants newest first).
	const chartData = $derived([...byDay].reverse());

	const fmtTime = (dateStr: string | null) => {
		if (!dateStr) return '—';
		const t = new Date(dateStr);
		return isNaN(+t) ? dateStr : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	};
	const statusVariant = (status: string | null): 'success' | 'destructive' | 'outline' =>
		!status ? 'outline' : status === 'delivered' ? 'success' : isFail(status) ? 'destructive' : 'outline';

	// ---- Email-log table -----------------------------------------------------
	const logColumns: ColumnDef<Logs[number], unknown>[] = [
		{ accessorKey: 'datetime', header: 'When', cell: ({ row }) => renderSnippet(whenCell, { when: row.original.datetime }) },
		{ accessorKey: 'to', header: 'Recipient', cell: ({ row }) => renderSnippet(toCell, { to: row.original.to }) },
		{ accessorKey: 'status', header: 'Status', enableSorting: false, cell: ({ row }) => renderSnippet(logStatusCell, row.original) },
		{ id: 'auth', header: 'Auth', enableSorting: false, cell: ({ row }) => renderSnippet(authCell, row.original) }
	];

	// ---- Audit-log table -----------------------------------------------------
	const auditColumns: ColumnDef<Audit[number], unknown>[] = [
		{ accessorKey: 'when', header: 'When', cell: ({ row }) => renderSnippet(whenCell, { when: row.original.when }) },
		{ id: 'action', header: 'Action', enableSorting: false, cell: ({ row }) => renderSnippet(actionCell, row.original) },
		{ id: 'actor', header: 'Actor', enableSorting: false, cell: ({ row }) => renderSnippet(actorCell, row.original) },
		{ id: 'resource', header: 'Resource', enableSorting: false, cell: ({ row }) => renderSnippet(resourceCell, row.original) }
	];
</script>

{#snippet whenCell({ when }: { when: string | null })}
	<span class="text-muted-foreground text-sm whitespace-nowrap">{fmtTime(when)}</span>
{/snippet}

{#snippet toCell({ to }: { to: string | null })}
	<span class="font-mono text-sm">{to ?? '—'}</span>
{/snippet}

{#snippet logStatusCell(logEvent: Logs[number])}
	<div class="flex flex-col gap-0.5">
		<Badge variant={statusVariant(logEvent.status)} class="w-fit text-[10px]">{logEvent.status ?? 'unknown'}</Badge>
		{#if logEvent.errorCause}<span class="text-muted-foreground text-xs">{logEvent.errorCause}</span>{/if}
	</div>
{/snippet}

{#snippet authFlag(label: string, value: string | null)}
	{#if value}
		<span class="text-[10px] {value === 'pass' ? 'text-ok' : 'text-muted-foreground'}">
			{label}:{value}
		</span>
	{/if}
{/snippet}

{#snippet authCell(logEvent: Logs[number])}
	<div class="flex flex-wrap gap-x-2">
		{@render authFlag('spf', logEvent.spf)}
		{@render authFlag('dkim', logEvent.dkim)}
		{@render authFlag('dmarc', logEvent.dmarc)}
	</div>
{/snippet}

{#snippet actionCell(auditEntry: Audit[number])}
	<div class="flex items-center gap-2">
		<Badge variant={auditEntry.ok ? 'secondary' : 'destructive'} class="text-[10px]">{auditEntry.action ?? 'action'}</Badge>
	</div>
{/snippet}

{#snippet actorCell(auditEntry: Audit[number])}
	<span class="text-sm">{auditEntry.actor ?? '—'}</span>
{/snippet}

{#snippet resourceCell(auditEntry: Audit[number])}
	<span class="text-muted-foreground font-mono text-xs">{auditEntry.resource ?? '—'}</span>
{/snippet}

{#snippet loadingRow()}
	<div class="text-muted-foreground flex items-center gap-2 py-10 text-sm">
		<Spinner /> Loading live from Cloudflare…
	</div>
{/snippet}

<div class="flex flex-col gap-4">
	<PageHeader title="Insights" description="Live email analytics, delivery logs, and audit history for {org.domain}, read directly from Cloudflare.">
		{#snippet action()}
			<Button variant="outline" class="gap-1.5" onclick={() => load(view, true)} disabled={loading[view]}>
				{#if loading[view]}<Spinner class="size-4" />{:else}<RefreshCwIcon class="size-4" />{/if}
				Refresh
			</Button>
		{/snippet}
	</PageHeader>

	<div class="flex flex-wrap items-center justify-between gap-3">
		<ToggleGroup.Root
			type="single"
			variant="outline"
			size="sm"
			value={view}
			onValueChange={(value) => value && (view = value as View)}
			class="justify-start"
		>
			{#each segments as segment (segment.key)}
				<ToggleGroup.Item value={segment.key}>{segment.label}</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		<ToggleGroup.Root
			type="single"
			variant="outline"
			size="sm"
			value={String(days)}
			onValueChange={(value) => value && setDays(Number(value) as Days)}
			class="justify-start"
		>
			{#each ranges as range (range.key)}
				<ToggleGroup.Item value={String(range.key)} class="tabular-nums">{range.label}</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</div>

	{#if view === 'analytics'}
		{#if loading.analytics && !analytics}
			{@render loadingRow()}
		{:else if !org.zoneId}
			<p class="text-muted-foreground py-10 text-sm">This organization has no Cloudflare zone yet.</p>
		{:else}
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<div class="rounded-lg border border-l-2 border-l-brand p-4">
					<div class="text-muted-foreground text-xs">Sent ({days}d)</div>
					<div class="mt-1 text-2xl font-semibold tabular-nums">{totals.total.toLocaleString()}</div>
				</div>
				<div class="rounded-lg border border-l-2 border-l-ok p-4">
					<div class="text-muted-foreground text-xs">Delivered</div>
					<div class="text-ok mt-1 text-2xl font-semibold tabular-nums">
						{totals.delivered.toLocaleString()}
					</div>
				</div>
				<div class="rounded-lg border border-l-2 border-l-destructive p-4">
					<div class="text-muted-foreground text-xs">Failed</div>
					<div class="mt-1 text-2xl font-semibold tabular-nums text-destructive">
						{totals.failed.toLocaleString()}
					</div>
				</div>
				<div class="rounded-lg border border-l-2 border-l-p2 p-4">
					<div class="text-muted-foreground text-xs">Delivery rate</div>
					<div class="mt-1 text-2xl font-semibold tabular-nums">{totals.rate === null ? '—' : `${totals.rate}%`}</div>
				</div>
			</div>

			{#if chartData.length}
				<div class="rounded-lg border p-4">
					<div class="text-muted-foreground mb-2 text-xs">Delivered vs failed, per day</div>
					<DeliveryChart data={chartData} {days} />
				</div>
			{/if}

			{#if byDay.length}
				<div class="overflow-x-auto overflow-y-hidden rounded-lg border">
					<table class="w-full min-w-[32rem] text-sm">
						<thead class="bg-muted/50 text-muted-foreground text-xs">
							<tr>
								<th class="px-4 py-2 text-left font-medium">Day</th>
								<th class="px-4 py-2 text-right font-medium">Delivered</th>
								<th class="px-4 py-2 text-right font-medium">Failed</th>
								<th class="px-4 py-2 text-right font-medium">Other</th>
							</tr>
						</thead>
						<tbody>
							{#each byDay as day (day.date)}
								<tr class="border-t">
									<td class="px-4 py-2">{day.date}</td>
									<td class="px-4 py-2 text-right tabular-nums">{day.delivered.toLocaleString()}</td>
									<td class="px-4 py-2 text-right tabular-nums">{day.failed.toLocaleString()}</td>
									<td class="text-muted-foreground px-4 py-2 text-right tabular-nums">{day.other.toLocaleString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="text-muted-foreground py-10 text-sm">
					No sending activity in the selected range. (Analytics needs the Cloudflare token to carry
					<span class="font-mono">Analytics Read</span>.)
				</p>
			{/if}
		{/if}
	{:else if view === 'logs'}
		{#if loading.logs && !logs}
			{@render loadingRow()}
		{:else}
			<DataTable
				columns={logColumns}
				data={logs ?? []}
				filterColumn="to"
				filterPlaceholder="Search recipients…"
				empty="No email events in the selected range."
			/>
		{/if}
	{:else if loading.audit && !audit}
		{@render loadingRow()}
	{:else}
		<DataTable
			columns={auditColumns}
			data={audit ?? []}
			empty="No audit-log entries for this zone."
		/>
	{/if}
</div>
