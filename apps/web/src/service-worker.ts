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

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll([...build, ...files]))
			.then(() => sw.skipWaiting()),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
			await sw.clients.claim();
		})(),
	);
});

// Cache-first ONLY for the precached, content-hashed assets (immutable → a hash
// change is a new URL, so this can never serve stale app code). Everything else
// — pages, /api, the sandboxed message body, images — falls through to default
// network handling (no respondWith); those carry their own auth + cache headers.
sw.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (url.origin !== location.origin || !PRECACHE.has(url.pathname)) return;
	event.respondWith(
		caches.open(CACHE).then(async (c) => (await c.match(event.request)) ?? fetch(event.request)),
	);
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
	if (windows.some((c) => (c as WindowClient).focused)) return;

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
	for (const c of windows) {
		const win = c as WindowClient;
		// Reuse an existing tab — navigate it to the target, then focus.
		await win.navigate?.(url).catch(() => {});
		await win.focus();
		return;
	}
	await sw.clients.openWindow(url);
}
