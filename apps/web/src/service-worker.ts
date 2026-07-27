/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
// SPDX-License-Identifier: Apache-2.0
// Web Push service worker (docs/notifications.md, Phase B). Push + click only —
// no offline caching. Delivers OS notifications with the app CLOSED, which the
// tab-open Notification API can't. iOS Safari delivers push ONLY to an installed
// PWA (add-to-home-screen); desktop works in a normal tab.

const sw = self as unknown as ServiceWorkerGlobalScope;

// Take control immediately so a fresh SW starts handling push without a reload.
sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

// A registered fetch handler is part of the PWA-installability signal. We do NOT
// cache — every request goes straight to the network (the app isn't offline-first);
// this just has to exist. Not calling respondWith = default browser handling.
sw.addEventListener('fetch', () => {});

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
