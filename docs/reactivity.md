# Reactivity rules (Svelte 5)

Runes give fine-grained reactivity **if you work with the proxy, not against it**.
The failure mode this doc prevents: allocation churn and climbing memory from
code that re-enumerates or re-creates reactive collections on every update.

These rules were written after a profiling pass; apply them, don't relitigate them.

---

## R1. Choose `$state` vs `$state.raw` by how the value changes

- **Mutated in place** (`.push`, `.splice`, `x.prop = …`, `Object.assign(x, …)`)
  → `$state`. The deep proxy is what makes one-property updates targeted.
- **Replaced wholesale** — every write is `x = newValue`, never a member mutation
  → `$state.raw`. The proxy is pure overhead; skip it.
- **Class instances / foreign objects** (editor, DOM node, library handle, Map/Set
  you manage yourself) → `$state.raw`, always. They own their mutability; proxying
  them does nothing useful or actively breaks them. Svelte doesn't deep-proxy
  non-plain objects anyway — being explicit documents intent so a later refactor
  can't silently change the shape.

> A `$state` array whose every write is `x = x.map(...)` / `x = [...x]` is
> mis-declared **or** mis-written. Decide which: if rows are patched in the
> template, keep `$state` and fix the writes (R2/R3); if it's only ever swapped,
> make it `$state.raw`.

## R2. Never spread a proxied object to change it

Spreading enumerates every key through the proxy **and** mints a new object
identity — defeating the fine-grained reactivity the proxy exists to provide.
Assign to the property instead.

```js
// enumerates the proxy, replaces the whole collection, invalidates every row
list = list.map((x) => (x.id === id ? { ...x, ...patch } : x));

// one property signal fires, one row updates
const row = list.find((x) => x.id === id);
if (row) Object.assign(row, patch);
```

## R3. Mutate arrays, don't rebuild them

```js
list.push(...page);   // not: list = [...list, ...page]
list.splice(idx, 1);  // not: list = list.filter((x) => x.id !== id)
list.length = 0;      // not: list = []
```

Svelte's array proxy turns each into targeted invalidation instead of
invalidating every element. To remove by predicate, find the index then splice:
`const i = list.findIndex(...); if (i >= 0) list.splice(i, 1);`

## R4. Compute once with `$derived`

If a template calls the same function more than once per render — filtering,
sorting, mapping — hoist it to a `$derived`. Easy to miss: each call site looks
cheap alone. This includes calls inside `{#if}`, `{#each}`, and `{@const}`.

## R5. `$effect` is for side effects only

Effects are for DOM work, event listeners, network calls, imperative APIs. If an
effect's only job is to assign a value computed from other state, it's a
`$derived`.

**Do not remove existing `untrack()` guards or late-response / mid-flight
navigation checks.** Effects that write state, and async paths that verify the
user hasn't navigated away mid-flight, exist because of real bugs. Read the
comment first — most explain themselves. An effect that *resets* editable state
when a key changes (e.g. clear overrides on thread change) is a legitimate
side effect, **not** a `$derived` candidate.

## R6. Bound every growing collection

Accumulating lists, caches, and id-keyed `SvelteMap`/`SvelteSet` all need an
eviction rule. State that grows for the length of a session is a leak with extra
steps. Patterns already in this repo to copy:

- `lib/server/ttl-cache.ts` — hard cap (FIFO evict at N, default 1000).
- `lib/components/app/send-failure-notifier.svelte` — `slice(-200)` cap.
- The mail list's `rowFx` / `swipeProg` — deleted on a timeout after use.

For a paginated list, either bound the data window (drop the tail) **or**
virtualize the render (keep the data, render only the visible window). Hundreds
of live rows cost render-tree memory well beyond the JS heap — virtualize when
the row count is unbounded.

## R7. Group related state into a cohesive object

Clusters of loose variables describing one thing — an array + its offset + its
loading flag + its end-of-data flag — are one concept, not four. Svelte supports
`$state` in class fields; extract a reusable class (e.g. a `Paginator`) so the
concept has one home and the logic isn't re-implemented per view.

---

## Optimistic mutation contract

Every server mutation routes through one helper (`lib/client/optimistic.ts`).

1. **Snapshot** enough to restore exactly.
2. **Apply locally** via in-place mutation (R2/R3) — UI updates immediately.
3. **Call the server** without blocking the UI.
4. **On failure**: restore the snapshot precisely and surface an error. Do **not**
   refetch a whole list — that loses scroll position and discards other pending
   optimistic state. A fake rollback is worse than an honest refetch: if you
   genuinely can't restore exactly, keep the refetch and comment why.
5. **On success**: do nothing further **unless the server produced state the
   client could not predict** (server-assigned id/timestamp, audit-trail entry,
   derived field). Refetch-on-success is a documented exception, not a habit —
   each one is a wasted round trip and a visible flash. Comment every exception
   with the reason.

Test: *could the client have computed this new state itself?* Yes → don't
refetch. No → refetch, and say so in a comment.
