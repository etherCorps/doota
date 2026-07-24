<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
	import { mode } from "mode-watcher";
	import SpinnerIcon from 'phosphor-svelte/lib/Spinner';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import XCircleIcon from 'phosphor-svelte/lib/XCircle';
	import InfoIcon from 'phosphor-svelte/lib/Info';
	import WarningIcon from 'phosphor-svelte/lib/Warning';

	let { ...restProps }: SonnerProps = $props();
</script>

<!-- Toasts speak the app's tokens: neutral = popover surface; success/error/
     warning/info tint from ok/destructive/warn/brand; the action button (Undo)
     reads brand. -->
<Sonner
	theme={mode.current}
	class="toaster group"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border); --border-radius: var(--radius-xl); --success-bg: color-mix(in oklch, var(--ok) 10%, var(--popover)); --success-text: var(--ok); --success-border: color-mix(in oklch, var(--ok) 35%, var(--border)); --error-bg: color-mix(in oklch, var(--destructive) 10%, var(--popover)); --error-text: var(--destructive); --error-border: color-mix(in oklch, var(--destructive) 35%, var(--border)); --warning-bg: color-mix(in oklch, var(--warn) 10%, var(--popover)); --warning-text: var(--warn); --warning-border: color-mix(in oklch, var(--warn) 35%, var(--border)); --info-bg: color-mix(in oklch, var(--brand) 10%, var(--popover)); --info-text: var(--brand); --info-border: color-mix(in oklch, var(--brand) 35%, var(--border));"
	toastOptions={{
		classes: {
			toast: 'shadow-lg! font-sans!',
			actionButton: 'bg-brand! text-brand-foreground! hover:bg-brand/90! rounded-lg! font-medium!',
			cancelButton: 'bg-muted! text-muted-foreground! rounded-lg!'
		}
	}}
	{...restProps}
>
	{#snippet loadingIcon()}
		<SpinnerIcon class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CheckCircleIcon class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<XCircleIcon class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<WarningIcon class="size-4" />
	{/snippet}
</Sonner>
