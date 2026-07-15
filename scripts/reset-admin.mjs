#!/usr/bin/env node
/**
 * Super-admin recovery with NO email dependency — the last escape hatch
 * when the mail system itself is down and the super-admin is locked out.
 *
 * Usage:
 *   pnpm reset-admin <superadmin-email> <new-password> [--remote] [--clear-2fa]
 *
 * --remote     run against the production D1 database (default: local)
 * --clear-2fa  also remove TOTP + backup codes (only if the authenticator
 *              AND backup codes are lost; prefer backup codes otherwise)
 */
import { hashPassword } from "better-auth/crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const [email, password] = args.filter((a) => !a.startsWith("--"));

if (!email || !password) {
  console.error("Usage: pnpm reset-admin <superadmin-email> <new-password> [--remote] [--clear-2fa]");
  process.exit(1);
}
if (email.includes("'") || password.length < 8) {
  console.error("Invalid email, or password shorter than 8 characters.");
  process.exit(1);
}

const hash = await hashPassword(password);
const target = flags.includes("--remote") ? "--remote" : "--local";
const userSelect = `SELECT id FROM user WHERE email = '${email}' AND role = 'superadmin'`;

const statements = [
  `UPDATE account SET password = '${hash}', updated_at = (cast(unixepoch('subsecond') * 1000 as integer)) WHERE provider_id = 'credential' AND user_id = (${userSelect});`,
];
if (flags.includes("--clear-2fa")) {
  statements.push(
    `DELETE FROM two_factor WHERE user_id = (${userSelect});`,
    `UPDATE user SET two_factor_enabled = 0 WHERE email = '${email}' AND role = 'superadmin';`,
  );
}

execFileSync(
  "pnpm",
  ["wrangler", "d1", "execute", "doota", target, "--command", statements.join(" ")],
  { stdio: "inherit" },
);

console.log(`\nDone. Password reset for superadmin ${email}${flags.includes("--clear-2fa") ? " (2FA cleared)" : ""}.`);
console.log("If no rows changed, the email is not a superadmin account.");
