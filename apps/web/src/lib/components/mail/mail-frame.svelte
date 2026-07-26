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
		fadeClass = 'from-card',
		linkClass = 'text-brand',
		onmailto
	}: {
		/** URL of the sanitized body route (already carries ?images=0|1). */
		src: string;
		collapsedMax?: number;
		fadeClass?: string;
		linkClass?: string;
		/** A mailto: link was clicked — open Doota's composer instead of the OS handler. */
		onmailto?: (address: string) => void;
	} = $props();

	let frame = $state<HTMLIFrameElement>();
	let contentH = $state(0);
	let expanded = $state(false);
	// Clamp an untrusted height so a hostile value can't blow up the layout.
	const MAX_H = 20000;

	const overflowing = $derived(contentH > collapsedMax + 48);
	const height = $derived(
		contentH === 0 ? Math.min(collapsedMax, 288) : expanded || !overflowing ? contentH : collapsedMax
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
			const d = e.data as { __mailframe?: number; type?: string; value?: unknown; href?: unknown; text?: unknown };
			if (!d || d.__mailframe !== 1) return;
			if (d.type === 'height' && typeof d.value === 'number' && Number.isFinite(d.value)) {
				contentH = Math.max(0, Math.min(MAX_H, Math.ceil(d.value)));
			} else if (d.type === 'link' && typeof d.href === 'string') {
				handleLink(d.href, typeof d.text === 'string' ? d.text : '');
			}
		}
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});

	// Part D — the link security gate. Never string-concat a URL from the email.
	function textHostOf(text: string): string | null {
		const t = text.trim();
		if (!t || /\s/.test(t)) return null; // bare URL/domain only
		const m = t.match(/^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i);
		return m ? m[1] : null;
	}
	function handleLink(href: string, text: string) {
		let u: URL;
		try {
			u = new URL(href);
		} catch {
			return; // unparseable / relative → drop
		}
		const scheme = u.protocol.toLowerCase();
		if (scheme === 'mailto:') {
			onmailto?.(decodeURIComponent(u.pathname));
			return;
		}
		if (scheme !== 'http:' && scheme !== 'https:') return; // everything else dropped
		const host = u.hostname; // URL already IDNA-encodes to punycode
		const isIdn = host.split('.').some((l) => l.toLowerCase().startsWith('xn--'));
		const textHost = textHostOf(text);
		const mismatch = !!textHost && textHost.toLowerCase() !== host.toLowerCase();
		if (isIdn || mismatch) {
			const note = mismatch
				? `The link text says "${textHost}".`
				: 'This domain uses non-standard (internationalized) characters.';
			if (!confirm(`This link actually goes to:\n\n${host}\n\n${note}\n\nOpen it anyway?`)) return;
		}
		window.open(u.href, '_blank', 'noopener,noreferrer');
	}
</script>

<div class="relative">
	<iframe
		bind:this={frame}
		title="Message content"
		sandbox="allow-scripts"
		{src}
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
