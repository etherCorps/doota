// SPDX-License-Identifier: Apache-2.0
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { error } from "@sveltejs/kit";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import { decryptContent, encryptContent, type ContentKey } from "./crypto";
import { indexNote, deleteNoteIndex, tokensFor } from "./search";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Internal notes (Task 5). A note is team-internal thread context — it NEVER
 * touches messages, deliveries, submissions, or placement. It cannot enter the
 * outbound path: the outbound worker only sources `message`/`draft` rows, and a
 * note is a row in its own table that nothing in that path reads (structural
 * guarantee of the sibling-table model). Bodies are encrypted (crypto.ts).
 */

export type NoteDTO = {
  id: string;
  threadId: string;
  mailboxId: string;
  authorUserId: string | null;
  body: string | null; // null when deleted (tombstone)
  editedAt: number | null;
  deleted: boolean;
  createdAt: number;
};

async function toDTO(ck: ContentKey, row: typeof schema.internalNote.$inferSelect): Promise<NoteDTO> {
  const deleted = row.deletedAt != null;
  return {
    id: row.id,
    threadId: row.threadId,
    mailboxId: row.mailboxId,
    authorUserId: row.authorUserId,
    body: deleted ? null : await decryptContent(ck, row.bodyEnc),
    editedAt: row.editedAt ? row.editedAt.getTime() : null,
    deleted,
    createdAt: row.createdAt.getTime(),
  };
}

/** Create a note on a thread within a mailbox, and index it for search. */
export async function createNote(
  db: Db,
  ck: ContentKey,
  searchKeyB64: string,
  input: { orgId: string; threadId: string; mailboxId: string; authorUserId: string; body: string },
): Promise<NoteDTO> {
  const bodyEnc = await encryptContent(ck, input.body);
  const inserted = await db
    .insert(mail.internalNote)
    .values({
      orgId: input.orgId,
      threadId: input.threadId,
      mailboxId: input.mailboxId,
      authorUserId: input.authorUserId,
      bodyEnc,
    })
    .returning();
  const row = inserted[0];
  await indexNote(db, {
    noteId: row.id,
    mailboxId: input.mailboxId,
    orgId: input.orgId,
    tokens: await tokensFor(searchKeyB64, [input.body]),
  });
  return toDTO(ck, row);
}

async function ownNote(db: Db, noteId: string, userId: string) {
  const row = await db.query.internalNote.findFirst({ where: eq(schema.internalNote.id, noteId) });
  if (!row) error(404, "Note not found");
  if (row.authorUserId !== userId) error(403, "Only the author can change this note.");
  if (row.deletedAt) error(409, "This note was deleted.");
  return row;
}

/** Edit a note (author only). Re-indexes for search; stamps edited_at. */
export async function editNote(
  db: Db,
  ck: ContentKey,
  searchKeyB64: string,
  input: { noteId: string; userId: string; body: string },
): Promise<NoteDTO> {
  const row = await ownNote(db, input.noteId, input.userId);
  const bodyEnc = await encryptContent(ck, input.body);
  await db
    .update(mail.internalNote)
    .set({ bodyEnc, editedAt: new Date() })
    .where(eq(mail.internalNote.id, input.noteId));
  await indexNote(db, {
    noteId: row.id,
    mailboxId: row.mailboxId,
    orgId: row.orgId,
    tokens: await tokensFor(searchKeyB64, [input.body]),
  });
  return getNote(db, ck, input.noteId);
}

/** Soft-delete a note (author only): tombstone stays in the timeline; the body
 * is cleared and the search index entry removed (not searchable). */
export async function softDeleteNote(
  db: Db,
  input: { noteId: string; userId: string },
): Promise<void> {
  await ownNote(db, input.noteId, input.userId);
  await db
    .update(mail.internalNote)
    .set({ deletedAt: new Date(), bodyEnc: null })
    .where(eq(mail.internalNote.id, input.noteId));
  await deleteNoteIndex(db, input.noteId);
}

async function getNote(db: Db, ck: ContentKey, noteId: string): Promise<NoteDTO> {
  const row = await db.query.internalNote.findFirst({ where: eq(schema.internalNote.id, noteId) });
  if (!row) error(404, "Note not found");
  return toDTO(ck, row);
}

/** All notes on a thread for a mailbox (including tombstones), oldest first. */
export async function listNotes(
  db: Db,
  ck: ContentKey,
  threadId: string,
  mailboxId: string,
): Promise<NoteDTO[]> {
  const rows = await db.query.internalNote.findMany({
    where: and(
      eq(schema.internalNote.threadId, threadId),
      eq(schema.internalNote.mailboxId, mailboxId),
    ),
    orderBy: schema.internalNote.createdAt,
  });
  return Promise.all(rows.map((r) => toDTO(ck, r)));
}

/** Whether a thread has any live (non-deleted) note for a mailbox — list badge. */
export async function threadHasNotes(db: Db, threadId: string, mailboxId: string): Promise<boolean> {
  const row = await db.query.internalNote.findFirst({
    where: and(
      eq(schema.internalNote.threadId, threadId),
      eq(schema.internalNote.mailboxId, mailboxId),
      isNull(schema.internalNote.deletedAt),
    ),
    columns: { id: true },
  });
  return !!row;
}
