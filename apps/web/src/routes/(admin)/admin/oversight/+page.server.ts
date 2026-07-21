import { redirect } from "@sveltejs/kit";
import { desc, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey, decryptContent } from "@doota/mail-core/crypto";

/**
 * Super-admin oversight: read-only recent mail across every org. Content is
 * zero-access at rest but operator oversight is intended (crypto.ts), so the
 * subject is decrypted here with the instance DEK. Routing metadata (from,
 * domain, time) is cleartext. No mailbox scoping — this is the platform view.
 */
export const load = async ({ locals, platform }) => {
  if (locals.user?.role !== "superadmin") redirect(302, "/admin");

  const messages = await locals.db
    .select({
      id: schema.message.id,
      orgId: schema.message.orgId,
      threadId: schema.message.threadId,
      fromAddr: schema.message.fromAddr,
      sentAt: schema.message.sentAt,
      subjectEnc: schema.message.subjectEnc,
    })
    .from(schema.message)
    .orderBy(desc(schema.message.sentAt))
    .limit(50);

  if (!messages.length) return { rows: [] };

  const orgIds = [...new Set(messages.map((m) => m.orgId))];
  const orgs = await locals.db
    .select({ id: schema.organization.id, domain: schema.organization.domain })
    .from(schema.organization)
    .where(inArray(schema.organization.id, orgIds));
  const domainOf = new Map(orgs.map((o) => [o.id, o.domain]));

  const dek = platform?.env?.MAIL_DEK;
  const ck = dek ? await importKey(dek) : null;

  const rows = await Promise.all(
    messages.map(async (m) => ({
      id: m.id,
      domain: domainOf.get(m.orgId) ?? "—",
      from: m.fromAddr,
      subject: ck ? await decryptContent(ck, m.subjectEnc) : null,
      at: m.sentAt ? m.sentAt.getTime() : null,
    })),
  );

  return { rows };
};
