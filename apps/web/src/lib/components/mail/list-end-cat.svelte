<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	/* Hallmark · component: end-of-list-cat · genre: playful · theme: project (amber + pink + brand)
	 * motion: breathe · z-drift · rock · tail-swish · tail-flick · bob — transform/opacity only
	 * reduced-motion: all off
	 * End-of-list marker: shown once real pagination is exhausted. A hand-drawn
	 * ginger cat keeps the empty space warm instead of an abrupt cutoff. One of four
	 * poses + a sign-off line, rolled once on mount (stable while you sit on a
	 * folder; a fresh visit re-rolls). Pose 0 / first line render server-side so
	 * hydration matches, then onMount re-rolls client-side. */
	import { onMount } from 'svelte';

	let { name }: { name: string } = $props();

	const LINES = [
		"The cat's got the rest. Nothing more to load.",
		'Even the cat gave up scrolling here.',
		'Nothing below but a napping cat.',
		'The cat guards the bottom — go rest.',
		'You reached the cat. That means done.'
	];
	let pose = $state(0);
	let line = $state(LINES[0]);
	onMount(() => {
		pose = Math.floor(Math.random() * 4);
		line = LINES[Math.floor(Math.random() * LINES.length)];
	});

	const catCls = 'text-amber-600/85 dark:text-amber-400/80';
</script>

<div class="relative flex flex-col items-center gap-2 py-8 select-none">
	{#if pose === 0}
		<!-- Loaf, asleep: drifting z's + a slow breath. -->
		<span aria-hidden="true" class="kitty-z kitty-z1 text-brand/45 absolute font-semibold">z</span>
		<span aria-hidden="true" class="kitty-z kitty-z2 text-brand/35 absolute font-semibold">z</span>
		<svg class="kitty-cat {catCls}" viewBox="0 0 72 52" width="64" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M12 42 C12 26 22 20 36 20 C50 20 60 26 60 42 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M25 22 L22 13 L31 18 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M47 22 L50 13 L41 18 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M26 20 L24 15 L29 18 Z" class="fill-pink-300/70" stroke="none" />
			<path d="M46 20 L48 15 L43 18 Z" class="fill-pink-300/70" stroke="none" />
			<path d="M27 31 q3 2.5 6 0" />
			<path d="M39 31 q3 2.5 6 0" />
			<path d="M35 35 l1 1.2 l1 -1.2" class="stroke-pink-400" />
			<path d="M29 36 h-8" stroke-opacity="0.55" />
			<path d="M43 36 h8" stroke-opacity="0.55" />
			<path d="M60 42 q9 -1 7 -11 q-1 -6 -7 -3" />
		</svg>
	{:else if pose === 1}
		<!-- Sitting up, tail swaying. -->
		<svg class="kitty-sit {catCls}" viewBox="0 0 72 52" width="64" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path class="kitty-tail" d="M44 45 q11 1 8 -10" />
			<path d="M27 47 C27 33 45 33 45 47 Z" fill="currentColor" fill-opacity="0.16" />
			<circle cx="36" cy="25" r="9.5" fill="currentColor" fill-opacity="0.16" />
			<path d="M28 18 L25 9 L34 15 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M44 18 L47 9 L38 15 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M29 16 L27 11 L32 14 Z" class="fill-pink-300/70" stroke="none" />
			<path d="M43 16 L45 11 L40 14 Z" class="fill-pink-300/70" stroke="none" />
			<circle cx="32" cy="25" r="1.2" fill="currentColor" stroke="none" />
			<circle cx="40" cy="25" r="1.2" fill="currentColor" stroke="none" />
			<path d="M35 29 l1 1.1 l1 -1.1" class="stroke-pink-400" />
			<path d="M31 30 h-7" stroke-opacity="0.5" />
			<path d="M41 30 h7" stroke-opacity="0.5" />
		</svg>
	{:else if pose === 2}
		<!-- Curled into a ball, breathing. -->
		<svg class="kitty-pulse {catCls}" viewBox="0 0 72 52" width="64" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="36" cy="32" r="13" fill="currentColor" fill-opacity="0.16" />
			<path d="M49 34 q1 8 -9 9" stroke-opacity="0.7" />
			<path d="M29 21 L27 14 L33 18 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M43 21 L45 14 L39 18 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M30 19 L28.5 15 L32 17 Z" class="fill-pink-300/70" stroke="none" />
			<path d="M31 30 q3 2.5 6 0" />
			<path d="M39 30 q3 2 5 0" />
			<path d="M35 34 l1 1.1 l1 -1.1" class="stroke-pink-400" />
			<path class="kitty-tailtip" d="M23 39 q-6 3 -2 8" />
		</svg>
	{:else}
		<!-- Peeking over the bottom edge, curious. -->
		<svg class="kitty-bob {catCls}" viewBox="0 0 72 52" width="64" height="46" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M8 42 H64" stroke-opacity="0.4" />
			<path d="M24 42 a12 11 0 0 1 24 0 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M27 33 L24 24 L33 30 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M45 33 L48 24 L39 30 Z" fill="currentColor" fill-opacity="0.16" />
			<path d="M28 31 L26 26 L31 29 Z" class="fill-pink-300/70" stroke="none" />
			<path d="M44 31 L46 26 L41 29 Z" class="fill-pink-300/70" stroke="none" />
			<circle cx="32" cy="38" r="1.3" fill="currentColor" stroke="none" />
			<circle cx="40" cy="38" r="1.3" fill="currentColor" stroke="none" />
			<path d="M35 41 l1 1 l1 -1" class="stroke-pink-400" />
		</svg>
	{/if}
	<p class="text-foreground/70 text-xs font-medium">That's the end of {name.toLowerCase()}</p>
	<p class="text-faint text-[11px]">{line}</p>
</div>

<style>
	.kitty-cat {
		transform-origin: 50% 92%;
		animation: kitty-breathe 3.4s ease-in-out infinite;
	}
	.kitty-z {
		top: 0.25rem;
		opacity: 0;
		animation: kitty-z 3.4s ease-in-out infinite;
	}
	.kitty-z1 {
		left: calc(50% + 0.8rem);
		font-size: 0.7rem;
	}
	.kitty-z2 {
		left: calc(50% + 1.6rem);
		font-size: 0.9rem;
		animation-delay: 1.5s;
	}
	/* Each pose has two moving parts so the motion always reads:
	   Sitting = whole-body rock + a big tail swish. Ball = breath + a tail-tip
	   flick. Peek = a clear bob with a slight head tilt. */
	.kitty-sit {
		transform-origin: 50% 95%;
		animation: kitty-rock 2.6s ease-in-out infinite;
	}
	.kitty-sit .kitty-tail {
		transform-box: fill-box;
		transform-origin: 20% 90%;
		animation: kitty-tail 1.8s ease-in-out infinite;
	}
	.kitty-pulse {
		transform-origin: 50% 62%;
		animation: kitty-pulse 3s ease-in-out infinite;
	}
	.kitty-pulse .kitty-tailtip {
		transform-box: fill-box;
		transform-origin: 90% 10%;
		animation: kitty-tailtip 1.6s ease-in-out infinite;
	}
	.kitty-bob {
		animation: kitty-bob 2.4s ease-in-out infinite;
	}
	@keyframes kitty-breathe {
		0%, 100% { transform: scaleY(1); }
		50% { transform: scaleY(1.06) translateY(-1px); }
	}
	@keyframes kitty-z {
		0% { opacity: 0; transform: translateY(3px) scale(0.7); }
		25% { opacity: 1; }
		100% { opacity: 0; transform: translateY(-18px) scale(1.1); }
	}
	@keyframes kitty-rock {
		0%, 100% { transform: rotate(-2.5deg); }
		50% { transform: rotate(2.5deg); }
	}
	@keyframes kitty-tail {
		0%, 100% { transform: rotate(-10deg); }
		50% { transform: rotate(16deg); }
	}
	@keyframes kitty-pulse {
		0%, 100% { transform: scale(1); }
		50% { transform: scale(1.055); }
	}
	@keyframes kitty-tailtip {
		0%, 100% { transform: rotate(0deg); }
		50% { transform: rotate(-20deg); }
	}
	@keyframes kitty-bob {
		0%, 100% { transform: translateY(3px) rotate(-1.5deg); }
		50% { transform: translateY(-5px) rotate(1.5deg); }
	}
	@media (prefers-reduced-motion: reduce) {
		.kitty-cat,
		.kitty-sit,
		.kitty-sit .kitty-tail,
		.kitty-pulse,
		.kitty-pulse .kitty-tailtip,
		.kitty-bob { animation: none; }
		.kitty-z { animation: none; opacity: 0; }
	}
</style>
