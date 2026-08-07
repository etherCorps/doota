<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Hallmark · component: sandboxed attachment viewer · genre: inherited (app system)
     states: idle · loading (spinner overlay until first height report; 8s boot
     watchdog → error) · rendered · error (failed box)
     Full-screen attachment preview (Gmail-pattern lightbox: one chrome bar,
     content fills the viewport — not a small nested dialog). Per-document shell:
     pdf/images/text render in the OPAQUE hard-isolated iframe (/api/attachment-view,
     sandbox="allow-scripts", NO allow-same-origin); rich-only formats (Office,
     archives, …) use the same-origin file-viewer shell (/viewer — weaker isolation,
     compensated by its CSP; see that route). THIS parent fetches the already-scanned
     bytes (session cookie) and hands them over postMessage; the frames never fetch
     mail. Only ever opened by the gate AFTER a scan verdict. -->
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { ATTACHMENT_VIEWER_SANDBOX, RICH_VIEWER_SANDBOX } from '$lib/client/attachment-viewer-sandbox';
	import { viewerFor } from '$lib/client/attachment-viewable';
	import {
		viewer,
		viewerContext,
		openAttachment,
		downloadAttachment
	} from '$lib/client/attachment-gate.svelte';

	// Shell choice is PER DOCUMENT: pdf/images/text/media keep the opaque
	// hard-isolated viewer; rich-only formats (Office/archives/markdown/…) use
	// the same-origin file-viewer shell — deliberately weaker isolation, see
	// /viewer's CSP notes. (Not gated on viewer.open: flipping the src during
	// the close animation would reload the frame mid-outro.)
	const rich = $derived(viewerFor(viewer.contentType, viewer.filename) === 'rich');
	const frameSrc = $derived(rich ? '/viewer' : '/api/attachment-view');
	const frameSandbox = $derived(rich ? RICH_VIEWER_SANDBOX : ATTACHMENT_VIEWER_SANDBOX);
	let frame = $state<HTMLIFrameElement>();
	let contentH = $state(0);
	let failed = $state(false);
	// True once ANY message arrives from the sandbox — a frame that never boots
	// (asset 404, blocked script) would otherwise sit as a blank box forever.
	let booted = $state(false);
	// Clamp an untrusted height so a hostile scrollHeight can't blow up the layout.
	const MAX_H = 20000;
	const height = $derived(contentH > 0 ? Math.min(MAX_H, contentH) : 420);
	// Loading = no content painted yet (first height report is the paint signal).
	const loading = $derived(!failed && contentH === 0);

	function close() {
		viewer.open = false;
	}

	// Prev/next across the open thread's viewable attachments (Gmail-pattern).
	// Navigation goes through the GATE — an unscanned neighbor scans first, a
	// non-clean one gets its confirm; nothing renders without a verdict.
	const navItems = $derived(viewerContext.items);
	const navIndex = $derived(navItems.findIndex((item) => item.id === viewer.id));
	const prevItem = $derived(navIndex > 0 ? navItems[navIndex - 1] : null);
	const nextItem = $derived(
		navIndex >= 0 && navIndex < navItems.length - 1 ? navItems[navIndex + 1] : null
	);
	function goTo(item: { id: string; filename: string | null; contentType: string | null } | null) {
		if (!item) return;
		// Viewable by construction — the download fallback is unreachable.
		void openAttachment(item, () => {});
	}
	function onNavKeys(event: KeyboardEvent) {
		if (!viewer.open) return;
		if (event.key === 'ArrowLeft') goTo(prevItem);
		else if (event.key === 'ArrowRight') goTo(nextItem);
	}

	// Re-download through the SAME gate — a verdict already exists (cached), so
	// this resolves instantly. downloadAttachment, NOT openAttachment: the open
	// path view-routes by type and would just re-open this viewer.
	function download() {
		void downloadAttachment({ id: viewer.id, filename: viewer.filename }, () => {
			const anchor = document.createElement('a');
			anchor.href = `/api/attachments/${viewer.id}`;
			anchor.download = viewer.filename;
			anchor.rel = 'noopener';
			anchor.click();
		});
	}

	// Fresh open → reset measured height / error, then wire the message bridge.
	// The frame posts {viewer-ready}; we fetch the bytes and post {render}.
	$effect(() => {
		if (!viewer.open) return;
		contentH = 0;
		failed = false;
		booted = false;
		const id = viewer.id;

		// Boot watchdog: if the frame never posts viewer-ready (asset failed to
		// load), surface the error state instead of an infinite blank frame. Slow
		// RENDERS are exempt — any received message marks the frame booted.
		const bootTimer = setTimeout(() => {
			if (!booted) failed = true;
		}, 8000);
		// Closing mid-fetch must stop the transfer — a 20 MB attachment would
		// otherwise keep downloading after the lightbox is gone.
		const aborter = new AbortController();

		async function handOffBytes() {
			try {
				const res = await fetch(`/api/attachments/${id}`, { signal: aborter.signal });
				if (!res.ok) throw new Error(`attachment ${res.status}`);
				const bytes = await res.arrayBuffer();
				const win = frame?.contentWindow;
				if (!win) return;
				// Rich shell is same-origin — target it exactly; the opaque frame has
				// no concrete origin ('*') and both sides guard by source identity.
				// theme: the rich shell matches the app's light/dark mode.
				win.postMessage(
					{
						type: 'render',
						bytes,
						mime: viewer.contentType,
						name: viewer.filename,
						theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
					},
					rich ? location.origin : '*',
					[bytes]
				);
			} catch {
				failed = true;
			}
		}

		function onMessage(event: MessageEvent) {
			if (!frame || event.source !== frame.contentWindow) return;
			// Rich shell: additionally pin the sender's origin (the opaque frame
			// reports origin 'null', so source identity is its only guard).
			if (rich && event.origin !== location.origin) return;
			const data = event.data as { __attview?: number; type?: string; value?: unknown };
			if (!data || data.__attview !== 1) return;
			booted = true;
			if (data.type === 'viewer-ready') {
				void handOffBytes();
			} else if (data.type === 'height' && typeof data.value === 'number' && Number.isFinite(data.value)) {
				contentH = Math.max(0, Math.ceil(data.value));
			} else if (data.type === 'close-request') {
				// Esc pressed while focus lived inside the frame — the shells
				// forward it because the parent dialog never sees iframe keydowns.
				close();
			}
		}
		window.addEventListener('message', onMessage);
		return () => {
			clearTimeout(bootTimer);
			aborter.abort();
			window.removeEventListener('message', onMessage);
		};
	});
</script>

<!-- One full-screen surface for every form factor (Gmail-pattern): a single
     chrome bar, then the document owns the rest of the viewport. Root stays
     mounted (no {#if}) so the close animation actually plays. -->
<svelte:window onkeydown={onNavKeys} />
<Dialog.Root open={viewer.open} onOpenChange={(open) => { if (!open) close(); }}>
		<Dialog.Content
			showCloseButton={false}
			class="data-open:zoom-in-100 data-closed:zoom-out-100 flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
		>
			<!-- Chrome bar: identity left, actions right. Safe-area padded for iOS. -->
			<!-- Translucent chrome + surface: the dimmed app stays visible behind the
			     lightbox (the Dialog overlay supplies the scrim + blur). -->
			<Dialog.Header
				class="bg-popover/80 supports-backdrop-filter:backdrop-blur-md flex-row items-center gap-3 space-y-0 border-b px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] shrink-0"
			>
				<Dialog.Title class="min-w-0 flex-1 truncate text-left text-sm font-medium">
					{viewer.filename}
				</Dialog.Title>
				<!-- Honest affordance, compact: isolated-frame notice lives in the bar. -->
				<p class="text-muted-foreground hidden shrink-0 items-center gap-1.5 text-[11px] sm:flex">
					<ShieldCheckIcon class="size-3.5 shrink-0" />
					<span>Sandboxed preview</span>
				</p>
				{#if navItems.length > 1 && navIndex >= 0}
					<!-- Walk the thread's attachments without closing (Gmail-pattern). -->
					<div class="flex shrink-0 items-center gap-0.5">
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={!prevItem}
							onclick={() => goTo(prevItem)}
							aria-label="Previous attachment"
						>
							<ChevronLeftIcon />
						</Button>
						<span class="text-muted-foreground text-xs tabular-nums">
							{navIndex + 1} of {navItems.length}
						</span>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={!nextItem}
							onclick={() => goTo(nextItem)}
							aria-label="Next attachment"
						>
							<ChevronRightIcon />
						</Button>
					</div>
				{/if}
				<Button variant="secondary" size="sm" onclick={download}>
					<DownloadIcon data-icon="inline-start" /> Download
				</Button>
				<Button variant="ghost" size="icon-sm" onclick={close} aria-label="Close preview">
					<XIcon />
				</Button>
			</Dialog.Header>

			<!-- Document surface: fills the viewport below the bar; transparent so the
			     overlay's scrim reads through around the document. Keyed by id so
			     prev/next remounts a fresh frame per document. -->
			<div class="relative min-h-0 flex-1">
				{#key viewer.id}
				{#if failed}
					<div class="text-muted-foreground grid h-full place-items-center p-8 text-center text-sm">
						This document couldn't be loaded. Download it to open.
					</div>
				{:else if rich}
					<!-- Rich shell IS an app-like viewport (own toolbar, internal scroll):
					     give it the whole area. -->
					<iframe
						bind:this={frame}
						title="Attachment preview"
						src={frameSrc}
						sandbox={frameSandbox}
						scrolling="yes"
						class="block h-full w-full border-0"
					></iframe>
				{:else}
					<!-- Opaque frame grows to its content; THIS box scrolls it (the chrome
					     bar never moves). Document column centered at a readable measure. -->
					<div class="h-full overflow-y-auto overscroll-contain">
						<div class="mx-auto w-full max-w-4xl px-2 py-4 sm:px-4">
							<iframe
								bind:this={frame}
								title="Attachment preview"
								src={frameSrc}
								sandbox={frameSandbox}
								scrolling="no"
								style:height={`${height}px`}
								class="bg-card block w-full rounded-lg border-0 shadow-sm"
							></iframe>
						</div>
					</div>
				{/if}
				{/key}
				{#if loading && !failed}
					<!-- boot + fetch + first paint all pre-height — show progress, not a blank box -->
					<div role="status" class="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center">
						<span class="inline-flex items-center gap-2 text-xs">
							<Spinner class="size-4" /> Loading preview…
						</span>
					</div>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Root>
