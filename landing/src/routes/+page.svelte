<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Logo from '$lib/Logo.svelte';
	import Icon from '$lib/Icon.svelte';
	import { reveal } from '$lib/reveal';

	// ponytail: point at the repo once it's public
	const GITHUB_REPO = 'ethercorps/doota';
	const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

	let dark = $state(false);

	// Live repo signals — null until fetched; stays null (graceful) if repo is private / rate-limited
	type Repo = { stars: number; license: string | null; language: string | null; active: boolean };
	let repo = $state<Repo | null>(null);

	const fmtStars = (n: number) =>
		n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);

	onMount(() => {
		dark = document.documentElement.classList.contains('dark');

		fetch(`https://api.github.com/repos/${GITHUB_REPO}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((d) => {
				repo = {
					stars: d.stargazers_count ?? 0,
					license: d.license?.spdx_id ?? null,
					language: d.language ?? null,
					active: d.pushed_at ? Date.now() - Date.parse(d.pushed_at) < 30 * 864e5 : false
				};
			})
			.catch(() => {
				// ponytail: private repo / 404 / rate limit — leave repo null, UI falls back to plain "Star"
			});
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
			icon: 'threads',
			color: '#0e7ae6',
			title: 'Threads, not folders',
			body: 'Every conversation is one simple timeline of messages, just like a chat app — and it still works perfectly with Gmail, Outlook, and everyone else.'
		},
		{
			n: '02',
			icon: 'cloud',
			color: '#f6821f',
			title: 'Runs on your own account',
			body: 'It runs on your own Cloudflare account. No outside servers ever sit in the middle of your email.'
		},
		{
			n: '03',
			icon: 'lock',
			color: '#10b981',
			title: 'Private by default',
			body: 'Your messages are locked with strong encryption, so you — and only you — can read them.'
		},
		{
			n: '04',
			icon: 'undo',
			color: '#8b5cf6',
			title: 'Undo & scheduled send',
			body: 'See exactly when a message sends, delivers, or bounces. Change your mind and undo a send, or schedule one for later.'
		},
		{
			n: '05',
			icon: 'alias',
			color: '#ec4899',
			title: 'Hide-my-email aliases',
			body: 'Create extra addresses on your domain to hide your real one. Point them wherever you like, and switch them off anytime.'
		},
		{
			n: '06',
			icon: 'code',
			color: '#06b6d4',
			title: 'Open source, end to end',
			body: 'Free and open source. Read it, run it, change it. No subscriptions, no per-seat fees, no lock-in.'
		}
	];

	const flow = [
		{
			icon: 'mail',
			color: '#0e7ae6',
			title: 'Mail arrives',
			body: 'Someone sends an email to your address.'
		},
		{
			icon: 'cloud',
			color: '#f6821f',
			title: 'Cloudflare receives it',
			body: 'It arrives safely through Cloudflare.'
		},
		{
			icon: 'database',
			color: '#8b5cf6',
			title: 'Doota sorts it',
			body: 'Doota tidies it into a conversation and locks it up.'
		},
		{
			icon: 'threads',
			color: '#10b981',
			title: 'You read it',
			body: 'You open it like any chat. Nothing to manage.'
		}
	];

	const faqs = [
		{
			q: 'What exactly is Doota?',
			a: 'An email app you host yourself. You get a private inbox on your own address, where every conversation looks and feels like a chat instead of a cluttered mailbox.'
		},
		{
			q: 'Where does the name come from?',
			a: 'Doota (say DOO-tah) means messenger. It carries your words from you to whoever you write to, and back again, on a setup that belongs entirely to you.'
		},
		{
			q: 'Do I need to be technical to use it?',
			a: 'Setting it up takes a bit of technical comfort today, since it runs on your own Cloudflare account. Once it is running, using it is as easy as any email app. Friendly step-by-step guides are on the way.'
		},
		{
			q: 'How much does it cost?',
			a: 'Doota itself is free and open source. You only pay Cloudflare for what you use, which is little to nothing for a personal inbox.'
		},
		{
			q: 'Is my email really private?',
			a: 'Yes. Everything runs on your own account, and your messages are encrypted so only you can read them. No company sits in the middle reading along.'
		},
		{
			q: 'Can I still email people on Gmail or Outlook?',
			a: 'Of course. Doota is normal email underneath, so you can write to anyone, and anyone can write back to you.'
		},
		{
			q: 'When does it launch?',
			a: 'Soon. It is being built in the open right now. Star the project on GitHub to follow along and hear the moment it is ready.'
		}
	];
</script>

<svelte:head>
	<title>Doota — Own your email</title>
	<meta
		name="description"
		content="Your own private email, hosted by you. Every conversation reads like a chat. Open source, coming soon."
	/>
	<meta property="og:title" content="Doota — Own your email" />
	<meta
		property="og:description"
		content="An email app you run yourself. Every conversation reads like a chat, on your own address. Open source, coming soon."
	/>
	<meta property="og:type" content="website" />
	<!-- ponytail: relative path works for most scrapers; swap to an absolute URL once the domain is known -->
	<meta property="og:image" content="/og.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:image" content="/og.png" />
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
					{#if repo}
						<span
							class="ml-0.5 hidden rounded bg-paper/20 px-1.5 py-0.5 text-xs font-bold tabular-nums sm:inline"
							>{fmtStars(repo.stars)}</span
						>
					{/if}
				</a>
			</div>
		</nav>
	</header>

	<!-- Hero: title left, thread mockup right (modern-minimal two-column) -->
	<section class="relative mx-auto max-w-6xl px-5 pt-16 pb-16 sm:px-8 sm:pt-20 sm:pb-24">
		<!-- crosshair grid + vibrant, drifting color field -->
		<div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
			<div class="hero-grid absolute inset-0"></div>
			<div
				class="blob absolute -top-24 -left-20 h-72 w-72 rounded-full blur-3xl"
				style="background:radial-gradient(circle,#0e7ae633,transparent 70%);--dx:26px;--dy:22px;--dur:22s"
			></div>
			<div
				class="blob absolute top-8 right-1/4 h-80 w-80 rounded-full blur-3xl"
				style="background:radial-gradient(circle,#8b5cf62e,transparent 70%);--dx:-30px;--dy:18px;--dur:26s"
			></div>
			<div
				class="blob absolute -bottom-16 right-0 h-72 w-72 rounded-full blur-3xl"
				style="background:radial-gradient(circle,#06b6d42e,transparent 70%);--dx:-20px;--dy:-24px;--dur:19s"
			></div>
		</div>
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
					Your email,<br />
					<span
						class="bg-gradient-to-r from-accent via-[#8b5cf6] to-[#06b6d4] bg-clip-text text-transparent"
						>finally yours.</span
					>
				</h1>

				<p class="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
					Doota is an email app you run yourself. Every conversation reads like a chat, simple and personal — and
					while your inbox lives on your own address, not someone else's servers.
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

				{#if repo}
					<ul class="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
						<li class="flex items-center gap-1.5 font-medium">
							<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" class="text-[#f5b301]" aria-hidden="true">
								<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
							</svg>
							<span class="tabular-nums font-semibold text-ink">{fmtStars(repo.stars)}</span> stars
						</li>
						{#if repo.license}
							<li class="text-faint">·</li>
							<li class="font-medium">{repo.license} licensed</li>
						{/if}
						{#if repo.language}
							<li class="text-faint">·</li>
							<li class="font-medium">{repo.language}</li>
						{/if}
						{#if repo.active}
							<li class="text-faint">·</li>
							<li class="flex items-center gap-1.5 font-medium">
								<span class="h-1.5 w-1.5 rounded-full bg-[#10b981]"></span> Active
							</li>
						{/if}
					</ul>
				{/if}

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
			<div class="relative">
			<div
				aria-hidden="true"
				class="absolute -inset-3 -z-10 rounded-[2rem] bg-gradient-to-tr from-accent/25 via-[#8b5cf6]/15 to-[#06b6d4]/25 blur-2xl"
			></div>
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
						<!-- <span class="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/85">
							9:00
							<svg class="tick" width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-label="Delivered">
								<path d="M1 5.5 4.5 9 10 2" /><path d="M6 8.5 6.7 9 12 2" />
							</svg>
						</span> -->
					</div>
					<div class="msg max-w-[70%] self-start rounded-2xl rounded-tl-md bg-raised px-3.5 py-2.5" style="animation-delay:380ms">
						<p class="text-sm text-ink">Perfect, thank you 🙌</p>
					</div>
					<div class="msg flex items-center gap-1 self-start rounded-2xl rounded-tl-md bg-raised px-3.5 py-3" style="animation-delay:520ms" aria-label="typing">
						<span class="typing-dot h-1.5 w-1.5 rounded-full bg-faint"></span>
						<span class="typing-dot h-1.5 w-1.5 rounded-full bg-faint" style="animation-delay:.2s"></span>
						<span class="typing-dot h-1.5 w-1.5 rounded-full bg-faint" style="animation-delay:.4s"></span>
					</div>
				</div>

				<div class="msg mt-4 flex items-center gap-2 rounded-2xl border border-line bg-raised px-3.5 py-2.5" style="animation-delay:640ms">
					<span class="text-sm text-faint">Reply to Shivam…</span>
					<span class="ml-auto grid h-7 w-7 place-items-center rounded-full bg-accent text-white">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M22 2 11 13M22 2 15 22l-4-9-9-4 20-7Z" />
						</svg>
					</span>
				</div>
			</div>
		</div>
		</div>
	</section>

	<!-- Mail-flow diagram: how a message becomes a thread -->
	<section id="how" class="scroll-mt-20 border-t border-line">
		<div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
			<div class="max-w-2xl" use:reveal>
				<h2 class="font-display text-2xl font-bold tracking-tight sm:text-4xl">
					What happens when someone emails you.
				</h2>
				<p class="mt-3 text-base leading-relaxed text-muted">
					Nothing to run, nothing to babysit. Their message simply arrives and turns into a conversation you own.
				</p>
			</div>

			<div class="mt-12 flex flex-col gap-3 lg:flex-row lg:items-stretch">
				{#each flow as step, i (step.title)}
					<div
						use:reveal={i * 80}
						class="card-soft flex flex-1 flex-col rounded-2xl border border-line bg-surface p-5 sm:p-6"
					>
						<div class="flex items-center gap-3">
							<span
								class="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
								style="background:{step.color}1a"
							>
								<Icon name={step.icon} color={step.color} size={20} />
							</span>
							<span class="font-display text-xs font-bold tabular-nums text-faint">0{i + 1}</span>
						</div>
						<h3 class="mt-4 font-display text-base font-bold tracking-tight">{step.title}</h3>
						<p class="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
					</div>
					{#if i < flow.length - 1}
						<div class="flex shrink-0 items-center justify-center py-1 lg:py-0">
							<svg
								class="rotate-90 text-faint lg:rotate-0"
								width="22"
								height="22"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M5 12h14M13 6l6 6-6 6" />
							</svg>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	</section>

	<!-- Capability grid -->
	<section class="scroll-mt-20 border-t border-line bg-raised">
		<div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
			<div class="max-w-2xl" use:reveal>
				<h2 class="font-display text-2xl font-bold tracking-tight sm:text-4xl">
					An email client that thinks like a chat app.
				</h2>
				<p class="mt-3 text-base leading-relaxed text-muted">
					Here's everything Doota does — built for one person first, with just enough
					sharing to keep your conversations flowing.
				</p>
			</div>

			<div class="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
				{#each capabilities as cap, i (cap.n)}
					<div
						use:reveal={i * 70}
						class="group flex flex-col bg-surface p-6 transition-transform transition-colors duration-200 ease-out hover:-translate-y-0.5 hover:bg-raised sm:p-7"
					>
						<div class="flex items-center justify-between">
							<span
								class="grid h-11 w-11 place-items-center rounded-xl transition-transform duration-200 ease-out group-hover:scale-110"
								style="background:{cap.color}1a"
							>
								<Icon name={cap.icon} color={cap.color} />
							</span>
							<span class="font-display text-sm font-bold tabular-nums text-faint">{cap.n}</span>
						</div>
						<h3 class="mt-4 font-display text-lg font-bold tracking-tight">{cap.title}</h3>
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
					Not a subscription. <span class="text-muted">No monthly fees, no limits, no lock-in.</span>
				</h2>
				<p class="text-base leading-relaxed text-muted">
					You run Doota once, for your all domains. Your original emails are always kept
						whole and untouched — so nothing ever gets locked away, and nothing gets lost.
				</p>
			</div>
		</div>
	</section>

	<!-- FAQ (native details — accessible, no JS) -->
	<section class="border-t border-line">
		<div class="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-24">
			<div class="max-w-2xl" use:reveal>
				<h2 class="font-display text-2xl font-bold tracking-tight sm:text-4xl">
					Questions, answered.
				</h2>
				<p class="mt-3 text-base leading-relaxed text-muted">
					The short version. Fuller guides land with the docs.
				</p>
			</div>

			<div class="mt-10" use:reveal={80}>
				{#each faqs as faq (faq.q)}
					<details class="group border-b border-line">
						<summary
							class="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-left font-display text-base font-semibold tracking-tight text-ink transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
						>
							{faq.q}
							<svg
								class="shrink-0 text-faint transition-transform duration-200 ease-out group-open:rotate-180"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="m6 9 6 6 6-6" />
							</svg>
						</summary>
						<p class="pb-5 -mt-1 text-sm leading-relaxed text-muted sm:text-base">{faq.a}</p>
					</details>
				{/each}
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
				It's public and moving fast. Star it on GitHub to follow along until launch.
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
		<div class="mx-auto max-w-6xl px-5 py-8 sm:px-8">
			<div
				class="flex flex-col gap-3 text-sm text-muted sm:flex-row sm:items-center sm:justify-between"
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
					<span class="text-faint">© 2026 Ethercorps</span>
				</div>
			</div>
			<p class="mt-6 max-w-2xl text-xs leading-relaxed text-faint">
				Doota is an independent open-source project. Not affiliated with, endorsed by, or sponsored
				by Cloudflare. Cloudflare, Workers, R2, and D1 are trademarks of Cloudflare, Inc.
			</p>
		</div>
	</footer>
</div>
