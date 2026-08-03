// SPDX-License-Identifier: Apache-2.0
import { ORIGINS } from "$app/env/public";

/**
 * The canonical app origin — ORIGINS[0] by convention. Use it for absolute
 * links that leave the app (invite/verification emails); request-scoped URLs
 * should keep deriving from the request origin so multi-domain deployments
 * link each recipient to the host they use.
 */
export const canonicalOrigin = ORIGINS[0];
