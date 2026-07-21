<script lang="ts">
	import type { ColumnDef } from '@tanstack/table-core';
	import { DataTable, renderSnippet } from '$lib/components/ui/data-table/index.js';
	import EyeIcon from '@lucide/svelte/icons/eye';

	let { data } = $props();

	type Row = (typeof data.rows)[number];

	function fmt(ms: number | null): string {
		if (!ms) return '';
		return new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	const columns: ColumnDef<Row, unknown>[] = [
		{ accessorKey: 'domain', header: 'Domain', cell: ({ row }) => renderSnippet(domainCell, row.original) },
		{ accessorKey: 'from', header: 'From', cell: ({ row }) => renderSnippet(fromCell, row.original) },
		{ accessorKey: 'subject', header: 'Subject', cell: ({ row }) => renderSnippet(subjectCell, row.original) },
		{ accessorKey: 'at', header: 'When', cell: ({ row }) => renderSnippet(whenCell, row.original) }
	];
</script>

{#snippet domainCell(r: Row)}
	<span class="font-mono text-sm">{r.domain}</span>
{/snippet}

{#snippet fromCell(r: Row)}
	<span class="text-muted-foreground font-mono text-xs">{r.from ?? '—'}</span>
{/snippet}

{#snippet subjectCell(r: Row)}
	<span class="block max-w-xs truncate">{r.subject || '(no subject)'}</span>
{/snippet}

{#snippet whenCell(r: Row)}
	<span class="text-muted-foreground text-sm">{fmt(r.at)}</span>
{/snippet}

<div class="flex w-full flex-col gap-6 p-6 md:p-8">
	<div class="flex flex-col gap-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Oversight</h1>
		<p class="text-muted-foreground flex items-center gap-1.5 text-sm">
			<EyeIcon class="size-3.5" /> Read-only mail across all organizations.
		</p>
	</div>

	<DataTable
		{columns}
		data={data.rows}
		filterColumn="subject"
		filterPlaceholder="Search by subject…"
		empty="No mail yet across any organization."
	/>
</div>
