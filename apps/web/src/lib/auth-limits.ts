// SPDX-License-Identifier: Apache-2.0
/**
 * Device-session cap (better-auth multiSession, shared by server config and
 * client UI). Past the cap the plugin SILENTLY skips tracking the new sign-in
 * — the account works until you switch away, then it vanishes from the device
 * list — so the switcher and the add-account page must block at the limit
 * with a reason instead of ever letting a sign-in hit that path.
 */
export const MAX_DEVICE_SESSIONS = 5;
