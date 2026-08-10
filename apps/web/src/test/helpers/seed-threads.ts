// SPDX-License-Identifier: Apache-2.0
// Reusable mailbox seeder for tests that need real thread rows in the DB.
// Factors out the materialize+deliver pattern from search-index.test.ts so
// multiple test files can seed without duplicating ingest logic.
import * as schema from "@doota/db/schema";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import type { ContentKey } from "@doota/mail-core/crypto";

const ORG_ID = "org_seed";

/** Insert the minimal org + mailbox rows needed for materialize to work. */
async function seedOrg(db: any, mailboxId: string): Promise<void> {
  await db.insert(schema.organization).values({
    id: ORG_ID, name: "Seed Org", slug: "seed-org", domain: "seed.test",
    status: "active", createdAt: new Date(),
  });
  await db.insert(schema.orgMailSettings).values({
    orgId: ORG_ID, subaddressingEnabled: false, routingSubdomains: "[]",
  });
  await db.insert(schema.mailbox).values({
    id: mailboxId, orgId: ORG_ID, localPart: "user",
    address: "user@seed.test", isActive: true, isPersonal: true,
  });
  invalidateDomainCache();
}

/**
 * Seeds `count` independent threads into a fresh mailbox and returns the
 * mailboxId + ordered threadIds. Each thread gets one message delivered to the
 * mailbox. Inserts the org/mailbox rows itself (expects a blank DB).
 */
export async function seedMailboxWithThreads(
  db: any,
  ck: ContentKey,
  count: number,
): Promise<{ mailboxId: string; threadIds: string[] }> {
  const mailboxId = "mb_seeded";
  await seedOrg(db, mailboxId);

  const deps = { ck, searchKeyB64: "" }; // searchKeyB64 empty → no FTS index written
  const threadIds: string[] = [];

  for (let messageIndex = 0; messageIndex < count; messageIndex++) {
    const msgHeaderId = `<seed-${messageIndex}@seed.test>`;
    const sentAt = Date.now() + messageIndex * 1000;
    const pm: ParsedMessage = {
      messageIdHeader: msgHeaderId,
      inReplyTo: null,
      references: null,
      from: "sender@external.test",
      subject: `Seed thread ${messageIndex}`,
      sentAt,
      text: `Body of seed thread ${messageIndex}.`,
      html: null,
      r2RawKey: `raw/${ORG_ID}/seed-${messageIndex}`,
      attachments: [],
    };
    const { messageId, threadId } = await materializeMessage(db, ORG_ID, pm, deps, false);
    await materializeDelivery(db, {
      orgId: ORG_ID, messageId, threadId, mailboxId,
      role: "to", viaAliasId: null, subaddressTag: null, sentAt,
    });
    threadIds.push(threadId);
  }

  return { mailboxId, threadIds };
}
