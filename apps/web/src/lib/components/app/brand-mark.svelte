<script lang="ts">
	// Doota mark — speech bubble + envelope flap (same as the landing logo),
	// themed to the app's primary color.
	let { size = 24 }: { size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 32 32"
	fill="none"
	role="img"
	aria-label="Doota"
	class="shrink-0"
>
	<path
		d="M9 4h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-9l-6 4v-4H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5Z"
		class="fill-primary"
	/>
	<path
		d="M9.5 11 16 15.5 22.5 11"
		class="stroke-background"
		stroke-width="2.2"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>
