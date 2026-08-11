// SPDX-License-Identifier: Apache-2.0
// Client-safe constants shared between the server seed path (thread-localdb.ts)
// and the client inbox (+page.svelte). Kept in its own module with NO server
// imports so the client bundle never pulls in server-only code (framed-body,
// R2, the sanitizer) — importing a value from thread-localdb.ts would.

/** Max threads seeded into the local mirror per mailbox. Above this the inbox
 *  falls back to remote pagination instead of driving the list from the mirror. */
export const SEED_THREAD_LIMIT = 1000;
