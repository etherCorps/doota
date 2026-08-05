// SPDX-License-Identifier: Apache-2.0
// Re-export the single SSRF implementation from mail-core so the web app and the
// delivery worker share one validator (cross-cutting guard: one place).
export { isBlockedHost, validateWebhookUrl } from "@doota/mail-core/ssrf";
