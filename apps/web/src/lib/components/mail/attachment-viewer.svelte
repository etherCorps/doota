<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Hallmark · component: sandboxed attachment viewer · genre: inherited (app system)
     states: idle · loading (iframe boot) · fetching bytes · rendered · error
     In-house preview for attacker-controlled documents. The document renders in
     an OPAQUE-origin iframe (sandbox="allow-scripts", NO allow-same-origin) served
     by /api/attachment-view. THIS parent fetches the already-scanned bytes
     (session cookie, same-origin) and hands them to the sandbox over postMessage;
     the sandbox never fetches. Only ever opened by the gate AFTER a scan verdict. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Drawer from '$lib/components/ui/drawer/index.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { IsMobile } from '$lib/utils/hooks/is-mobile.svelte.js';
	import { ATTACHMENT_VIEWER_SANDBOX } from '$lib/client/attachment-viewer-sandbox';
	import { viewer, openAttachment } from '$lib/client/attachment-gate.svelte';

	const isMobile = new IsMobile();
	let frame = $state<HTMLIFrameElement>();
	let contentH = $state(0);
	let failed = $state(false);
	// Clamp an untrusted height so a hostile scrollHeight can't blow up the layout.
	const MAX_H = 20000;
	const height = $derived(contentH > 0 ? Math.min(MAX_H, contentH) : 420);

	function close() {
		viewer.open = false;
	}

	// Re-download through the SAME gate — a verdict already exists (cached), so
	// this resolves instantly to the download branch (contentType omitted → the
	// gate treats it as a plain download, not a re-open of this viewer).
	function download() {
		void openAttachment({ id: viewer.id, filename: viewer.filename }, () => {
			const anchor = document.createElement('a');
			anchor.href = `/api/attachments/${viewer.id}`;
			anchor.download = viewer.filename;
			anchor.rel = 'noopener';
			anchor.click();
		});
	}

	// Fresh open → reset measured height / error, then wire the message bridge.
	// The sandbox posts {viewer-ready}; we fetch the bytes and post {render}. Its
	// origin is opaque ('null'), so we validate by SOURCE window, not origin.
	$effect(() => {
		if (!viewer.open) return;
		contentH = 0;
		failed = false;
		const id = viewer.id;

		async function handOffBytes() {
			try {
				const res = await fetch(`/api/attachments/${id}`);
				if (!res.ok) throw new Error(`attachment ${res.status}`);
				const bytes = await res.arrayBuffer();
				const win = frame?.contentWindow;
				if (!win) return;
				// targetOrigin '*' is required — the sandbox origin is opaque/null, so
				// there is no concrete origin to target. The sandbox guards the reverse
				// direction by checking event.source === window.parent.
				win.postMessage({ type: 'render', bytes, mime: viewer.contentType, name: viewer.filename }, '*', [
					bytes
				]);
			} catch {
				failed = true;
			}
		}

		function onMessage(event: MessageEvent) {
			if (!frame || event.source !== frame.contentWindow) return;
			const data = event.data as { __attview?: number; type?: string; value?: unknown };
			if (!data || data.__attview !== 1) return;
			if (data.type === 'viewer-ready') {
				void handOffBytes();
			} else if (data.type === 'height' && typeof data.value === 'number' && Number.isFinite(data.value)) {
				contentH = Math.max(0, Math.ceil(data.value));
			}
		}
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});
</script>

{#snippet body()}
	<div class="space-y-2">
		<!-- Honest affordance: this document runs isolated, we never claim it's safe. -->
		<p class="text-muted-foreground flex items-center gap-1.5 text-[11px]">
			<ShieldCheckIcon class="size-3.5 shrink-0" />
			<span>Sandboxed preview — this document runs in an isolated frame.</span>
		</p>
		{#if failed}
			<div class="text-muted-foreground grid place-items-center rounded-lg border p-8 text-center text-sm">
				This document couldn't be loaded. Download it to open.
			</div>
		{:else}
			<iframe
				bind:this={frame}
				title="Attachment preview"
				src="/api/attachment-view"
				sandbox={ATTACHMENT_VIEWER_SANDBOX}
				scrolling="no"
				style:height={`${height}px`}
				class="bg-card w-full rounded-lg border-0 transition-[height] duration-200 ease-out motion-reduce:transition-none"
			></iframe>
		{/if}
	</div>
{/snippet}

{#snippet downloadBtn(cls: string)}
	<button
		type="button"
		onclick={download}
		class="focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 {cls}"
	>
		<DownloadIcon class="size-3.5" /> Download
	</button>
{/snippet}

{#if viewer.open}
	{#if isMobile.current}
		<Drawer.Root open={true} onOpenChange={(open) => { if (!open) close(); }}>
			<Drawer.Content>
				<Drawer.Header class="flex-row items-center justify-between gap-3 pb-2 text-left">
					<Drawer.Title class="min-w-0 truncate text-sm">{viewer.filename}</Drawer.Title>
					{@render downloadBtn('bg-muted hover:bg-accent')}
				</Drawer.Header>
				<div class="max-h-[80vh] overflow-y-auto px-4 pb-4">
					{@render body()}
				</div>
			</Drawer.Content>
		</Drawer.Root>
	{:else}
		<Dialog.Root open={true} onOpenChange={(open) => { if (!open) close(); }}>
			<Dialog.Content class="max-h-[88vh] w-[min(94vw,60rem)] max-w-none overflow-y-auto">
				<Dialog.Header class="flex-row items-center justify-between gap-3 pr-8">
					<Dialog.Title class="min-w-0 truncate text-sm">{viewer.filename}</Dialog.Title>
					{@render downloadBtn('bg-muted hover:bg-accent')}
				</Dialog.Header>
				{@render body()}
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
