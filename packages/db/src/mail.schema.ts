import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user, organization } from "./auth.schema";

/**
 * Mail data model — APP-OWNED tables (not Better Auth). The auth-boundary guard
 * only blocks writes to the aggregated `schema.` namespace; app/worker code
 * writes these via a `mail.*` import alias (`db.insert(mail.mailbox)`), so the
 * guard is never tripped. Reads are allowed anywhere.
 *
 * The load-bearing split (ARCHITECTURE.md §2):
 *   message      — shared, one immutable row per unique email (dedupe key)
 *   delivery     — per mailbox: receipt (role, read, via-alias, subaddress tag)
 *   thread_state — per mailbox: triage (placement, star, assignee)
 *
 * Encrypt CONTENT only (subject/bodies, the *_enc columns). Routing + threading
 * metadata stays cleartext so the inbound hot path and threading never decrypt.
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const now = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull();

/**
 * Per-org mirror of Cloudflare Email Routing facts the inbound hot path needs
 * but must NOT fetch from CF: whether subaddressing is honored, and which
 * routing subdomains route to this org. Write-through from the superadmin CF
 * commands (domains.remote.ts); CF stays source of truth, this is a read-replica
 * (same pattern as organization.status). routing_subdomains is a JSON array of
 * full hosts — the resolver reads it via the in-memory org-domains cache, never
 * a per-message SQL join, so a column beats a table here.
 */
export const orgMailSettings = sqliteTable("org_mail_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  subaddressingEnabled: integer("subaddressing_enabled", { mode: "boolean" })
    .default(false)
    .notNull(),
  // JSON array of full hosts, e.g. ["mail.acme.com","support.acme.com"].
  routingSubdomains: text("routing_subdomains").default("[]").notNull(),
  // Cloudflare Email Sending return-path (bounce) subdomain for this org, mirrored
  // write-through from onboardSendingDomain (CF stays source of truth). The
  // outbound path sets it as the envelope MAIL FROM and the inbound consumer
  // recognizes DSNs addressed here as bounces rather than normal mail.
  returnPathDomain: text("return_path_domain"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * An address that receives mail. A SEPARATE entity from `user`: shared mailboxes
 * (support@) have many users and no single owner. Personal mailboxes are created
 * alongside the user in provisioning (is_personal = true). Address may sit on the
 * apex or any configured routing subdomain.
 */
export const mailbox = sqliteTable(
  "mailbox",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    localPart: text("local_part").notNull(),
    address: text("address").notNull(),
    displayName: text("display_name"),
    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
    isPersonal: integer("is_personal", { mode: "boolean" })
      .default(false)
      .notNull(),
    // Service mailboxes are non-human sending identities for automation; org
    // admins issue send-only API keys against them (never a personal inbox).
    isService: integer("is_service", { mode: "boolean" }).default(false).notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("mailbox_org_address_uidx").on(t.orgId, t.address),
    index("mailbox_org_idx").on(t.orgId),
  ],
);

/**
 * Shared-mailbox grant. Capability flags are resolved through the existing
 * can() (never a parallel permission path). Shaped so a nullable team scope is
 * an additive migration later.
 */
export const mailboxAccess = sqliteTable(
  "mailbox_access",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    canManage: integer("can_manage", { mode: "boolean" })
      .default(false)
      .notNull(),
    canSend: integer("can_send", { mode: "boolean" }).default(true).notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("mailbox_access_user_mailbox_uidx").on(t.userId, t.mailboxId),
    index("mailbox_access_mailbox_idx").on(t.mailboxId),
  ],
);

/**
 * Hide-my-email: a random, revocable address that forwards to a mailbox.
 * Distinct from subaddressing (which is guessable and leaks the real address).
 */
export const alias = sqliteTable(
  "alias",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    label: text("label"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).default(true).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("alias_org_address_uidx").on(t.orgId, t.address),
    index("alias_mailbox_idx").on(t.mailboxId),
  ],
);

export const thread = sqliteTable(
  "thread",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subjectNormalized: text("subject_normalized"),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [index("thread_org_idx").on(t.orgId)],
);

/**
 * One immutable row per unique email, deduped by (org_id, message_id_header).
 * item_type is the timeline discriminated union — only external_message is
 * written this pass; the column exists so internal_note / system_event are an
 * additive change, not a render-path rewrite. subject/body columns are
 * ciphertext (crypto.ts). Raw RFC5322 blob lives in R2 (r2_raw_key) and is the
 * canonical source everything else regenerates from.
 */
export const message = sqliteTable(
  "message",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    messageIdHeader: text("message_id_header").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    fromAddr: text("from_addr"),
    // Original visible recipients (JSON arrays) + Reply-To — cleartext routing
    // metadata (like from_addr), kept so reply-all can reconstruct the audience.
    // BCC is NEVER stored here (it lives only as delivery/submission rows).
    toAddrs: text("to_addrs").default("[]").notNull(),
    ccAddrs: text("cc_addrs").default("[]").notNull(),
    replyTo: text("reply_to"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    r2RawKey: text("r2_raw_key"),
    itemType: text("item_type").default("external_message").notNull(),
    contentKind: text("content_kind").default("card").notNull(), // bubble | card
    subjectEnc: text("subject_enc"),
    bodyStrippedEnc: text("body_stripped_enc"),
    bodyFullEnc: text("body_full_enc"),
    // Original HTML body (encrypted). Kept separately from body_full (which stays
    // plain text for quoting/search); rendered in a sandboxed iframe.
    bodyHtmlEnc: text("body_html_enc"),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("message_org_msgid_uidx").on(t.orgId, t.messageIdHeader),
    index("message_thread_idx").on(t.threadId),
  ],
);

/**
 * Per-recipient receipt. BCC exists ONLY as delivery rows — never written into
 * the shared message's stored headers. keywords is the JMAP-style extensible
 * flag set (JSON array: $seen/$answered/$flagged/…); is_read is kept as a fast
 * indexed mirror of $seen for list queries.
 */
export const delivery = sqliteTable(
  "delivery",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // to | cc | bcc | from
    viaAliasId: text("via_alias_id").references(() => alias.id, {
      onDelete: "set null",
    }),
    subaddressTag: text("subaddress_tag"),
    isRead: integer("is_read", { mode: "boolean" }).default(false).notNull(),
    keywords: text("keywords").default("[]").notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("delivery_msg_mailbox_role_uidx").on(
      t.messageId,
      t.mailboxId,
      t.role,
    ),
    index("delivery_mailbox_idx").on(t.mailboxId),
  ],
);

/** Per-mailbox triage for a thread. placement is exclusive. */
export const threadState = sqliteTable(
  "thread_state",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    placement: text("placement").default("inbox").notNull(), // inbox|archived|spam|trash|sent
    isStarred: integer("is_starred", { mode: "boolean" })
      .default(false)
      .notNull(),
    assigneeUserId: text("assignee_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
    // "Empty trash/spam" hides — never a hard delete. Hidden threads drop out of
    // every list; moving a thread to a new placement clears it.
    hiddenAt: integer("hidden_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("thread_state_thread_mailbox_uidx").on(t.threadId, t.mailboxId),
    index("thread_state_mailbox_placement_idx").on(t.mailboxId, t.placement),
  ],
);

/**
 * Per-USER read cursor for a thread within a mailbox. Distinct from
 * thread_state (which is per-mailbox triage shared by the whole team): in a
 * shared mailbox each teammate must have their OWN unread state, so one person
 * opening a thread doesn't clear the unread dot for everyone. Keyed
 * (user, thread, mailbox); last_read_at is compared against a message's sent_at
 * to derive read/unread. thread_state.last_read_at is left in place but is no
 * longer the authority for unread.
 */
export const threadRead = sqliteTable(
  "thread_read",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex("thread_read_user_thread_mailbox_uidx").on(
      t.userId,
      t.threadId,
      t.mailboxId,
    ),
    index("thread_read_user_mailbox_idx").on(t.userId, t.mailboxId),
  ],
);

export const label = sqliteTable(
  "label",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: now(),
  },
  (t) => [uniqueIndex("label_org_name_uidx").on(t.orgId, t.name)],
);

export const threadLabel = sqliteTable(
  "thread_label",
  {
    id: id(),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => label.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("thread_label_uidx").on(t.threadId, t.mailboxId, t.labelId),
  ],
);

/**
 * Attachment metadata. The raw blob in R2 stays canonical; attachments are
 * servable by re-extraction, so this is metadata + an r2_key, not the bytes.
 */
export const attachment = sqliteTable(
  "attachment",
  {
    id: id(),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    partId: text("part_id"),
    filename: text("filename"),
    contentType: text("content_type"),
    size: integer("size"),
    r2Key: text("r2_key"),
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);

/**
 * COLLABORATION (Task 5) — the thin Missive layer. Both live in SIBLING tables
 * (never merged into `message`), so the immutable-message / delivery / submission
 * invariants stay untouched and a note is STRUCTURALLY incapable of entering the
 * outbound path (submission.message_id FKs `message` only — no note ever does).
 *
 * internal_note — a note the team writes INSIDE a thread without emailing anyone.
 * Scoped per thread, per mailbox (mirrors thread_state): the same thread in
 * support@ and sales@ keeps separate notes. Body is encrypted (crypto.ts, same
 * DEK as messages); author/timestamps stay cleartext. Soft-deleted (deleted_at)
 * so a removal leaves a tombstone instead of rewriting history. Visibility
 * follows mailbox_access via can() — no parallel path.
 */
export const internalNote = sqliteTable(
  "internal_note",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    bodyEnc: text("body_enc"),
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: now(),
  },
  (t) => [
    index("internal_note_thread_mailbox_idx").on(t.threadId, t.mailboxId),
    index("internal_note_mailbox_idx").on(t.mailboxId),
  ],
);

/**
 * system_event — quiet, inline context (assignment changed, archived by another
 * user). Persisted ONLY for genuinely shared mailboxes (>1 access grant) and
 * only for meaningful acts; personal mailboxes emit none (the solo experience is
 * untouched). Never confusable with a message: rendered as a chip, no body.
 */
export const systemEvent = sqliteTable(
  "system_event",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => thread.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(), // assigned | unassigned | archived | unarchived
    // JSON: { assigneeUserId?, fromPlacement?, toPlacement? } — cleartext metadata.
    data: text("data").default("{}").notNull(),
    createdAt: now(),
  },
  (t) => [index("system_event_thread_mailbox_idx").on(t.threadId, t.mailboxId)],
);

/**
 * DRAFTS — mutable, PER-USER compose state. A draft is NOT a `message` row:
 * messages are immutable and deduped by message_id_header, a draft has neither.
 * It becomes a `message` + `submission` only at Send (a fresh message is built
 * from these fields — the draft is never mutated into it). Retained as a
 * tombstone (status `sent`, submission_id linked) until the submission leaves
 * its cancellable/failable window, so undo can restore an editable draft; then
 * GC'd. A draft never appears in the thread timeline — it is composer state.
 *
 * Per-user: two people with send access to support@ each get their OWN drafts.
 * Every row is owned via created_by_user_id and keyed by its own id; ownership
 * is enforced in app code (ownDraftRow) — a draft is never shared.
 *
 * Content (subject/body) is encrypted at rest with the same crypto.ts as
 * messages — a draft is user content. Recipient sets + attachment refs are JSON
 * (D1 has no transactions; a blob beats multi-row writes for autosave). Staged
 * attachments live in R2 under `draft/{orgId}/{draftId}/…`, copied to an
 * `outbound/` key on send and bulk-deleted on discard.
 */
export const draft = sqliteTable(
  "draft",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Sending identity — the mailbox the can() SEND capability is checked against.
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Set for replies/forwards; null for a brand-new thread.
    threadId: text("thread_id").references(() => thread.id, {
      onDelete: "cascade",
    }),
    // Parent's Message-ID header (matches the send contract's parentMessageId).
    inReplyToMessageId: text("in_reply_to_message_id"),
    kind: text("kind").default("new").notNull(), // new | reply | reply_all | forward
    fromAliasId: text("from_alias_id").references(() => alias.id, {
      onDelete: "set null",
    }),
    subaddressTag: text("subaddress_tag"),
    // JSON arrays of addresses.
    toAddrs: text("to_addrs").default("[]").notNull(),
    ccAddrs: text("cc_addrs").default("[]").notNull(),
    bccAddrs: text("bcc_addrs").default("[]").notNull(),
    subjectEnc: text("subject_enc"),
    bodyEnc: text("body_enc"),
    // JSON array of { r2Key, filename, contentType, size }.
    attachments: text("attachments").default("[]").notNull(),
    status: text("status").default("editing").notNull(), // editing | sent
    // Set once sent — links the tombstone to its submission (undo restore).
    submissionId: text("submission_id"),
    // Autosave conflict detection (same user, two tabs): a save must present the
    // revision it read; the server bumps it and rejects a stale write.
    clientRevision: integer("client_revision").default(0).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    createdAt: now(),
  },
  (t) => [
    // A user's own drafts, most-recently-edited first.
    index("draft_user_updated_idx").on(t.createdByUserId, t.updatedAt),
    index("draft_mailbox_idx").on(t.mailboxId),
    index("draft_thread_idx").on(t.threadId),
  ],
);

/**
 * OUTBOUND — send state, JMAP EmailSubmission-shaped. Send state CANNOT live on
 * `message` (immutable, shared across recipients), so it belongs on its own
 * object. One submission per send; per-recipient rows track fan-out (bounces are
 * per-recipient, sends chunk at 50).
 *
 * The row is written FIRST (status `queued`, idempotency_key set) and only THEN
 * is a job enqueued — that ordering is what makes queue redelivery safe.
 * status lifecycle (rolls up from recipients):
 *   draft_queued → queued → sending → sent → delivered
 *                → bounced_hard | bounced_soft | complained
 *   plus canceled (undo) and failed (gave up).
 */
export const submission = sqliteTable(
  "submission",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The message we constructed + materialized into the sender's timeline. It
    // carries the Message-ID we transmit, so a reflect-back dedupes against it.
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    // Sending identity — the mailbox the can() send capability is checked against.
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    envelopeFrom: text("envelope_from").notNull(),
    fromAliasId: text("from_alias_id").references(() => alias.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Scheduled send; null = send now (still held for the undo window below).
    sendAt: integer("send_at", { mode: "timestamp_ms" }),
    // Cancellation is possible while now < undo_until — the row is the source of
    // truth, not the queue delay.
    undoUntil: integer("undo_until", { mode: "timestamp_ms" }),
    status: text("status").default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    // The double-send guard: unique, so a redelivered enqueue can't create a
    // second submission for the same logical send.
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("submission_idempotency_uidx").on(t.idempotencyKey),
    index("submission_mailbox_idx").on(t.mailboxId),
    index("submission_message_idx").on(t.messageId),
    index("submission_status_idx").on(t.status),
  ],
);

/**
 * Per-recipient send state. Required (not a JSON blob) because bounces are
 * per-recipient and the consumer chunks at 50/provider-call. role mirrors the
 * delivery role; bcc recipients live here + as envelope-only (never in headers).
 */
export const submissionRecipient = sqliteTable(
  "submission_recipient",
  {
    id: id(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submission.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    role: text("role").notNull(), // to | cc | bcc
    // queued | sending | sent | delivered | bounced | complained | dropped | failed
    status: text("status").default("queued").notNull(),
    bounceType: text("bounce_type"), // hard | soft
    bounceReason: text("bounce_reason"),
    providerMessageId: text("provider_message_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex("submission_recipient_uidx").on(t.submissionId, t.address),
    index("submission_recipient_submission_idx").on(t.submissionId),
  ],
);

/**
 * Suppression list — hard bounces + complaints land here; a send to a suppressed
 * address is dropped BEFORE it reaches the provider (recorded as dropped, not
 * silently lost). Per-org so one org's bad address doesn't block another.
 */
export const suppression = sqliteTable(
  "suppression",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    reason: text("reason").notNull(), // hard_bounce | complaint | manual
    firstSeenAt: now(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [uniqueIndex("suppression_org_address_uidx").on(t.orgId, t.address)],
);

/**
 * Windowed send counters for rate limiting (Part G) — the same DB-backed
 * counter pattern used elsewhere, not a new mechanism. One row per
 * (scope, scope_key, window_start); the consumer bumps `count` via an atomic
 * upsert (onConflictDoUpdate count = count + 1) before each provider call.
 * scope: "mailbox" (key = mailbox id) | "instance" (key = "instance").
 */
export const sendCounter = sqliteTable(
  "send_counter",
  {
    id: id(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    count: integer("count").default(0).notNull(),
  },
  (t) => [
    uniqueIndex("send_counter_uidx").on(t.scope, t.scopeKey, t.windowStart),
  ],
);

/**
 * Programmatic send keys (bearer). App-owned rather than Better Auth's apiKey
 * plugin, which isn't present at the pinned better-auth version — same
 * capability, no phantom dependency. A key ACTS AS its owning user: the outbound
 * path resolves the presented secret → this row, then runs the SAME can() send
 * check as an interactive session (no parallel permission path). Only the SHA-256
 * of the secret is stored; the plaintext is shown once at creation. Optional
 * mailbox_id restricts a key to sending as one mailbox. All access lives in
 * src/lib/server/auth/api-key.ts (the auth boundary).
 */
export const apiKey = sqliteTable(
  "api_key",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Legacy human owner (a key ACTS AS this user). Null for service keys, which
    // authorize the service mailbox directly — so they survive staff turnover.
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    // Admin who issued a service key (audit only). Set-null so key outlives them.
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Service keys send AS the mailbox itself; no per-user grant is consulted.
    isService: integer("is_service", { mode: "boolean" }).default(false).notNull(),
    // The sending scope. Required for service keys; for legacy keys null = any
    // mailbox the owning user can send as.
    mailboxId: text("mailbox_id").references(() => mailbox.id, {
      onDelete: "cascade",
    }),
    name: text("name"),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("api_key_hash_uidx").on(t.keyHash),
    index("api_key_user_idx").on(t.userId),
  ],
);

export const mailboxRelations = relations(mailbox, ({ many }) => ({
  access: many(mailboxAccess),
  aliases: many(alias),
  deliveries: many(delivery),
}));
export const messageRelations = relations(message, ({ one, many }) => ({
  thread: one(thread, {
    fields: [message.threadId],
    references: [thread.id],
  }),
  deliveries: many(delivery),
  attachments: many(attachment),
}));
export const deliveryRelations = relations(delivery, ({ one }) => ({
  message: one(message, {
    fields: [delivery.messageId],
    references: [message.id],
  }),
  mailbox: one(mailbox, {
    fields: [delivery.mailboxId],
    references: [mailbox.id],
  }),
}));
export const threadRelations = relations(thread, ({ many }) => ({
  messages: many(message),
  states: many(threadState),
}));
