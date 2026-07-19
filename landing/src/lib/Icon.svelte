<script lang="ts">
	let {
		name,
		color = 'currentColor',
		size = 22
	}: { name: string; color?: string; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke={color}
	stroke-width="1.9"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'threads'}
		<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		<path d="M8 9h8M8 13h5" />
	{:else if name === 'cloud'}
		<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.98A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
		<path d="m9 13 2 2 4-4" />
	{:else if name === 'lock'}
		<rect x="4" y="11" width="16" height="10" rx="2" />
		<path d="M8 11V7a4 4 0 0 1 8 0v4" />
	{:else if name === 'undo'}
		<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
		<path d="M3 3v5h5" />
	{:else if name === 'alias'}
		<circle cx="12" cy="12" r="4" />
		<path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
	{:else if name === 'code'}
		<path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
	{:else if name === 'mail'}
		<rect x="3" y="5" width="18" height="14" rx="2" />
		<path d="m3 7 9 6 9-6" />
	{:else if name === 'database'}
		<ellipse cx="12" cy="5" rx="8" ry="3" />
		<path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
		<path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
	{/if}
</svg>
