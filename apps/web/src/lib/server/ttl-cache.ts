// SPDX-License-Identifier: Apache-2.0
// Tiny per-isolate TTL memo. Module scope on Workers = per-isolate: survives
// across requests while the isolate is warm, vanishes on eviction. First-tier
// cache in front of KV/D1 for small, high-read, staleness-tolerant values.
// Not for anything that must invalidate cross-isolate instantly: other
// isolates keep their copy until the TTL runs out.

type Entry<V> = { v: V; exp: number };

export class TtlCache<V> {
	#m = new Map<string, Entry<V>>();
	constructor(
		private ttlMs: number,
		private max = 1000
	) {}
	get(k: string): V | undefined {
		const e = this.#m.get(k);
		if (!e) return undefined;
		if (Date.now() > e.exp) {
			this.#m.delete(k);
			return undefined;
		}
		return e.v;
	}
	set(k: string, v: V): void {
		// ponytail: FIFO evict (oldest insert), LRU if hit patterns ever demand it
		if (this.#m.size >= this.max) this.#m.delete(this.#m.keys().next().value!);
		this.#m.set(k, { v, exp: Date.now() + this.ttlMs });
	}
	delete(k: string): void {
		this.#m.delete(k);
	}
}
