<!-- Hallmark · component: mail HTML frame · genre: inherited (app system)
     states: measuring (skeleton height) · fitted · collapsed+fade · expanded
     Sandboxed message HTML that sizes itself to its content instead of forcing
     an inner scrollbar — the nested-scroll trap was the mobile friction. Short
     mail shrinks to fit; long mail collapses to a cap with a fade and expands
     INLINE, so the page stays the only scroll axis. -->
<script lang="ts">
	let {
		doc,
		collapsedMax = 352,
		fadeClass = 'from-card',
		linkClass = 'text-brand'
	}: {
		/** Full srcdoc document (already CSP-framed + cid-rewritten by the caller). */
		doc: string;
		/** Collapsed height cap in px (~22rem). */
		collapsedMax?: number;
		/** Gradient start matching the surface behind the fade. */
		fadeClass?: string;
		/** Toggle-button text color (bubbles invert). */
		linkClass?: string;
	} = $props();

	let frame = $state<HTMLIFrameElement>();
	let contentH = $state(0);
	let expanded = $state(false);

	// Slack so a message a few px over the cap never earns a toggle.
	const overflowing = $derived(contentH > collapsedMax + 48);
	const height = $derived(
		contentH === 0 ? Math.min(collapsedMax, 288) : expanded || !overflowing ? contentH : collapsedMax
	);

	function measure() {
		const body = frame?.contentDocument?.body;
		if (body) contentH = Math.ceil(body.scrollHeight) + 4;
	}

	$effect(() => {
		void doc; // new document → re-measure from scratch
		contentH = 0;
		expanded = false;
		const f = frame;
		if (!f) return;
		let ro: ResizeObserver | undefined;
		const onload = () => {
			measure();
			// Inline/remote images load after the doc — track late height changes.
			const body = f.contentDocument?.body;
			if (body && typeof ResizeObserver !== 'undefined') {
				ro = new ResizeObserver(measure);
				ro.observe(body);
			}
		};
		f.addEventListener('load', onload);
		// srcdoc may already be loaded by the time the effect runs.
		if (f.contentDocument?.readyState === 'complete') onload();
		return () => {
			f.removeEventListener('load', onload);
			ro?.disconnect();
		};
	});
</script>

<div class="relative">
	<iframe
		bind:this={frame}
		title="Message content"
		sandbox="allow-same-origin"
		srcdoc={doc}
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
