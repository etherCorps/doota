<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Sandboxed message HTML, loaded from the server-sanitized /api/messages/[id]/body
     route as an OPAQUE-origin frame (sandbox="allow-scripts", NO allow-same-origin).
     The framed doc can't touch the app; it reports its height and forwards link
     clicks over postMessage. Height sizes to content (no inner scrollbar); long mail
     collapses to a cap with a fade and expands inline. -->
<script lang="ts">
	let {
		src,
		collapsedMax = 352,
		collapse = true,
		fadeClass = 'from-card',
		linkClass = 'text-brand',
		onmailto
	}: {
		/** URL of the sanitized body route (already carries ?images=0|1). */
		src: string;
		collapsedMax?: number;
		/** Self-collapse long content to `collapsedMax` with a "Show full message"
		 * toggle. OFF in mail (Gmail) view — the expanded card is already the
		 * container, so a second collapse layer is redundant/confusing. */
		collapse?: boolean;
		fadeClass?: string;
		linkClass?: string;
		/** A mailto: link was clicked — open Doota's composer instead of the OS handler.
		 * `subject`/`body` carry the link's ?subject=&body= params (already decoded). */
		onmailto?: (address: string, extra?: { subject?: string; body?: string }) => void;
	} = $props();

	let frame = $state<HTMLIFrameElement>();
	let contentH = $state(0);
	let expanded = $state(false);
	// Clamp an untrusted height so a hostile value can't blow up the layout.
	const MAX_H = 20000;

	const overflowing = $derived(collapse && contentH > collapsedMax + 48);
	const height = $derived(
		contentH === 0
			? Math.min(collapsedMax, 288)
			: expanded || !overflowing
				? contentH
				: collapsedMax
	);

	// New document → re-measure from scratch.
	$effect(() => {
		void src;
		contentH = 0;
		expanded = false;
	});

	$effect(() => {
		function onMessage(e: MessageEvent) {
			// Opaque origin: event.origin is "null", so validate the SOURCE window, not the origin.
			if (!frame || e.source !== frame.contentWindow) return;
			const d = e.data as {
				__mailframe?: number;
				type?: string;
				value?: unknown;
				address?: unknown;
				subject?: unknown;
				body?: unknown;
			};
			if (!d || d.__mailframe !== 1) return;
			if (d.type === 'height' && typeof d.value === 'number' && Number.isFinite(d.value)) {
				contentH = Math.max(0, Math.min(MAX_H, Math.ceil(d.value)));
			} else if (d.type === 'mailto' && typeof d.address === 'string') {
				// http/https links open inside the frame (in the click gesture, so no
				// popup-block); only mailto: comes up here, to open the composer.
				onmailto?.(d.address, {
					subject: typeof d.subject === 'string' ? d.subject : undefined,
					body: typeof d.body === 'string' ? d.body : undefined
				});
			}
		}
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});
</script>

<div class="relative">
	<iframe
		bind:this={frame}
		title="Message content"
		{src}
		sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
		scrolling="no"
		style:height={`${height}px`}
		class="w-full rounded-lg border-0 bg-transparent transition-[height] duration-200 ease-out motion-reduce:transition-none"
	></iframe>
	{#if overflowing && !expanded}
		<div class="pointer-events-none absolute inset-x-0 bottom-7 h-12 bg-gradient-to-t {fadeClass} to-transparent"></div>
	{/if}
	{#if overflowing}
		<button
			type="button"
			class="focus-visible:ring-ring/50 mt-0.5 rounded text-xs font-medium outline-none hover:underline focus-visible:ring-2 {linkClass}"
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? 'Show less' : 'Show full message'}
		</button>
	{/if}
</div>
