// SPDX-License-Identifier: Apache-2.0

/**
 * Drop the cached app-shell HTML (populated by service-worker.ts on /app
 * navigations). The shell is server-rendered from the session, so it embeds the
 * signed-in user's name/email — it must be cleared on logout or account switch,
 * for the same reason the local mirror is, before the next session loads.
 */
export async function clearAppShellCache(): Promise<void> {
	if (typeof caches === 'undefined') return;
	for (const key of await caches.keys()) {
		if (key.startsWith('doota-shell')) await caches.delete(key);
	}
}
