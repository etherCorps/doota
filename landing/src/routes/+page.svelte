<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Logo from '$lib/Logo.svelte';
	import { reveal } from '$lib/reveal';

	// ponytail: point at the repo once it's public
	const GITHUB_URL = 'https://github.com/ethercorps/doota';

	let dark = $state(false);

	onMount(() => {
		dark = document.documentElement.classList.contains('dark');
	});

	function toggleTheme() {
		dark = !dark;
		document.documentElement.classList.toggle('dark', dark);
		try {
			localStorage.setItem('theme', dark ? 'dark' : 'light');
		} catch (e) {
			// ponytail: private-mode localStorage throws; theme just won't persist
		}
	}

	const stack = ['Workers', 'D1', 'R2', 'KV', 'Queues', 'Email Routing'];

	const capabilities = [
		{
			n: '01',
			title: 'Threads, not folders',
			body: 'Every conversation is a flat, WhatsApp-style timeline of bubbles — with reply-context chips — that still interoperates cleanly with Gmail and Outlook.'
		},
		{
			n: '02',
			title: 'Runs on your Cloudflare',
			body: 'One deployment, one operator, one account. Workers, D1, and R2 do the work. No third-party mail servers touch your inbox.'
		},
		{
			n: '03',
			title: 'Zero-access encryption',
			body: 'Subjects and bodies are encrypted at rest with AES-256-GCM. Routing metadata stays cleartext so threading works without decryption.'
		},
		{
			n: '04',
			title: 'Undo & scheduled send',
			body: 'A first-class submission object tracks every message: queued, sent, delivered, bounced. WhatsApp-style ticks, undo, and send-later fall right out of it.'
		},
		{
			n: '05',
			title: 'Hide-my-email aliases',
			body: 'Generate a random address on your own domain, map it to a mailbox, disable it whenever. Reply as the alias from the compose window.'
		},
		{
			n: '06',
			title: 'Open source, end to end',
			body: 'Read the code, run the code, change the code. Not a SaaS. No per-seat pricing, no metering, no lock-in.'
		}
	];
</script>

<svelte:head>
	<title>Doota — Own your email</title>
	<meta
		name="description"
		content="Self-hosted email on Cloudflare, rendered as messaging threads. Open source. Coming soon."
	/>
	<meta property="og:title" content="Doota — Own your email" />
	<meta
		property="og:description"
		content="Self-hosted email on Cloudflare. Each thread is a flat timeline of messages. Open source, coming soon."
	/>
</svelte:head>

<div class="min-h-screen bg-paper font-body text-ink antialiased">
	<!-- Nav -->
	<header
		class="sticky top-0 z-20 border-b border-line/70 bg-paper/85 backdrop-blur supports-backdrop-filter:bg-paper/70"
	>
		<nav class="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5 sm:px-8">
			<a href={resolve('/')} class="flex items-center" aria-label="Doota home">
				<Logo size={26} />
			</a>
			<div class="flex items-center gap-1 sm:gap-2">
				<a
					href={GITHUB_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink sm:inline-block"
					>GitHub</a
				>
				<button
					onclick={toggleTheme}
					aria-label="Toggle dark mode"
					class="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-accent-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				>
					{#if dark}
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
							<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
						</svg>
					{:else}
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
						</svg>
					{/if}
				</button>
				<a
					href={GITHUB_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-ink px-3.5 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				>
					<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"
						><path
							d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
						/></svg
					>
					<span class="hidden sm:inline">Star</span>
				</a>
			</div>
		</nav>
	</header>

	<!-- Hero: title left, thread mockup right (modern-minimal two-column) -->
	<section class="mx-auto max-w-6xl px-5 pt-16 pb-16 sm:px-8 sm:pt-20 sm:pb-24">
		<div class="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
			<div>
				<span
					class="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted"
				>
					<span class="relative flex h-1.5 w-1.5">
						<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70"></span>
						<span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent"></span>
					</span>
					Coming soon · building in the open
				</span>

				<h1
					class="mt-6 font-display text-4xl font-extrabold leading-[1.02] tracking-tight wrap-anywhere sm:text-6xl"
				>
					Own your email.<br />
					<span class="text-accent">Every byte of it.</span>
				</h1>

				<p class="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
					Doota is a self-hosted email app that runs entirely on your Cloudflare account — and
					renders every thread like a conversation, not a filing cabinet.
				</p>

				<div class="mt-8 flex flex-wrap items-center gap-3">
					<a
						href={GITHUB_URL}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white transition-transform transition-opacity duration-150 ease-out hover:-translate-y-0.5 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"
							><path
								d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
							/></svg
						>
						Star on GitHub
					</a>
					<a
						href="#how"
						class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-line bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						How it works
					</a>
				</div>

				<div class="mt-12 border-t border-line pt-6">
					<p class="text-xs font-medium uppercase tracking-widest text-faint">Built on Cloudflare</p>
					<ul class="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-muted">
						{#each stack as item (item)}
							<li class="flex items-center gap-2">
								<span class="h-1 w-1 rounded-full bg-accent"></span>
								{item}
							</li>
						{/each}
					</ul>
				</div>
			</div>

			<!-- Thread mockup: the product concept, hand-built (no fake chrome) -->
			<div class="card-soft rounded-3xl border border-line bg-surface p-4 sm:p-5">
				<div class="flex items-center gap-3 border-b border-line pb-3">
					<span
						class="grid h-9 w-9 place-items-center rounded-full bg-accent-soft font-display text-sm font-bold text-accent-ink"
						>P</span
					>
					<div class="leading-tight">
						<p class="text-sm font-semibold text-ink">Shivam Meena</p>
						<p class="text-xs text-faint">3 messages · Product</p>
					</div>
					<span class="ml-auto text-xs text-faint">Today</span>
				</div>

				<div class="flex flex-col gap-2.5 pt-4">
					<div class="msg max-w-[78%] self-start rounded-2xl rounded-tl-md bg-raised px-3.5 py-2.5" style="animation-delay:80ms">
						<p class="text-sm text-ink">Can you send the Q3 deck before the sync?</p>
					</div>
					<div class="msg max-w-[82%] self-end rounded-2xl rounded-tr-md bg-accent px-3.5 py-2.5 text-white" style="animation-delay:220ms">
						<p class="text-sm">Sending now — scheduled it for 9:00 so it lands first thing.</p>
						<span class="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/80">
							9:00
							<svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-label="Delivered">
								<path d="M1 5.5 4.5 9 10 2" /><path d="M6 8.5 6.6 9 12 2" />
							</svg>
						</span>
					</div>
					<div class="msg max-w-[70%] self-start rounded-2xl rounded-tl-md bg-raised px-3.5 py-2.5" style="animation-delay:380ms">
						<p class="text-sm text-ink">Perfect, thank you 🙌</p>
					</div>
				</div>

				<div class="msg mt-4 flex items-center gap-2 rounded-2xl border border-line bg-raised px-3.5 py-2.5" style="animation-delay:520ms">
					<span class="text-sm text-faint">Reply to Shivam…</span>
					<span class="ml-auto grid h-7 w-7 place-items-center rounded-full bg-accent text-white">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z" />
						</svg>
					</span>
				</div>
			</div>
		</div>
	</section>

	<!-- Capability grid (openship 01–06 DNA) -->
	<section id="how" class="scroll-mt-20 border-t border-line bg-raised">
		<div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
			<div class="max-w-2xl" use:reveal>
				<h2 class="font-display text-2xl font-bold tracking-tight sm:text-4xl">
					An email client that thinks like a chat app.
				</h2>
				<p class="mt-3 text-base leading-relaxed text-muted">
					Everything below ships in v1. Designed for a single user first — collaboration only where
					it reinforces the conversation.
				</p>
			</div>

			<div class="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
				{#each capabilities as cap, i (cap.n)}
					<div
						use:reveal={i * 70}
						class="group flex flex-col bg-surface p-6 transition-transform transition-colors duration-200 ease-out hover:-translate-y-0.5 hover:bg-raised sm:p-7"
					>
						<span class="font-display text-sm font-bold tabular-nums text-accent">{cap.n}</span>
						<h3 class="mt-3 font-display text-lg font-bold tracking-tight">{cap.title}</h3>
						<p class="mt-2 text-sm leading-relaxed text-muted">{cap.body}</p>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<!-- Honest positioning band -->
	<section class="border-t border-line">
		<div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
			<div class="grid gap-10 md:grid-cols-[1.2fr_1fr] md:items-center" use:reveal>
				<h2 class="font-display text-2xl font-bold leading-tight tracking-tight sm:text-4xl">
					Not a SaaS. <span class="text-muted">No per-seat pricing, no metering, no lock-in.</span>
				</h2>
				<p class="text-base leading-relaxed text-muted">
					One deployment equals one operator serving their own domains, where an organization is a
					single domain. The raw RFC message in R2 is always the source of truth — every parsed,
					threaded, or stripped field is regenerable from it. Nothing to drift, nothing to lose.
				</p>
			</div>
		</div>
	</section>

	<!-- Final CTA -->
	<section class="border-t border-line bg-raised">
		<div class="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8 sm:py-28">
			<h2 class="mx-auto max-w-2xl font-display text-3xl font-extrabold tracking-tight sm:text-5xl">
				Watch it come together.
			</h2>
			<p class="mx-auto mt-4 max-w-md text-base text-muted">
				The code is public and moving. Star the repo to follow along until launch.
			</p>
			<a
				href={GITHUB_URL}
				target="_blank"
				rel="noopener noreferrer"
				class="mt-8 inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-accent px-6 py-3.5 text-sm font-semibold text-white transition-transform transition-opacity duration-150 ease-out hover:-translate-y-0.5 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
			>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"
					><path
						d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
					/></svg
				>
				Star on GitHub
			</a>
		</div>
	</section>

	<!-- Footer (Ft2) -->
	<footer class="border-t border-line">
		<div
			class="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8"
		>
			<div class="flex items-center gap-2">
				<Logo size={22} />
				<span class="text-faint">— email as a conversation</span>
			</div>
			<div class="flex items-center gap-5">
				<a
					href={GITHUB_URL}
					target="_blank"
					rel="noopener noreferrer"
					class="transition-colors hover:text-ink">GitHub</a
				>
				<span class="text-faint">© 2026</span>
			</div>
		</div>
	</footer>
</div>
