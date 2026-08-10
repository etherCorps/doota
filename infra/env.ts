// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import * as Redacted from "effect/Redacted";

/**
 * Deploy-time environment intake. Importing this module:
 *   1. loads infra/.env (gitignored; shell/CI-exported vars always win —
 *      loadEnvFile never overwrites existing process.env), and
 *   2. validates cross-var invariants (the VAPID pair).
 * Everything else here is pure helpers over process.env.
 */

const envFilePath = fileURLToPath(new URL("./.env", import.meta.url));
try {
  process.loadEnvFile(envFilePath);
} catch {
  // No infra/.env — fall back to whatever the shell/CI exported.
}

// SETUP_TOKEN is required from the deployer (the app hard-requires it at
// boot in production; the first admin is created with it). Fail the deploy,
// not the running worker.
if (!process.env.SETUP_TOKEN || process.env.SETUP_TOKEN.length < 8) {
  throw new Error(
    "SETUP_TOKEN is required (min 8 chars) — the deployer defines it and uses it at /setup to create the first admin. Set it in infra/.env (or CI secrets).",
  );
}

// VAPID halves come in pairs, and a mismatched pair breaks push silently, so
// providing exactly one is a hard error (both or neither; neither → minted
// into stack state, see secrets.ts).
if (!process.env.VAPID_PUBLIC_KEY !== !process.env.VAPID_PRIVATE_KEY) {
  throw new Error(
    "Only one of VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY is set — provide both or neither (keys come in pairs; scripts/gen-vapid-keys.mjs).",
  );
}

/** Optional secret/var: bound only when present in the deploy environment. */
export const optionalSecret = (envVarName: string) =>
  process.env[envVarName] ? { [envVarName]: Redacted.make(process.env[envVarName]!) } : {};
export const optionalVar = (envVarName: string) =>
  process.env[envVarName] ? { [envVarName]: process.env[envVarName]! } : {};

// Custom domains come from ORIGINS in the deploy env, never hardcoded:
// comma-separated full origins with protocol (the app-wide standard; the
// same list feeds better-auth's allowed hosts). First entry is canonical,
// the rest become aliases; unset → no custom domain, the app answers on
// workers.dev.
//
// Normalize before anything consumes it: a bare hostname gets https://
// prepended. The app validates each entry as a URL at boot, so shipping a
// protocol-less value would deploy a 500ing worker.
const normalizedOrigins = (process.env.ORIGINS ?? "")
  .split(",")
  .map((originValue) => originValue.trim())
  .filter(Boolean)
  .map((originValue) => (originValue.includes("://") ? originValue : `https://${originValue}`));
for (const originValue of normalizedOrigins) {
  try {
    new URL(originValue);
  } catch {
    throw new Error(`ORIGINS entry is not a valid URL: "${originValue}" — use full origins like https://mail.example.com`);
  }
}
/** The ORIGINS value bound to the web Worker (undefined when unset). */
export const originsValue = normalizedOrigins.length ? normalizedOrigins.join(",") : undefined;
// The Cloudflare custom-domain attachment wants hostnames — each hostname's
// zone must already exist in the account.
const customDomains = normalizedOrigins.map((originValue) => new URL(originValue).hostname);
export const [canonicalDomain, ...aliasDomains] = customDomains;
