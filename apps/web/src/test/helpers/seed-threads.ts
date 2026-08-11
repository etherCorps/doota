// SPDX-License-Identifier: Apache-2.0
// Reusable mailbox seeder for tests that need real thread rows in the DB.
// Factors out the materialize+deliver pattern from search-index.test.ts so
// multiple test files can seed without duplicating ingest logic.
import * as schema from "@doota/db/schema";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "@doota/mail-core/materialize";
import { putEncryptedBlob, encryptContent, type ContentKey, type R2Like } from "@doota/mail-core/crypto";
import * as mailSchema from "@doota/db/mail.schema";

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

/**
 * Seeds one thread containing two messages into a fresh mailbox:
 *   1. A rich-HTML message (htmlKind='rich', R2 raw populated in `bucket`)
 *   2. A plain-text message (htmlKind='plain', no HTML part)
 *
 * Returns the mailboxId, threadId, the two messageIds, and the fake R2 bucket
 * so callers can pass it to renderFramedBody / buildSeedThread.
 *
 * The bucket is a simple in-memory Map that satisfies `R2Like`. The rich raw
 * is written via `putEncryptedBlob` so `getDecryptedBlob` in renderFramedBody
 * can decrypt it correctly.
 */
export async function seedThreadWithRichAndPlainMessage(
  db: any,
  ck: ContentKey,
): Promise<{
  mailboxId: string;
  threadId: string;
  richMessageId: string;
  plainMessageId: string;
  bucket: R2Like;
}> {
  const mailboxId = "mb_rich";
  await seedOrg(db, mailboxId);
  const deps = { ck, searchKeyB64: "" };

  // Minimal RFC822 MIME message with a text/html part that PostalMime parses.
  // Must trigger isRichHtml (table/style/img) so materializeMessage sets htmlKind='rich'.
  const richHtmlBody = '<table><tr><td style="font-size:14px">Hello <strong>rich</strong> world</td></tr></table>';
  const rawMime =
    "From: sender@external.test\r\n" +
    "To: user@seed.test\r\n" +
    "Subject: Rich HTML message\r\n" +
    "MIME-Version: 1.0\r\n" +
    "Content-Type: text/html; charset=utf-8\r\n" +
    "\r\n" +
    richHtmlBody;
  const rawMimeBytes = new TextEncoder().encode(rawMime);

  // Build a fake R2 bucket backed by an in-memory Map.
  const store = new Map<string, Uint8Array>();
  const bucket: R2Like = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      store.set(key, new Uint8Array(value as ArrayBuffer));
    },
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return { arrayBuffer: async () => data.buffer as ArrayBuffer };
    },
  };

  const richR2Key = `raw/${ORG_ID}/rich-msg`;
  await putEncryptedBlob(bucket, richR2Key, ck, rawMimeBytes);

  const sentAt1 = Date.now();
  const pmRich: ParsedMessage = {
    messageIdHeader: "<rich@seed.test>",
    inReplyTo: null,
    references: null,
    from: "sender@external.test",
    subject: "Rich HTML message",
    sentAt: sentAt1,
    text: null,
    html: richHtmlBody,
    r2RawKey: richR2Key,
    attachments: [],
  };
  const { messageId: richMessageId, threadId } = await materializeMessage(db, ORG_ID, pmRich, deps, false);
  await materializeDelivery(db, {
    orgId: ORG_ID, messageId: richMessageId, threadId, mailboxId,
    role: "to", viaAliasId: null, subaddressTag: null, sentAt: sentAt1,
  });

  const sentAt2 = sentAt1 + 1000;
  const pmPlain: ParsedMessage = {
    messageIdHeader: "<plain@seed.test>",
    inReplyTo: "<rich@seed.test>",
    references: "<rich@seed.test>",
    from: "user@seed.test",
    subject: "Re: Rich HTML message",
    sentAt: sentAt2,
    text: "Plain reply body.",
    html: null,
    r2RawKey: `raw/${ORG_ID}/plain-msg`,
    attachments: [],
  };
  const { messageId: plainMessageId } = await materializeMessage(db, ORG_ID, pmPlain, deps, false);
  await materializeDelivery(db, {
    orgId: ORG_ID, messageId: plainMessageId, threadId, mailboxId,
    role: "to", viaAliasId: null, subaddressTag: null, sentAt: sentAt2,
  });

  return { mailboxId, threadId, richMessageId, plainMessageId, bucket };
}

/**
 * Seeds one thread with: a rich message, a plain message, and an internal note.
 * Used by slice-3 tests that assert `buildSeedThread` returns the full timeline.
 *
 * Uses mailboxId "mb_note" (distinct from the "mb_rich" mailbox so tests can
 * run against a blank DB). authorUserId is "u1" (no FK in test schema).
 */
export async function seedThreadWithRichNoteAndPlainMessage(
  db: any,
  ck: ContentKey,
): Promise<{
  mailboxId: string;
  threadId: string;
  richMessageId: string;
  plainMessageId: string;
  noteId: string;
  bucket: R2Like;
}> {
  const mailboxId = "mb_note";
  await seedOrg(db, mailboxId);
  const deps = { ck, searchKeyB64: "" };

  const richHtmlBody = '<table><tr><td style="font-size:14px">Hello <strong>rich</strong> world</td></tr></table>';
  const rawMime =
    "From: sender@external.test\r\n" +
    "To: user@seed.test\r\n" +
    "Subject: Rich HTML message\r\n" +
    "MIME-Version: 1.0\r\n" +
    "Content-Type: text/html; charset=utf-8\r\n" +
    "\r\n" +
    richHtmlBody;
  const rawMimeBytes = new TextEncoder().encode(rawMime);

  const store = new Map<string, Uint8Array>();
  const bucket: R2Like = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      store.set(key, new Uint8Array(value as ArrayBuffer));
    },
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return { arrayBuffer: async () => data.buffer as ArrayBuffer };
    },
  };

  const richR2Key = `raw/${ORG_ID}/note-thread-rich`;
  await putEncryptedBlob(bucket, richR2Key, ck, rawMimeBytes);

  const sentAt1 = Date.now();
  const pmRich: ParsedMessage = {
    messageIdHeader: "<rich-note@seed.test>",
    inReplyTo: null,
    references: null,
    from: "sender@external.test",
    subject: "Rich HTML message with note",
    sentAt: sentAt1,
    text: null,
    html: richHtmlBody,
    r2RawKey: richR2Key,
    attachments: [],
  };
  const { messageId: richMessageId, threadId } = await materializeMessage(db, ORG_ID, pmRich, deps, false);
  await materializeDelivery(db, {
    orgId: ORG_ID, messageId: richMessageId, threadId, mailboxId,
    role: "to", viaAliasId: null, subaddressTag: null, sentAt: sentAt1,
  });

  // Add a user row required by the author_user_id FK on internal_note.
  await db.insert(schema.user).values({ id: "u1", name: "Test User", email: "u1@seed.test", emailVerified: false }).onConflictDoNothing();

  // Insert note directly (bypasses createNote's FTS index which requires a valid search key).
  // ponytail: direct insert avoids the search-key-required path; tests only need the row in getThread.
  const bodyEnc = await encryptContent(ck, "This is a test note.");
  const noteRows = await db
    .insert(mailSchema.internalNote)
    .values({ orgId: ORG_ID, threadId, mailboxId, authorUserId: "u1", bodyEnc })
    .returning({ id: mailSchema.internalNote.id });
  const noteId = noteRows[0].id;

  const sentAt2 = sentAt1 + 2000;
  const pmPlain: ParsedMessage = {
    messageIdHeader: "<plain-note@seed.test>",
    inReplyTo: "<rich-note@seed.test>",
    references: "<rich-note@seed.test>",
    from: "user@seed.test",
    subject: "Re: Rich HTML message with note",
    sentAt: sentAt2,
    text: "Plain reply body.",
    html: null,
    r2RawKey: `raw/${ORG_ID}/note-thread-plain`,
    attachments: [],
  };
  const { messageId: plainMessageId } = await materializeMessage(db, ORG_ID, pmPlain, deps, false);
  await materializeDelivery(db, {
    orgId: ORG_ID, messageId: plainMessageId, threadId, mailboxId,
    role: "to", viaAliasId: null, subaddressTag: null, sentAt: sentAt2,
  });

  return { mailboxId, threadId, richMessageId, plainMessageId, noteId, bucket };
}
