// SPDX-License-Identifier: Apache-2.0
import type { ThreadSummary } from "@doota/mail-core/read";
import type { MessageDTO } from "@doota/mail-core/mail-thread-contract";

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

/** A mirrored message row: typed columns for query/filter paths + meta_json for
 *  the long tail of MessageDTO fields the render layer needs but queries don't. */
export type MessageRow = {
  $thread_id: string;
  $message_id: string;
  $seq: number;
  $from_addr: string | null;
  $from_name: string | null;
  $sent_at: number | null;
  $item_type: string;            // external_message | note | system
  $content_kind: string;         // bubble | card
  $html_kind: string | null;     // rich | plain | null
  $body_text: string | null;     // bodyStripped / bodyFull for bubble render
  $framed_html: string | null;   // server-built framed doc (rich only; null for plain)
  $dmarc_pass: number;           // 0 | 1
  $has_remote_images: number;    // 0 | 1
  $is_read: number;              // 0 | 1
  $outbound: number;             // 0 | 1
  $meta_json: string;            // JSON: to, cc, replyTo, keywords, attachments, submission, replyContext, calendarInvite, senderTrusted, senderVerified, viaAlias, viaAliasId, subject, messageIdHeader
  $render_version: string | null;
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
CREATE TABLE IF NOT EXISTS message (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  from_addr TEXT, from_name TEXT,
  sent_at INTEGER,
  item_type TEXT NOT NULL DEFAULT 'external_message',
  content_kind TEXT NOT NULL DEFAULT 'bubble',
  html_kind TEXT,
  body_text TEXT,
  framed_html TEXT,
  dmarc_pass INTEGER NOT NULL DEFAULT 0,
  has_remote_images INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  outbound INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  render_version TEXT,
  PRIMARY KEY (thread_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_by_thread ON message (thread_id, seq);
CREATE TABLE IF NOT EXISTS thread_synced (
  thread_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  render_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_item (
  thread_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  framed_html TEXT,
  PRIMARY KEY (thread_id, item_id)
);
CREATE INDEX IF NOT EXISTS thread_item_order ON thread_item (thread_id, seq);
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

// ── Message SQL builders ──────────────────────────────────────────────────────

export const upsertMessageSql = () => ({
  sql: `INSERT INTO message
    (thread_id, message_id, seq, from_addr, from_name, sent_at, item_type, content_kind,
     html_kind, body_text, framed_html, dmarc_pass, has_remote_images, is_read, outbound,
     meta_json, render_version)
    VALUES ($thread_id,$message_id,$seq,$from_addr,$from_name,$sent_at,$item_type,$content_kind,
     $html_kind,$body_text,$framed_html,$dmarc_pass,$has_remote_images,$is_read,$outbound,
     $meta_json,$render_version)
    ON CONFLICT(thread_id, message_id) DO UPDATE SET
     seq=excluded.seq, from_addr=excluded.from_addr, from_name=excluded.from_name,
     sent_at=excluded.sent_at, item_type=excluded.item_type, content_kind=excluded.content_kind,
     html_kind=excluded.html_kind, body_text=excluded.body_text, framed_html=excluded.framed_html,
     dmarc_pass=excluded.dmarc_pass, has_remote_images=excluded.has_remote_images,
     is_read=excluded.is_read, outbound=excluded.outbound, meta_json=excluded.meta_json,
     render_version=excluded.render_version`,
});

export const deleteMessageSql = () => ({
  sql: `DELETE FROM message WHERE thread_id=$thread_id AND message_id=$message_id`,
});

export const listMessagesSql = () => ({
  sql: `SELECT * FROM message WHERE thread_id=$thread_id ORDER BY seq`,
});

export const clearThreadMessagesSql = () => ({
  sql: `DELETE FROM message WHERE thread_id=$thread_id`,
});

// ── thread_item SQL builders (slice 3: unified timeline mirror) ───────────────

/** Opaque union of all timeline item types. The mirror stores the full JSON. */
export type TimelineItem = { type: string; id: string; [key: string]: unknown };

export type ThreadItemRow = {
  $thread_id: string;
  $item_id: string;
  $seq: number;
  $item_type: string;
  $payload: string;       // JSON.stringify(item)
  $framed_html: string | null;
};

export const upsertThreadItemSql = () => ({
  sql: `INSERT INTO thread_item (thread_id, item_id, seq, item_type, payload, framed_html)
        VALUES ($thread_id,$item_id,$seq,$item_type,$payload,$framed_html)
        ON CONFLICT(thread_id, item_id) DO UPDATE SET
          seq=excluded.seq, item_type=excluded.item_type,
          payload=excluded.payload, framed_html=excluded.framed_html`,
});

export const deleteThreadItemSql = () => ({
  sql: `DELETE FROM thread_item WHERE thread_id=$thread_id AND item_id=$item_id`,
});

export const listThreadItemsSql = () => ({
  sql: `SELECT * FROM thread_item WHERE thread_id=$thread_id ORDER BY seq`,
});

export const clearThreadItemsSql = () => ({
  sql: `DELETE FROM thread_item WHERE thread_id=$thread_id`,
});

export function itemToRow(
  threadId: string,
  seq: number,
  item: TimelineItem,
  framedHtml: string | null,
): ThreadItemRow {
  return {
    $thread_id: threadId,
    $item_id: item.id,
    $seq: seq,
    $item_type: item.type,
    $payload: JSON.stringify(item),
    $framed_html: framedHtml,
  };
}

export function rowToItem(row: Record<string, unknown>): TimelineItem & { framedHtml?: string } {
  const item = JSON.parse(row.payload as string) as TimelineItem;
  return row.framed_html ? { ...item, framedHtml: row.framed_html as string } : item;
}

export const getThreadSyncSql = () => ({
  sql: `SELECT cursor, render_version FROM thread_synced WHERE thread_id=$thread_id`,
});

export const setThreadSyncSql = () => ({
  sql: `INSERT INTO thread_synced (thread_id, cursor, render_version)
        VALUES ($thread_id,$cursor,$render_version)
        ON CONFLICT(thread_id) DO UPDATE SET cursor=excluded.cursor, render_version=excluded.render_version`,
});

// ── MessageDTO ↔ MessageRow marshaling ───────────────────────────────────────

/** Fields stored as typed columns (query/filter paths); everything else goes into meta_json. */
export function messageDtoToRow(
  threadId: string,
  seq: number,
  dto: MessageDTO,
  framedHtml: string | null,
  renderVersion: string,
): MessageRow {
  // ponytail: meta_json carries the render tail; typed cols are only what queries touch
  const meta = {
    id: dto.id,
    to: dto.to,
    cc: dto.cc,
    replyTo: dto.replyTo,
    keywords: dto.keywords,
    attachments: dto.attachments,
    submission: dto.submission,
    replyContext: dto.replyContext,
    calendarInvite: dto.calendarInvite,
    senderTrusted: dto.senderTrusted,
    senderVerified: dto.senderVerified,
    viaAlias: dto.viaAlias,
    viaAliasId: dto.viaAliasId,
    subject: dto.subject,
    messageIdHeader: dto.messageIdHeader,
  };
  return {
    $thread_id: threadId,
    $message_id: dto.id,
    $seq: seq,
    $from_addr: dto.from,
    $from_name: dto.fromName,
    $sent_at: dto.sentAt,
    $item_type: dto.type,
    $content_kind: dto.contentKind,
    $html_kind: dto.htmlKind,
    // ponytail: rich cards use bodyFull; bubbles use bodyStripped (the reply quote strip)
    $body_text: dto.htmlKind === "rich" ? (dto.bodyFull ?? dto.bodyStripped ?? null) : (dto.bodyStripped ?? dto.bodyFull ?? null),
    $framed_html: dto.htmlKind === "rich" ? framedHtml : null,
    $dmarc_pass: dto.senderVerified ? 1 : 0,
    $has_remote_images: dto.hasRemoteImages ? 1 : 0,
    $is_read: dto.isRead ? 1 : 0,
    $outbound: dto.outbound ? 1 : 0,
    $meta_json: JSON.stringify(meta),
    $render_version: renderVersion,
  };
}

/** Raw sqlite row (snake_case columns) → MessageDTO. */
export function rowToMessageDto(row: Record<string, unknown>): MessageDTO {
  const meta = JSON.parse((row.meta_json as string) || "{}");
  return {
    type: "external_message",
    id: meta.id as string,
    threadId: row.thread_id as string,
    messageIdHeader: meta.messageIdHeader as string,
    from: (row.from_addr as string) ?? null,
    fromName: (row.from_name as string) ?? null,
    sentAt: (row.sent_at as number) ?? null,
    contentKind: row.content_kind as "bubble" | "card",
    htmlKind: (row.html_kind as "rich" | "plain" | null) ?? null,
    // ponytail: body_text holds bodyFull for rich cards, bodyStripped for plain bubbles
    bodyStripped: row.html_kind !== "rich" ? (row.body_text as string) ?? null : null,
    bodyFull: row.html_kind === "rich" ? (row.body_text as string) ?? null : null,
    hasRemoteImages: !!row.has_remote_images,
    isRead: !!row.is_read,
    outbound: !!row.outbound,
    subject: meta.subject as string | null,
    to: (meta.to as string[]) ?? [],
    cc: (meta.cc as string[]) ?? [],
    replyTo: meta.replyTo as string | null,
    keywords: (meta.keywords as string[]) ?? [],
    attachments: meta.attachments ?? [],
    senderTrusted: meta.senderTrusted,
    senderVerified: meta.senderVerified,
    viaAlias: meta.viaAlias as string | null,
    viaAliasId: meta.viaAliasId as string | null,
    submission: meta.submission,
    replyContext: meta.replyContext,
    calendarInvite: meta.calendarInvite,
  };
}
