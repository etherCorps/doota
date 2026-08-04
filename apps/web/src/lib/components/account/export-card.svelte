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
	import { myMailboxes } from '$lib/rpc/mailbox.remote';
	import { startExport, exportStatus, exportDownloadUrl } from '$lib/rpc/export.remote';

	const mailboxes = myMailboxes();

	let busy = $state<string | null>(null);

	// Poll every 5s while any mailbox has a running export. Reading the queries'
	// .current here subscribes the effect, so it re-evaluates when a poll lands
	// and stops itself once nothing is running.
	$effect(() => {
		const runningIds = (mailboxes.current ?? [])
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
			toast.error(err instanceof Error ? err.message : 'Could not start the export.');
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
			toast.error(err instanceof Error ? err.message : 'Could not get the download link.');
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

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<DownloadIcon class="size-4" /> Export mailbox
		</Card.CardTitle>
		<Card.CardDescription>
			Download a full copy of a mailbox as a standard .mbox file you can open in most mail apps.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent class="flex flex-col gap-5">
		{#if mailboxes.current === undefined}
			<div class="flex flex-col gap-2">
				<Skeleton class="h-8 w-full rounded-md" />
				<Skeleton class="h-8 w-full rounded-md" />
			</div>
		{:else if mailboxes.current.length === 0}
			<p class="text-muted-foreground text-sm">You don't have any mailboxes yet.</p>
		{:else}
			{#each mailboxes.current as box (box.id)}
				{@const statusQuery = exportStatus({ mailboxId: box.id })}
				<section
					class="flex flex-col gap-2 border-t pt-5 first:border-t-0 first:pt-0"
					aria-label="Export {box.address}"
				>
					<div class="flex items-center justify-between gap-2">
						<span class="min-w-0 truncate font-mono text-sm">{box.address}</span>
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
	</Card.CardContent>
</Card.Card>
