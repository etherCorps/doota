// SPDX-License-Identifier: Apache-2.0
// Re-export of the shared, dependency-free helper so existing $lib/utils/try-catch
// imports keep working while the canonical implementation lives in @doota/utils
// (also usable from packages/*). Import from here or from @doota/utils/try-catch.
export { tryCatch, tryCatchSync, type Result } from "@doota/utils/try-catch";
