// SPDX-License-Identifier: Apache-2.0
import { createAvatar } from "@dicebear/core";
import { adventurer } from "@dicebear/collection";

/**
 * Locally generated DiceBear avatars for external senders. Generated in the
 * browser on purpose: using dicebear's HTTP API would leak every sender
 * address to a third party. Both caches are module-level (session-lifetime):
 * one for generated data URIs, one remembering which addresses have no
 * server-side avatar so later rows skip the 404 round-trip entirely.
 *
 * Style is `glass`, deliberately not `thumbs`: provisioning seeds our users'
 * profile images with thumbs (utils/dice-bear.ts), so externals get a distinct
 * look: abstract tiles for strangers, faces for teammates.
 */
const diceCache = new Map<string, string>();

/** Addresses that 404'd on /api/sender-avatar — skip the request next time. */
export const noServerAvatar = new Set<string>();

export function dicebearFor(seed: string): string {
  let uri = diceCache.get(seed);
  if (!uri) {
    uri = createAvatar(adventurer, { seed }).toDataUri();
    diceCache.set(seed, uri);
  }
  return uri;
}
