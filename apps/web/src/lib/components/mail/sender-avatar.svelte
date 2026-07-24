<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { dicebearFor, noServerAvatar } from '$lib/client/dicebear';

	// Sender avatar with a three-step fallback: our user's uploaded image (via
	// /api/sender-avatar, browser HTTP-cached) → DiceBear generated locally for
	// external senders → initials tint while anything loads.
	let { from, class: cls = '' }: { from: string | null; class?: string } = $props();

	const addr = $derived(from?.trim().toLowerCase() ?? '');
	let failed = $state(false);

	function senderName(a: string): string {
		const local = a.split('@')[0] ?? a;
		return local.replace(/[._-]+/g, ' ').trim() || a;
	}
	const initials = $derived.by(() => {
		if (!addr) return '?';
		const parts = senderName(addr).split(/\s+/).filter(Boolean);
		return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
	});
	const TINTS = ['bg-p1/15 text-p1', 'bg-p2/15 text-p2', 'bg-p3/15 text-p3', 'bg-brand/15 text-brand', 'bg-ok/15 text-ok'];
	const tint = $derived.by(() => {
		let h = 0;
		for (const ch of addr) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
		return TINTS[h % TINTS.length];
	});

	const src = $derived(
		!addr
			? null
			: failed || noServerAvatar.has(addr)
				? dicebearFor(addr)
				: `/api/sender-avatar/${encodeURIComponent(addr)}`
	);
</script>

<span class="relative grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold {tint} {cls}">
	{initials}
	{#if src}
		<img
			{src}
			alt=""
			loading="lazy"
			class="absolute inset-0 size-full object-cover"
			onerror={() => {
				noServerAvatar.add(addr);
				failed = true;
			}}
		/>
	{/if}
</span>
