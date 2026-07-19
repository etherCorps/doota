<script lang="ts">
	let {
		size = 24,
		wordmark = true
	}: { size?: number; wordmark?: boolean } = $props();
</script>

<span class="inline-flex items-center gap-2 leading-none">
	<svg
		width={size}
		height={size}
		viewBox="0 0 32 32"
		fill="none"
		role="img"
		aria-label={wordmark ? 'Doota logo' : 'Doota'}
	>
		<!-- speech bubble with a tail: email rendered as conversation -->
		<path
			d="M9 4h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-9l-6 4v-4H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5Z"
			fill="var(--color-accent)"
		/>
		<!-- envelope flap inside the bubble -->
		<path
			d="M9.5 11 16 15.5 22.5 11"
			stroke="#fff"
			stroke-width="2.2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
	{#if wordmark}
		<span class="font-display font-extrabold tracking-tight text-ink" style="font-size:{size * 0.72}px"
			>Doota</span
		>
	{/if}
</span>
