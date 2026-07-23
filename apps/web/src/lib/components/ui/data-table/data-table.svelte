<script lang="ts" generics="TData">
	import {
		type ColumnDef,
		type ColumnFiltersState,
		type PaginationState,
		type SortingState,
		type Updater,
		getCoreRowModel,
		getFilteredRowModel,
		getPaginationRowModel,
		getSortedRowModel
	} from '@tanstack/table-core';
	import { untrack, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { createSvelteTable } from './data-table.svelte.js';
	import FlexRender from './flex-render.svelte';
	import * as Table from '$lib/components/ui/table/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';

	type Props = {
		columns: ColumnDef<TData, unknown>[];
		data: TData[];
		/** Column id to wire the search box to. Omit to hide the search box. */
		filterColumn?: string;
		filterPlaceholder?: string;
		pageSize?: number;
		empty?: string;
		/** Rendered on the search row, right-aligned (e.g. an "Add" button). */
		actions?: Snippet;
		/** When set, the whole row is clickable and navigates here. A real link
		 *  inside a cell (e.g. the name) stays the keyboard/screen-reader target. */
		rowHref?: (row: TData) => string;
	};
	let {
		columns,
		data,
		filterColumn,
		filterPlaceholder = 'Search…',
		pageSize = 10,
		empty = 'No results.',
		actions,
		rowHref
	}: Props = $props();

	let sorting = $state<SortingState>([]);
	let columnFilters = $state<ColumnFiltersState>([]);
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: untrack(() => pageSize) });

	const set = <T,>(cur: T, u: Updater<T>): T => (typeof u === 'function' ? (u as (p: T) => T)(cur) : u);

	const table = createSvelteTable<TData>({
		get data() {
			return data;
		},
		get columns() {
			return columns;
		},
		state: {
			get sorting() {
				return sorting;
			},
			get columnFilters() {
				return columnFilters;
			},
			get pagination() {
				return pagination;
			}
		},
		onSortingChange: (u) => (sorting = set(sorting, u)),
		onColumnFiltersChange: (u) => (columnFilters = set(columnFilters, u)),
		onPaginationChange: (u) => (pagination = set(pagination, u)),
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel()
	});

	const searchCol = $derived(filterColumn ? table.getColumn(filterColumn) : undefined);
	const colCount = $derived(columns.length);
</script>

<div class="flex flex-col gap-3">
	{#if searchCol || actions}
		<!-- flex-wrap: search + actions stack instead of squeezing at phone widths. -->
		<div class="flex flex-wrap items-center justify-between gap-2">
			{#if searchCol}
				<Input
					class="w-56 max-w-full"
					placeholder={filterPlaceholder}
					value={(searchCol.getFilterValue() as string) ?? ''}
					oninput={(e) => searchCol.setFilterValue(e.currentTarget.value)}
				/>
			{:else}
				<div></div>
			{/if}
			{@render actions?.()}
		</div>
	{/if}

	<div class="rounded-lg border">
		<Table.Root>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
					<Table.Row>
						{#each headerGroup.headers as header (header.id)}
							<Table.Head>
								{#if !header.isPlaceholder}
									{#if header.column.getCanSort()}
										<button
											type="button"
											class="hover:text-foreground -mx-1 flex items-center gap-1 rounded px-1"
											onclick={header.column.getToggleSortingHandler()}
										>
											<FlexRender content={header.column.columnDef.header} context={header.getContext()} />
											{#if header.column.getIsSorted() === 'asc'}
												<ChevronUpIcon class="size-3.5" />
											{:else if header.column.getIsSorted() === 'desc'}
												<ChevronDownIcon class="size-3.5" />
											{:else}
												<ChevronsUpDownIcon class="text-muted-foreground size-3.5" />
											{/if}
										</button>
									{:else}
										<FlexRender content={header.column.columnDef.header} context={header.getContext()} />
									{/if}
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#each table.getRowModel().rows as row (row.id)}
					<Table.Row
						class={rowHref ? 'cursor-pointer' : undefined}
						onclick={rowHref
							? (e) => {
									if ((e.target as HTMLElement).closest('a,button,input,[role="button"]')) return;
									goto(rowHref(row.original));
								}
							: undefined}
					>
						{#each row.getVisibleCells() as cell (cell.id)}
							<Table.Cell>
								<FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
							</Table.Cell>
						{/each}
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={colCount} class="text-muted-foreground py-8 text-center text-sm">
							{empty}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>

	{#if table.getPageCount() > 1}
		<div class="flex items-center justify-between gap-2">
			<span class="text-muted-foreground text-xs">
				{table.getFilteredRowModel().rows.length} row{table.getFilteredRowModel().rows.length === 1 ? '' : 's'}
			</span>
			<div class="flex items-center gap-2">
				<span class="text-muted-foreground text-xs">
					Page {pagination.pageIndex + 1} of {table.getPageCount()}
				</span>
				<Button variant="outline" size="sm" disabled={!table.getCanPreviousPage()} onclick={() => table.previousPage()}>
					Previous
				</Button>
				<Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onclick={() => table.nextPage()}>
					Next
				</Button>
			</div>
		</div>
	{/if}
</div>
