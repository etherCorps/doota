// SPDX-License-Identifier: Apache-2.0
// Web Push subscription lifecycle (docs/notifications.md, Phase B). Registers
// this browser with the push service + persists the subscription so the server
// can deliver notifications with the app closed. All no-ops when push is
// unsupported, permission isn't granted, or the VAPID key isn't configured — the
// tab-open Notification API (os-notify) still covers the focused case.
import { savePushSubscription, deletePushSubscription, pushPublicKey } from '$lib/rpc/notification.remote.js';

function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padding = '='.repeat((4 - (base64.length % 4)) % 4);
	const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(b64);
	const arr = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
	return arr;
}

function keyOf(sub: PushSubscription, name: 'p256dh' | 'auth'): string | null {
	const k = sub.getKey(name);
	if (!k) return null;
	// base64 (standard) — the keys are tiny (65 / 16 bytes), no spread-limit risk.
	return btoa(String.fromCharCode(...new Uint8Array(k)));
}

function supported(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		'serviceWorker' in navigator &&
		typeof window !== 'undefined' &&
		'PushManager' in window &&
		typeof Notification !== 'undefined'
	);
}

/** Does this browser support Web Push at all (for the settings toggle). */
export function pushSupported(): boolean {
	return supported();
}

/** Is there a live push subscription in THIS browser right now. */
export async function isPushSubscribed(): Promise<boolean> {
	if (!supported()) return false;
	try {
		const reg = await navigator.serviceWorker.ready;
		return !!(await reg.pushManager.getSubscription());
	} catch {
		return false;
	}
}

/** Subscribe this browser + persist. Idempotent (reuses an existing subscription).
 * Call after permission is granted, and on load when permission is already on. */
export async function subscribeToPush(): Promise<void> {
	if (!supported() || Notification.permission !== 'granted') return;
	const vapid = await pushPublicKey();
	if (!vapid) return;
	try {
		const reg = await navigator.serviceWorker.ready;
		const sub =
			(await reg.pushManager.getSubscription()) ??
			(await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource
			}));
		const p256dh = keyOf(sub, 'p256dh');
		const auth = keyOf(sub, 'auth');
		if (!p256dh || !auth) return;
		await savePushSubscription({ endpoint: sub.endpoint, p256dh, auth, userAgent: navigator.userAgent });
	} catch {
		// denied / no push service — silent; focused-tab notifications still work.
	}
}

/** Unsubscribe + forget (logout, or the user turned notifications off). */
export async function unsubscribeFromPush(): Promise<void> {
	if (!supported()) return;
	try {
		const reg = await navigator.serviceWorker.ready;
		const sub = await reg.pushManager.getSubscription();
		if (!sub) return;
		const endpoint = sub.endpoint;
		await sub.unsubscribe();
		await deletePushSubscription({ endpoint });
	} catch {
		// best-effort
	}
}
