<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { BarChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart/index.js';
	import type { ChartConfig } from '$lib/components/ui/chart/index.js';

	// Stacked delivered/failed-per-day bars. Data is expected oldest→newest.
	type Row = { date: string; delivered: number; failed: number };
	let {
		data,
		days,
		class: className = 'aspect-[3/1] w-full'
	}: {
		data: Row[];
		/** Zero-fill to a full trailing window of this many days (UTC, matching
		 * the analytics date keys) — sparse data otherwise stretches one or two
		 * bars across the whole width. */
		days?: number;
		class?: string;
	} = $props();

	const filled = $derived.by(() => {
		if (!days) return data;
		const by = new Map(data.map((r) => [r.date, r]));
		const out: Row[] = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(Date.now() - i * 86_400_000);
			const key = d.toISOString().slice(0, 10);
			out.push(by.get(key) ?? { date: key, delivered: 0, failed: 0 });
		}
		return out;
	});

	const config = {
		delivered: { label: 'Delivered', color: 'var(--chart-5)' },
		failed: { label: 'Failed', color: 'var(--chart-4)' }
	} satisfies ChartConfig;
</script>

<Chart.Container {config} class={className}>
	<BarChart
		data={filled}
		x="date"
		seriesLayout="stack"
		series={[
			{ key: 'delivered', label: 'Delivered', value: (d: Row) => d.delivered, color: 'var(--color-delivered)' },
			{ key: 'failed', label: 'Failed', value: (d: Row) => d.failed, color: 'var(--color-failed)' }
		]}
		props={{ xAxis: { format: (d: string) => d.slice(5) } }}
	>
		{#snippet tooltip()}
			<Chart.Tooltip />
		{/snippet}
	</BarChart>
</Chart.Container>
