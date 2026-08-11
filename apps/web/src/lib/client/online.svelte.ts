// SPDX-License-Identifier: Apache-2.0
// Reactive online/offline flag from the browser. SSR-safe (assumes online until
// the client mounts). navigator.onLine + the online/offline events is a coarse
// signal (it can't see a captive portal), but it's the right one for "hide the
// actions that can only work with a connection".

class OnlineState {
	#online = $state(true);

	constructor() {
		if (typeof window === 'undefined') return; // SSR — stay optimistic
		this.#online = navigator.onLine;
		window.addEventListener('online', () => (this.#online = true));
		window.addEventListener('offline', () => (this.#online = false));
	}

	get online(): boolean {
		return this.#online;
	}
	get offline(): boolean {
		return !this.#online;
	}
}

/** App-wide reactive connectivity flag: `network.offline` / `network.online`. */
export const network = new OnlineState();
