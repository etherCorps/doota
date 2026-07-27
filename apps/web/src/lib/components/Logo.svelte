<script module lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	let seq = 0;
</script>

<script lang="ts">
	// Doota mark — the icon-any artwork (white letter, deep-blue envelope) with no
	// background badge. `size` auto-selects detail: chip lines ≥40, spine ≥17,
	// bare below. `variant="mono"` inherits currentColor. On hover the letter
	// lifts — it "emerges" a little further from the envelope.
	let {
		size = 24,
		variant,
		wordmark = false,
		class: klass = ''
	}: {
		size?: number;
		variant?: 'mono';
		wordmark?: boolean;
		class?: string;
	} = $props();

	const uid = `doota-mono-${seq++}`;
	const kind = $derived(
		variant === 'mono' ? 'mono' : size < 17 ? 'xs' : size < 24 ? 'sm' : size < 40 ? 'md' : 'full'
	);
</script>

<span class="doota-logo inline-flex items-center gap-2 leading-none {klass}">
	{#if kind === 'mono'}
		<svg width={size} height={size} viewBox="0 0 64 64" fill="currentColor" role="img" aria-label="Doota" class="shrink-0">
			<defs>
				<mask id={uid}>
					<rect width="64" height="64" fill="white" />
					<g transform="rotate(-9 32 22)"><rect x="16.5" y="5.5" width="31" height="30" rx="5.5" fill="black" /></g>
					<g transform="rotate(4 32 46)"><path d="M10 34l22 13 22-13" fill="none" stroke="black" stroke-width="3" stroke-linejoin="round" /></g>
				</mask>
			</defs>
			<g mask="url(#{uid})"><g transform="rotate(4 32 46)"><rect x="7" y="34" width="50" height="22" rx="7" /></g></g>
			<g transform="rotate(-9 32 22)"><rect x="18" y="7" width="28" height="27" rx="4" /></g>
		</svg>
	{:else}
		<svg width={size} height={size} viewBox="0 0 96 96" fill="none" role="img" aria-label="Doota" class="shrink-0">
			<g transform="rotate(-9 48 33)">
				<g class="doota-letter">
					<rect x="28" y="16" width="40" height="39" rx="6" fill="#A9C8E8" />
					<rect x="28" y="10" width="40" height="39" rx="6" fill="#FFFFFF" />
					{#if kind === 'full'}
						<rect x="35" y="17" width="6" height="18" rx="3" fill="#0E7AE6" />
						<rect x="47" y="18" width="14" height="5" rx="2.5" fill="#B8C4D2" />
						<rect x="47" y="27" width="10" height="5" rx="2.5" fill="#B8C4D2" />
					{:else if kind === 'md' || kind === 'sm'}
						<rect x="35" y="17" width="8" height="18" rx="4" fill="#0E7AE6" />
					{/if}
				</g>
			</g>
			<g transform="rotate(4 48 68)">
				<rect x="12" y="56" width="72" height="31" rx="10" fill="#083E75" />
				<rect x="12" y="50" width="72" height="31" rx="10" fill="#0B5FB4" />
				{#if kind !== 'xs'}<path d="M17 50l31 19 31-19z" fill="#1877D6" />{/if}
			</g>
		</svg>
	{/if}
	{#if wordmark}
		<span class="font-heading font-extrabold tracking-tight text-foreground" style="font-size:{size * 0.72}px">Doota</span>
	{/if}
</span>

<style>
	/* Micro-interaction: the letter emerges a little further on hover. Tokens fall
	   back to sensible values outside the app's design system. */
	.doota-letter {
		transition: transform var(--dur-base, 200ms) var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1));
	}
	.doota-logo:hover .doota-letter {
		transform: translateY(-3.5px);
	}
	@media (prefers-reduced-motion: reduce) {
		.doota-letter {
			transition: none;
		}
		.doota-logo:hover .doota-letter {
			transform: none;
		}
	}
</style>
