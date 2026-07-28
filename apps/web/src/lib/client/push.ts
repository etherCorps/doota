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

/** Outcome of an enable attempt — lets the settings UI say WHY it failed instead
 * of one generic error, and guarantees "ok" means the server has the subscription
 * (not just the browser), so app-closed delivery actually works. */
export type PushEnableResult = 'ok' | 'unsupported' | 'denied' | 'no-vapid' | 'failed';

/** Subscribe this browser AND persist to the server. Idempotent (reuses an
 * existing subscription). Call after permission is granted, and on load when
 * permission is already on. Returns the true outcome — 'ok' only when the
 * server accepted the subscription. */
export async function subscribeToPush(): Promise<PushEnableResult> {
	if (!supported()) return 'unsupported';
	if (Notification.permission !== 'granted') return 'denied';
	const vapid = await pushPublicKey();
	if (!vapid) return 'no-vapid'; // server has no VAPID key configured
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
		if (!p256dh || !auth) return 'failed';
		// Persist to the server — this is what makes app-closed delivery work, so
		// a failure here means NOT enabled (a browser subscription alone delivers
		// nothing). Await it: the caller decides success on the full round-trip.
		await savePushSubscription({ endpoint: sub.endpoint, p256dh, auth, userAgent: navigator.userAgent });
		return 'ok';
	} catch {
		return 'failed';
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
