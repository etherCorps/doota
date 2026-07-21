#!/usr/bin/env node
/**
 * Email-free super-admin genesis AND recovery — the guaranteed floor that works
 * with no web layer and no mail. Deploy access (running this) is the trust root.
 *
 * Two modes, auto-detected by whether the super-admin already exists:
 *
 *   GENESIS  (no super-admin yet): creates the first super-admin with a password
 *            and enrolls TOTP. Prints the otpauth:// URI + backup codes for you
 *            to scan into an authenticator. NO email is sent.
 *
 *   RESET    (super-admin exists): resets the password; optional --clear-2fa.
 *
 * Usage:
 *   pnpm reset-admin <superadmin-email> <new-password> [--remote] [--clear-2fa] [--name "Full Name"]
 *
 * --remote     run against the production D1 database (default: local)
 * --clear-2fa  (reset only) remove TOTP + backup codes (only if authenticator
 *              AND backup codes are lost; prefer backup codes otherwise)
 * --name       (genesis only) display name; defaults to the email's local part
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hashPassword, generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const positionals = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    if (args[i] === "--name") i++; // skip its value
    continue;
  }
  positionals.push(args[i]);
}
const [email, password] = positionals;

if (!email || !password) {
  console.error(
    'Usage: pnpm reset-admin <superadmin-email> <new-password> [--remote] [--clear-2fa] [--name "Full Name"]',
  );
  process.exit(1);
}
if (email.includes("'") || password.length < 8) {
  console.error("Invalid email, or password shorter than 8 characters.");
  process.exit(1);
}

const target = flag("--remote") ? "--remote" : "--local";

/** Load BETTER_AUTH_SECRET (needed to encrypt the TOTP secret the way the app does). */
function betterAuthSecret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(/^\s*BETTER_AUTH_SECRET\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1];
  } catch {
    // fall through
  }
  console.error("BETTER_AUTH_SECRET is not set (env or .env). Cannot enroll TOTP.");
  process.exit(1);
}

/** Run one or more SQL statements against D1; returns parsed JSON when asked. */
function d1(sql, { json = false } = {}) {
  const out = execFileSync(
    "pnpm",
    [
      "wrangler",
      "d1",
      "execute",
      "doota",
      target,
      ...(json ? ["--json"] : []),
      "--command",
      sql,
    ],
    { encoding: "utf8", stdio: json ? ["ignore", "pipe", "inherit"] : "inherit" },
  );
  if (!json) return null;
  // wrangler may print a banner before the JSON array — grab from the first '['.
  const start = out.indexOf("[");
  return start === -1 ? [] : JSON.parse(out.slice(start));
}

const esc = (s) => String(s).replace(/'/g, "''");

// Does a user with this email already exist, and is it a super-admin?
const rows = d1(`SELECT id, role FROM user WHERE email = '${esc(email)}';`, {
  json: true,
});
const existing = rows?.[0]?.results?.[0];

if (existing) {
  if (existing.role !== "superadmin") {
    console.error(`A non-superadmin user already uses ${email}. Refusing to touch it.`);
    process.exit(1);
  }
  // ---- RESET ----
  const hash = await hashPassword(password);
  const userSelect = `SELECT id FROM user WHERE email = '${esc(email)}' AND role = 'superadmin'`;
  const statements = [
    `UPDATE account SET password = '${hash}', updated_at = (cast(unixepoch('subsecond') * 1000 as integer)) WHERE provider_id = 'credential' AND user_id = (${userSelect});`,
  ];
  if (flag("--clear-2fa")) {
    statements.push(
      `DELETE FROM two_factor WHERE user_id = (${userSelect});`,
      `UPDATE user SET two_factor_enabled = 0 WHERE email = '${esc(email)}' AND role = 'superadmin';`,
    );
  }
  d1(statements.join(" "));
  console.log(
    `\nDone. Password reset for superadmin ${email}${flag("--clear-2fa") ? " (2FA cleared)" : ""}.`,
  );
  process.exit(0);
}

// ---- GENESIS ----
const secret = betterAuthSecret();
const now = Date.now();
const userId = randomUUID();
const name = opt("--name") || email.split("@")[0];
const hash = await hashPassword(password);

// TOTP: mirror better-auth's twoFactor enable — store an ENCRYPTED secret, and
// build the same otpauth URI from the raw secret so scanning matches verify().
const totpSecret = generateRandomString(32);
const encryptedSecret = await symmetricEncrypt({ key: secret, data: totpSecret });
const backupCodes = Array.from({ length: 10 }, () => {
  const c = generateRandomString(10, "a-z", "0-9", "A-Z");
  return `${c.slice(0, 5)}-${c.slice(5)}`;
});
const encryptedBackup = await symmetricEncrypt({ key: secret, data: JSON.stringify(backupCodes) });
const totpURI = createOTP(totpSecret, { digits: 6 }).url("Doota", email);

const statements = [
  `INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at)
   VALUES ('${userId}', '${esc(name)}', '${esc(email)}', 0, 'superadmin', 1, ${now}, ${now});`,
  `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
   VALUES ('${randomUUID()}', '${userId}', 'credential', '${userId}', '${hash}', ${now}, ${now});`,
  `INSERT INTO two_factor (id, secret, backup_codes, user_id, verified)
   VALUES ('${randomUUID()}', '${encryptedSecret}', '${encryptedBackup}', '${userId}', 1);`,
];

d1(statements.join(" "));

console.log(`\n✅ Super-admin created: ${email} (email NOT verified — email-free genesis).`);
console.log("\nScan this into your authenticator app (TOTP):\n");
console.log("  " + totpURI + "\n");
console.log("Backup codes (store safely — each works once):");
for (const code of backupCodes) console.log("  " + code);
console.log("\nNext: log in with your email + password + a 6-digit code.");
