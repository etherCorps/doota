/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
// SPDX-License-Identifier: Apache-2.0
// Service worker: Web Push (docs/notifications.md, Phase B) + app-shell precache.
// Push delivers OS notifications with the app CLOSED (the tab-open Notification
// API can't); iOS Safari delivers push ONLY to an installed PWA. The precache
// makes repeat loads instant and satisfies the PWA-installability fetch signal.
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

// Version-keyed cache: `version` changes every deploy, so `activate` drops the
// old one and a running tab never reads a stale mix. Precache ONLY SvelteKit's
// immutable build output + static files — never pages or /api (auth-gated,
// per-user, freshness-controlled), which must always hit the network.
const CACHE = `doota-cache-${version}`;
const PRECACHE = new Set([...build, ...files]);

// The app shell is cached separately so logout can drop it (it embeds the
// signed-in user's identity) without wiping the immutable asset precache. The
// SHELL_KEY prefix is what $lib/client/app-shell-cache.ts clears; the -version
// suffix lets `activate` retire an old deploy's shell like it does the precache.
const SHELL_KEY = 'doota-shell';
const SHELL_CACHE = `${SHELL_KEY}-${version}`;
// One shell entry per app: /app is server-rendered from the session (user
// identity) only — the thread list and bodies are fetched client-side + from the
// local mirror — so the SSR HTML is query-param-independent. Cache it once under
// this canonical key and serve it for every /app* navigation.
const SHELL_URL = '/app';

// Precache best-effort: cache.addAll is atomic AND unbounded, so a single 404,
// opaque, or slow-to-respond asset aborts the whole install — the worker then
// sits at "installing" forever, never activates, and never controls the page
// (so nothing offline works). Add each asset on its own with a per-request
// timeout and swallow failures: a missing asset just isn't precached, install
// still completes, and the worker activates.
async function precache(cache: Cache, urls: string[]): Promise<void> {
	await Promise.allSettled(
		urls.map(async (url) => {
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), 10_000);
			try {
				const res = await fetch(url, { signal: abort.signal });
				if (res.ok) await cache.put(url, res);
			} catch {
				// best-effort — skip anything that 404s, is opaque, or hangs
			} finally {
				clearTimeout(timer);
			}
		}),
	);
}

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await precache(cache, [...build, ...files]);
			await sw.skipWaiting();
		})(),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys())
				if (key !== CACHE && key !== SHELL_CACHE) await caches.delete(key);
			await sw.clients.claim();
		})(),
	);
});

sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (url.origin !== location.origin) return;

	// Cache-first ONLY for the precached, content-hashed assets (immutable → a
	// hash change is a new URL, so this can never serve stale app code).
	if (PRECACHE.has(url.pathname)) {
		event.respondWith(
			caches.open(CACHE).then(async (cache) => (await cache.match(event.request)) ?? fetch(event.request)),
		);
		return;
	}

	// App-shell navigations: network-first, falling back to the last cached shell
	// so a cold reload works offline — the client boots from the precached JS and
	// renders the list/thread from the local mirror. Online always gets the fresh
	// shell (and re-caches it). Scoped to /app pages; /login, /api, the sandboxed
	// message body and images keep default network handling (auth + freshness).
	if (event.request.mode === 'navigate' && url.pathname.startsWith('/app')) {
		event.respondWith(
			(async () => {
				const cache = await caches.open(SHELL_CACHE);
				try {
					const res = await fetch(event.request);
					if (res.ok) cache.put(SHELL_URL, res.clone());
					return res;
				} catch {
					return (await cache.match(SHELL_URL)) ?? Response.error();
				}
			})(),
		);
		return;
	}

	// Everything else falls through to default network handling.
});

type PushPayload = { title?: string; body?: string; url?: string; tag?: string };

sw.addEventListener('push', (event) => {
	event.waitUntil(onPush(event));
});

async function onPush(event: PushEvent): Promise<void> {
	let data: PushPayload = {};
	try {
		data = (event.data?.json() as PushPayload) ?? {};
	} catch {
		// non-JSON payload — fall back to defaults
	}
	// Open-tab dedupe: a focused window already shows the in-app badge/chirp, so
	// firing an OS notification too would double up. Push covers closed/background.
	const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
	if (windows.some((client) => (client as WindowClient).focused)) return;

	await sw.registration.showNotification(data.title ?? 'Doota', {
		body: data.body,
		tag: data.tag, // per-thread tag collapses a reply burst into one notification
		data: { url: data.url ?? '/app' },
		icon: '/icon-192.png', // large image shown when the notification expands
		badge: '/badge-96.png' // small monochrome silhouette for the status-bar/"on top" icon
	});
}

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/app';
	event.waitUntil(focusOrOpen(url));
});

async function focusOrOpen(url: string): Promise<void> {
	const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
	for (const client of windows) {
		const win = client as WindowClient;
		// Reuse an existing tab — navigate it to the target, then focus.
		await win.navigate?.(url).catch(() => {});
		await win.focus();
		return;
	}
	await sw.clients.openWindow(url);
}
