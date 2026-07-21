<script lang="ts">
	import { cn } from '$lib/utils/ui.js';

	// Underline tab strip shared by the org + account section layouts. The parent
	// computes `active`; this component only renders. Scrolls horizontally on small
	// screens so tab sets never overflow.
	let { tabs }: { tabs: { href: string; label: string; active: boolean }[] } = $props();
</script>

<nav class="border-b">
	<div class="-mb-px flex gap-1 overflow-x-auto">
		{#each tabs as t (t.href)}
			<a
				href={t.href}
				class={cn(
					'shrink-0 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
					t.active
						? 'border-primary text-foreground'
						: 'text-muted-foreground hover:text-foreground border-transparent'
				)}
			>
				{t.label}
			</a>
		{/each}
	</div>
</nav>
