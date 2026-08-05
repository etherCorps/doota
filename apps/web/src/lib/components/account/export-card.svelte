<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// Account → Mail: mailbox export (.mbox). The warning lives in a confirm
	// dialog BEFORE anything starts — the export decrypts everything and the
	// download link is a 15-minute capability URL. A 403 from startExport means
	// the session is older than 30 min; the server message says to re-login and
	// is surfaced verbatim. Recent exports poll every 5s while one is running.
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { toast } from 'svelte-sonner';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import SettingsCollapsibleCard from '$lib/components/account/settings-collapsible-card.svelte';
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import { startExport, exportStatus, exportDownloadUrl } from '$lib/rpc/export.remote';
	import { errorMessage } from '$lib/utils/error-message';

	// Page-level mailbox scope (see signatures-card): only that mailbox's export
	// section renders and the address heading drops.
	let { mailboxId = null }: { mailboxId?: string | null } = $props();

	const mailboxes = myMailboxes();
	const visible = $derived(
		mailboxes.current === undefined
			? undefined
			: mailboxId
				? mailboxes.current.filter((box) => box.id === mailboxId)
				: mailboxes.current
	);
	// Header summary reads the same per-mailbox query the list uses (cached by
	// args; rows are createdAt-desc, so [0] is the latest export).
	const summaryQuery = $derived(mailboxId ? exportStatus({ mailboxId }) : undefined);

	let busy = $state<string | null>(null);

	// Poll every 5s while any visible mailbox has a running export. Reading the
	// queries' .current here subscribes the effect, so it re-evaluates when a
	// poll lands and stops itself once nothing is running.
	$effect(() => {
		const runningIds = (visible ?? [])
			.map((box) => box.id)
			.filter((mailboxId) =>
				exportStatus({ mailboxId }).current?.some((row) => row.status === 'running')
			);
		if (!runningIds.length) return;
		const timer = setInterval(() => {
			for (const mailboxId of runningIds) exportStatus({ mailboxId }).refresh();
		}, 5000);
		return () => clearInterval(timer);
	});

	async function start(mailboxId: string) {
		busy = mailboxId;
		try {
			await startExport({ mailboxId });
			await exportStatus({ mailboxId }).refresh();
			toast.success('Export started. It will appear below when it finishes.');
		} catch (err) {
			// A 403 carries "Re-authentication required: sign in again…" — show it as-is.
			toast.error(errorMessage(err, 'Could not start the export.'));
		} finally {
			busy = null;
		}
	}

	async function download(mailboxId: string, exportId: string) {
		busy = exportId;
		try {
			const { url } = await exportDownloadUrl({ mailboxId, exportId });
			const anchor = document.createElement('a');
			anchor.href = url;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		} catch (err) {
			toast.error(errorMessage(err, 'Could not get the download link.'));
		} finally {
			busy = null;
		}
	}

	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});

	const STATUS_LABEL: Record<string, string> = {
		running: 'Running…',
		done: 'Done',
		failed: 'Failed'
	};
	const STATUS_VARIANT: Record<string, 'info' | 'success' | 'destructive'> = {
		running: 'info',
		done: 'success',
		failed: 'destructive'
	};
</script>

<SettingsCollapsibleCard>
	{#snippet title()}
		<DownloadIcon class="size-4" /> Export mailbox
	{/snippet}
	{#snippet summary()}
		{#if summaryQuery?.current === undefined}
			<Skeleton class="h-4 w-24 rounded-md" />
		{:else if summaryQuery.current.length === 0}
			Never exported
		{:else}
			{@const latest = summaryQuery.current[0]}
			Last export {when(latest.completedAt ?? latest.createdAt)} · {STATUS_LABEL[latest.status] ??
				latest.status}
		{/if}
	{/snippet}
	<Card.CardDescription>
		Download a full copy of a mailbox as a standard .mbox file you can open in most mail apps.
	</Card.CardDescription>
	<div class="flex flex-col gap-5">
		{#if visible === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-8 w-full rounded-md" />
				<Skeleton class="h-8 w-full rounded-md" />
			</div>
		{:else if visible.length === 0}
			<p class="text-muted-foreground text-sm">You don't have any mailboxes yet.</p>
		{:else}
			{#each visible as box (box.id)}
				{@const statusQuery = exportStatus({ mailboxId: box.id })}
				<section
					class="flex flex-col gap-2 border-t pt-5 first:border-t-0 first:pt-0"
					aria-label="Export {box.address}"
				>
					<div class="flex items-center justify-between gap-2">
						{#if !mailboxId}
							<span class="min-w-0 truncate font-mono text-sm">{box.address}</span>
						{/if}
						<AlertDialog.Root>
							<AlertDialog.Trigger>
								{#snippet child({ props })}
									<Button {...props} size="sm" variant="outline" class="shrink-0" disabled={busy === box.id}>
										{#if busy === box.id}
											<Spinner class="mr-1 size-3.5" /> Starting…
										{:else}
											Export mailbox (.mbox)
										{/if}
									</Button>
								{/snippet}
							</AlertDialog.Trigger>
							<AlertDialog.Content>
								<AlertDialog.Header>
									<AlertDialog.Title>Export {box.address}?</AlertDialog.Title>
									<AlertDialog.Description>
										The export file contains your decrypted mail. Anyone with the download link can
										read it while the link is valid (15 minutes).
									</AlertDialog.Description>
								</AlertDialog.Header>
								<AlertDialog.Footer>
									<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
									<AlertDialog.Action onclick={() => start(box.id)}>Start export</AlertDialog.Action>
								</AlertDialog.Footer>
							</AlertDialog.Content>
						</AlertDialog.Root>
					</div>
					{#if statusQuery.current === undefined}
						<Skeleton class="h-8 w-full rounded-md" />
					{:else if statusQuery.current.length}
						<ul class="flex flex-col divide-y rounded-md border">
							{#each statusQuery.current as row (row.id)}
								<li class="flex items-center gap-2 px-3 py-1.5 text-xs">
									<Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>
										{#if row.status === 'running'}
											<Spinner class="size-3" />
										{/if}
										{STATUS_LABEL[row.status] ?? row.status}
									</Badge>
									<span class="text-muted-foreground min-w-0 flex-1 truncate">
										{row.status === 'done' ? `${row.messageCount} messages · ` : ''}{when(
											row.completedAt ?? row.createdAt
										)}
									</span>
									{#if row.status === 'done'}
										<Button
											size="sm"
											variant="ghost"
											class="h-7 shrink-0"
											disabled={busy === row.id}
											onclick={() => download(box.id, row.id)}
										>
											<DownloadIcon class="mr-1 size-3.5" /> Download
										</Button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		{/if}
	</div>
</SettingsCollapsibleCard>
