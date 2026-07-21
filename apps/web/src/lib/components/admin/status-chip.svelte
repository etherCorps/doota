<script lang="ts">
	// Small status pill for DKIM / sending / user state. Neutral by default;
	// ok = green, warn = amber, bad = destructive. Accent stays reserved for
	// interactive elements, so statuses use their own semantic hues.
	let { status }: { status: string } = $props();

	const tone: Record<string, string> = {
		verified: 'ok',
		active: 'ok',
		read: 'ok',
		pending: 'warn',
		disabled: 'muted',
		paused: 'muted',
		failed: 'bad'
	};
	const t = $derived(tone[status] ?? 'muted');

	const classes: Record<string, string> = {
		ok: 'bg-ok/10 text-ok',
		warn: 'bg-warn/10 text-warn',
		bad: 'bg-destructive/10 text-destructive',
		muted: 'bg-muted text-muted-foreground'
	};
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize {classes[t]}"
>
	<span class="size-1.5 rounded-full bg-current"></span>{status}
</span>
