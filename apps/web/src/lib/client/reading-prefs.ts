// SPDX-License-Identifier: Apache-2.0
// Reading/display preferences — device-local, localStorage-backed (runed
// PersistedState), matching the thread-view toggle's pattern rather than a
// server RPC. One shared instance so the settings card and the thread view
// react to the same state.
import { PersistedState } from "runed";

/** Render `-- ` signatures expanded in the thread view instead of collapsing
 * them behind the per-message "···" control. Default off (collapsed). */
export const showSignatures = new PersistedState<boolean>("doota:show-signatures", false);
