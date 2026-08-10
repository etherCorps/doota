// SPDX-License-Identifier: Apache-2.0
import type { ThreadSummary } from "@doota/mail-core/read";

/** A mirrored thread-list row: ThreadSummary + owning mailbox. JSON arrays are
 *  stored as TEXT so the row is a flat bind object. */
export type ThreadRow = {
  $mailbox_id: string;
  $thread_id: string;
  $placement: string;
  $subject: string | null;
  $snippet: string | null;
  $from_addr: string | null;
  $from_name: string | null;
  $participants: string;      // JSON string[]
  $participant_count: number;
  $last_message_at: number | null;
  $is_starred: number;        // 0 | 1
  $unread: number;            // 0 | 1
  $has_notes: number;         // 0 | 1
  $assignee_user_id: string | null;
  $pinned_at: number | null;
};

export const DDL = `
CREATE TABLE IF NOT EXISTS thread_list (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  placement TEXT NOT NULL,
  subject TEXT, snippet TEXT, from_addr TEXT, from_name TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  participant_count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  is_starred INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  has_notes INTEGER NOT NULL DEFAULT 0,
  assignee_user_id TEXT,
  pinned_at INTEGER,
  PRIMARY KEY (mailbox_id, thread_id)
);
CREATE INDEX IF NOT EXISTS thread_list_view ON thread_list (mailbox_id, placement, last_message_at);
CREATE TABLE IF NOT EXISTS sync_state (mailbox_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
`;

export const upsertThreadSql = () => ({
  sql: `INSERT INTO thread_list
    (mailbox_id, thread_id, placement, subject, snippet, from_addr, from_name,
     participants, participant_count, last_message_at, is_starred, unread, has_notes,
     assignee_user_id, pinned_at)
    VALUES ($mailbox_id,$thread_id,$placement,$subject,$snippet,$from_addr,$from_name,
     $participants,$participant_count,$last_message_at,$is_starred,$unread,$has_notes,
     $assignee_user_id,$pinned_at)
    ON CONFLICT(mailbox_id, thread_id) DO UPDATE SET
     placement=excluded.placement, subject=excluded.subject, snippet=excluded.snippet,
     from_addr=excluded.from_addr, from_name=excluded.from_name, participants=excluded.participants,
     participant_count=excluded.participant_count, last_message_at=excluded.last_message_at,
     is_starred=excluded.is_starred, unread=excluded.unread, has_notes=excluded.has_notes,
     assignee_user_id=excluded.assignee_user_id, pinned_at=excluded.pinned_at`,
});

export const deleteThreadSql = () => ({
  sql: `DELETE FROM thread_list WHERE mailbox_id=$mailbox_id AND thread_id=$thread_id`,
});

export const listThreadsSql = () => ({
  sql: `SELECT * FROM thread_list WHERE mailbox_id=$mailbox_id AND placement=$placement
        ORDER BY (pinned_at IS NULL), pinned_at DESC, last_message_at DESC`,
});

export const getCursorSql = () => ({ sql: `SELECT cursor FROM sync_state WHERE mailbox_id=$mailbox_id` });
export const setCursorSql = () => ({
  sql: `INSERT INTO sync_state (mailbox_id, cursor) VALUES ($mailbox_id,$cursor)
        ON CONFLICT(mailbox_id) DO UPDATE SET cursor=excluded.cursor`,
});
export const clearMailboxSql = () => ({ sql: `DELETE FROM thread_list WHERE mailbox_id=$mailbox_id` });

export function threadSummaryToRow(mailboxId: string, summary: ThreadSummary): ThreadRow {
  return {
    $mailbox_id: mailboxId, $thread_id: summary.threadId, $placement: summary.placement,
    $subject: summary.subject, $snippet: summary.snippet, $from_addr: summary.from,
    $from_name: summary.fromName, $participants: JSON.stringify(summary.participants ?? []),
    $participant_count: summary.participantCount ?? 0, $last_message_at: summary.lastMessageAt,
    $is_starred: summary.isStarred ? 1 : 0, $unread: summary.unread ? 1 : 0,
    $has_notes: summary.hasNotes ? 1 : 0, $assignee_user_id: summary.assigneeUserId,
    $pinned_at: summary.pinnedAt,
  };
}

// Raw sqlite row (snake_case columns) → ThreadSummary.
export function rowToThreadSummary(row: Record<string, unknown>): ThreadSummary {
  return {
    threadId: row.thread_id as string, subject: (row.subject as string) ?? null,
    snippet: (row.snippet as string) ?? null, from: (row.from_addr as string) ?? null,
    fromName: (row.from_name as string) ?? null,
    participants: JSON.parse((row.participants as string) || "[]"),
    participantCount: (row.participant_count as number) ?? 0,
    lastMessageAt: (row.last_message_at as number) ?? null,
    isStarred: !!row.is_starred, unread: !!row.unread, hasNotes: !!row.has_notes,
    assigneeUserId: (row.assignee_user_id as string) ?? null,
    placement: row.placement as string, pinnedAt: (row.pinned_at as number) ?? null,
  };
}
