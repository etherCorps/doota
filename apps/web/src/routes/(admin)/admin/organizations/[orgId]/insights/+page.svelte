<script lang="ts">
	import type { ColumnDef } from '@tanstack/table-core';
	import { toast } from 'svelte-sonner';
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import DeliveryChart from '$lib/components/admin/delivery-chart.svelte';
	import { zoneAnalytics, zoneEmailLogs, zoneAudit, sendingReputation } from '$lib/rpc/cf-insights.remote';
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
	async function load(v: View, force = false) {
		if (loading[v] || (!force && loaded[v])) return;
		loading = { ...loading, [v]: true };
		try {
			if (v === 'analytics') analytics = await zoneAnalytics({ orgId: org.id, days });
			else if (v === 'logs') logs = await zoneEmailLogs({ orgId: org.id, days });
			else audit = await zoneAudit({ orgId: org.id, days });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not load from Cloudflare.');
		} finally {
			loaded = { ...loaded, [v]: true };
			loading = { ...loading, [v]: false };
		}
	}

	// Refetch the active view whenever the view OR the range changes. Reading
	// `days` here registers it as a dependency; setDays() clears the flags.
	$effect(() => {
		days;
		load(view);
	});

	// Domain reputation (fixed 24h/7d windows, independent of the range picker).
	// One-shot, best-effort — the analytics view stands without it.
	let reputation = $state<Awaited<ReturnType<typeof sendingReputation>>>(null);
	let repLoaded = $state(false);
	$effect(() => {
		if (view !== 'analytics' || repLoaded) return;
		repLoaded = true;
		sendingReputation(org.id)
			.then((r) => (reputation = r))
			.catch(() => {});
	});
	const repTone = (rate: number | null) =>
		rate === null ? 'text-muted-foreground' : rate >= 95 ? 'text-ok' : rate >= 80 ? 'text-warn' : 'text-destructive';

	function setDays(d: Days) {
		if (d === days) return;
		analytics = logs = audit = null; // stale for the old range — drop and refetch
		loaded = { analytics: false, logs: false, audit: false };
		days = d;
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
	const isFail = (s: string) => /fail|bounce|drop|reject/i.test(s);
	const totals = $derived.by(() => {
		const rows = analytics ?? [];
		let delivered = 0,
			failed = 0,
			total = 0;
		for (const r of rows) {
			total += r.count;
			if (r.status === 'delivered') delivered += r.count;
			else if (isFail(r.status)) failed += r.count;
		}
		const rate = total ? Math.round((delivered / total) * 100) : null;
		return { delivered, failed, total, rate };
	});
	// Per-day pivot: date → { delivered, failed, other }.
	const byDay = $derived.by(() => {
		const m = new Map<string, { delivered: number; failed: number; other: number }>();
		for (const r of analytics ?? []) {
			const d = m.get(r.date) ?? { delivered: 0, failed: 0, other: 0 };
			if (r.status === 'delivered') d.delivered += r.count;
			else if (isFail(r.status)) d.failed += r.count;
			else d.other += r.count;
			m.set(r.date, d);
		}
		return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, v]) => ({ date, ...v }));
	});
	// Oldest→newest for the chart (the table wants newest first).
	const chartData = $derived([...byDay].reverse());

	const fmtTime = (d: string | null) => {
		if (!d) return '—';
		const t = new Date(d);
		return isNaN(+t) ? d : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	};
	const statusVariant = (s: string | null): 'success' | 'destructive' | 'outline' =>
		!s ? 'outline' : s === 'delivered' ? 'success' : isFail(s) ? 'destructive' : 'outline';

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

{#snippet logStatusCell(e: Logs[number])}
	<div class="flex flex-col gap-0.5">
		<Badge variant={statusVariant(e.status)} class="w-fit text-[10px]">{e.status ?? 'unknown'}</Badge>
		{#if e.errorCause}<span class="text-muted-foreground text-xs">{e.errorCause}</span>{/if}
	</div>
{/snippet}

{#snippet authFlag(label: string, v: string | null)}
	{#if v}
		<span class="text-[10px] {v === 'pass' ? 'text-ok' : 'text-muted-foreground'}">
			{label}:{v}
		</span>
	{/if}
{/snippet}

{#snippet authCell(e: Logs[number])}
	<div class="flex flex-wrap gap-x-2">
		{@render authFlag('spf', e.spf)}
		{@render authFlag('dkim', e.dkim)}
		{@render authFlag('dmarc', e.dmarc)}
	</div>
{/snippet}

{#snippet actionCell(a: Audit[number])}
	<div class="flex items-center gap-2">
		<Badge variant={a.ok ? 'secondary' : 'destructive'} class="text-[10px]">{a.action ?? 'action'}</Badge>
	</div>
{/snippet}

{#snippet actorCell(a: Audit[number])}
	<span class="text-sm">{a.actor ?? '—'}</span>
{/snippet}

{#snippet resourceCell(a: Audit[number])}
	<span class="text-muted-foreground font-mono text-xs">{a.resource ?? '—'}</span>
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
			onValueChange={(v) => v && (view = v as View)}
			class="justify-start"
		>
			{#each segments as s (s.key)}
				<ToggleGroup.Item value={s.key}>{s.label}</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		<ToggleGroup.Root
			type="single"
			variant="outline"
			size="sm"
			value={String(days)}
			onValueChange={(v) => v && setDays(Number(v) as Days)}
			class="justify-start"
		>
			{#each ranges as r (r.key)}
				<ToggleGroup.Item value={String(r.key)} class="tabular-nums">{r.label}</ToggleGroup.Item>
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

			{#if reputation}
				<!-- Sending reputation — the Cloudflare dashboard's widget numbers:
				     last event per message, no NDRs, delivered vs failed vs spam. -->
				<div class="rounded-lg border p-4">
					<div class="text-muted-foreground mb-3 text-xs">Sending reputation · {org.domain}</div>
					<div class="grid grid-cols-2 gap-3">
						{#each [{ label: 'Last 24 hours', rep: reputation.h24 }, { label: 'Last 7 days', rep: reputation.d7 }] as w (w.label)}
							<div>
								<div class="text-muted-foreground text-xs">{w.label}</div>
								<div class="mt-1 text-2xl font-semibold tabular-nums {repTone(w.rep.rate)}">
									{w.rep.rate === null ? '—' : `${w.rep.rate}%`}
								</div>
								<div class="text-faint mt-0.5 text-[11px] tabular-nums">
									{#if w.rep.total === 0}
										No sends in this window
									{:else}
										{w.rep.delivered.toLocaleString()} delivered · {w.rep.failed.toLocaleString()} failed · {w.rep.spam.toLocaleString()} spam-rejected
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if chartData.length}
				<div class="rounded-lg border p-4">
					<div class="text-muted-foreground mb-2 text-xs">Delivered vs failed, per day</div>
					<DeliveryChart data={chartData} {days} />
				</div>
			{/if}

			{#if byDay.length}
				<div class="overflow-hidden rounded-lg border">
					<table class="w-full text-sm">
						<thead class="bg-muted/50 text-muted-foreground text-xs">
							<tr>
								<th class="px-4 py-2 text-left font-medium">Day</th>
								<th class="px-4 py-2 text-right font-medium">Delivered</th>
								<th class="px-4 py-2 text-right font-medium">Failed</th>
								<th class="px-4 py-2 text-right font-medium">Other</th>
							</tr>
						</thead>
						<tbody>
							{#each byDay as d (d.date)}
								<tr class="border-t">
									<td class="px-4 py-2">{d.date}</td>
									<td class="px-4 py-2 text-right tabular-nums">{d.delivered.toLocaleString()}</td>
									<td class="px-4 py-2 text-right tabular-nums">{d.failed.toLocaleString()}</td>
									<td class="text-muted-foreground px-4 py-2 text-right tabular-nums">{d.other.toLocaleString()}</td>
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
