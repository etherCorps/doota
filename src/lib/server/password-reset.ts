import { and, eq, gt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { sendMail } from "./mailer";
import { senderAddress, domainOf } from "./org-domains";
import type { Auth } from "./auth";

type AuthContext = Awaited<Auth["$context"]>;
type Db = DrizzleD1Database<typeof schema>;

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const THROTTLE_MS = 60_000; // one request per minute

type ResetUser = {
  id: string;
  email: string;
  role?: string | null;
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean | null;
};

/**
 * External address the reset code is sent to (same invariant as the logged-out
 * flow): super-admin → their external primary email; everyone else → their
 * VERIFIED recovery email. Never a served-domain inbox. null = no valid target.
 */
export function resetTarget(user: ResetUser): string | null {
  if (user.role === "superadmin") return user.email;
  return user.recoveryEmail && user.recoveryEmailVerified
    ? user.recoveryEmail
    : null;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Issues a 6-digit code, stores it, and mails it to the reset target. */
export async function sendPasswordResetCode(
  ctx: AuthContext,
  db: Db,
  user: ResetUser,
): Promise<{ ok: boolean; message: string }> {
  const to = resetTarget(user);
  if (!to) {
    return {
      ok: false,
      message: "No verified recovery email on file to send a code to.",
    };
  }

  const now = Date.now();
  const throttleId = `pwreset-throttle:${user.id}`;
  const recent = await db.query.verification.findFirst({
    where: and(
      eq(schema.verification.identifier, throttleId),
      gt(schema.verification.expiresAt, new Date(now)),
    ),
  });
  if (recent) {
    return {
      ok: false,
      message: "Please wait a minute before requesting another code.",
    };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeId = `pwreset:${user.id}`;
  // One active code per user: drop any previous one before issuing.
  await db
    .delete(schema.verification)
    .where(eq(schema.verification.identifier, codeId));
  await ctx.internalAdapter.createVerificationValue({
    identifier: codeId,
    value: code,
    expiresAt: new Date(now + CODE_TTL_MS),
  });
  await db.insert(schema.verification).values({
    id: crypto.randomUUID(),
    identifier: throttleId,
    value: "1",
    expiresAt: new Date(now + THROTTLE_MS),
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });

  const fromDomain = user.role === "superadmin" ? undefined : domainOf(user.email);
  const from = await senderAddress(db, fromDomain);
  await sendMail({
    to,
    from,
    subject: "Your Doota password reset code",
    text: `Your Doota password reset code is ${code}\nIt expires in 10 minutes. If you didn't request this, ignore this email and your password stays unchanged.`,
  });

  return { ok: true, message: `Code sent to ${maskEmail(to)}.` };
}

/** Checks the submitted code and consumes it on success. */
export async function confirmPasswordResetCode(
  db: Db,
  userId: string,
  code: string,
): Promise<boolean> {
  const rec = await db.query.verification.findFirst({
    where: and(
      eq(schema.verification.identifier, `pwreset:${userId}`),
      gt(schema.verification.expiresAt, new Date()),
    ),
  });
  // Wrong code leaves the record so the user can retry within the TTL; the
  // per-minute request throttle bounds brute-force attempts.
  if (!rec || rec.value !== code) return false;
  await db.delete(schema.verification).where(eq(schema.verification.id, rec.id));
  return true;
}
