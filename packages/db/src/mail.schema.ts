// SPDX-License-Identifier: Apache-2.0
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
  // Org-wide remote-content (images + fonts) policy. `block` (privacy default):
  // remote resources are proxied only when the reader opts in. `allow`:
  // auto-loaded (still same-origin proxied, never a direct sender fetch).
  // When `remote_content_locked`, users CANNOT override it (server-enforced in
  // the body route) — for privacy-strict orgs.
  remoteContentMode: text("remote_content_mode").default("block").notNull(), // block | allow
  remoteContentLocked: integer("remote_content_locked", { mode: "boolean" }).default(false).notNull(),
  // Org-wide 2FA mandate (Phase C). When set, every interactive member must have
  // TOTP enrolled — enforced in the request guard, not the UI. `require_2fa_from`
  // is the grace deadline: before it members are prompted, after it unenrolled
  // sessions are blocked. Flipping this to instant-lockout would be a support
  // incident, so enabling always sets a future deadline. API keys are exempt by
  // construction (they never hit the interactive guard) — see docs/2fa.md.
  require2fa: integer("require_2fa", { mode: "boolean" }).default(false).notNull(),
  require2faFrom: integer("require_2fa_from", { mode: "timestamp_ms" }),
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
    // Emit a `Sender:` header naming the individual who sent as this shared
    // mailbox (RFC 5322 From ≠ Sender; DMARC aligns on From, so it's free).
    // Off by default — Outlook renders it as "on behalf of".
    revealSender: integer("reveal_sender", { mode: "boolean" }).default(false).notNull(),
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
    // Restricted grantee: sees ONLY threads assigned to them in this mailbox
    // (the whole thread once assigned — history included). Ignored when
    // can_manage is set: a manager always sees the full mailbox.
    assignedOnly: integer("assigned_only", { mode: "boolean" })
      .default(false)
      .notNull(),
    // "Priya at Acme Support" — this user's From display name when sending as a
    // shared mailbox. Falls back to mailbox.display_name. The wire From address
    // is ALWAYS the mailbox address (replies must return to the team).
    sendDisplayName: text("send_display_name"),
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
    // Sender's display name from the From header ("Alice" in `Alice <a@x>`).
    // Cleartext label only — fromAddr stays the identity used for all matching.
    fromName: text("from_name"),
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
    // Render-decision flags computed at ingest so the read path never needs the
    // HTML body (which is NOT stored here — it's derived from the raw MIME in R2
    // on render). html_kind: rich → sandboxed card, plain → text bubble.
    htmlKind: text("html_kind"), // rich | plain | null (no html)
    hasRemoteImages: integer("has_remote_images", { mode: "boolean" }).default(false).notNull(),
    // Sender authentication verdict captured at ingest from Cloudflare's
    // Authentication-Results header (dmarc=pass ⇒ aligned DKIM/SPF). Drives the
    // "verified sender" shield. false = fail/none/unknown — fail-closed: we never
    // badge mail we didn't confirm, including historical rows.
    dmarcPass: integer("dmarc_pass", { mode: "boolean" }).default(false).notNull(),
    subjectEnc: text("subject_enc"),
    // Small text twins stay in D1 for the hot list/search/quote paths. The large
    // HTML body does NOT — see body/+server.ts (derives it from R2 raw).
    bodyStrippedEnc: text("body_stripped_enc"),
    bodyFullEnc: text("body_full_enc"),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("message_org_msgid_uidx").on(t.orgId, t.messageIdHeader),
    // Composite: serves plain thread lookups AND latest-message-per-thread
    // (ORDER BY sent_at) without scanning every message in the thread — the
    // thread-list hot path pays per-thread O(1) instead of O(messages).
    index("message_thread_sent_idx").on(t.threadId, t.sentAt),
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
    // Denormalized recency, maintained by materializeDelivery, so list + unread
    // never join `thread` or scan `delivery`:
    //  - last_activity_at mirrors thread.last_message_at — the SORT key (your own
    //    replies bump a thread), so the list walks an index and stops at LIMIT.
    //  - last_inbound_at = newest message delivered to THIS mailbox in a
    //    recipient role (never `from`) — the UNREAD key (your own send must not
    //    mark a thread unread). NULL ⇒ nothing inbound here yet.
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
    lastInboundAt: integer("last_inbound_at", { mode: "timestamp_ms" }),
    // "Empty trash/spam" hides — never a hard delete. Hidden threads drop out of
    // every list; moving a thread to a new placement clears it.
    hiddenAt: integer("hidden_at", { mode: "timestamp_ms" }),
    // Snooze: when set (future), the thread is hidden from the inbox and lives in
    // the Snoozed view. The 5-min cron nulls it when due, returning the thread to
    // the inbox top, unread. A new inbound reply also clears it (un-snooze early).
    // Partial index below (snoozed_snoozed_idx) keeps the tiny snoozed set — so the
    // cron's due-sweep and the Snoozed view are index-served, not full scans.
    snoozedUntil: integer("snoozed_until", { mode: "timestamp_ms" }),
    // How the thread reached its placement — drives resurfacing on a new reply
    // (user-filed returns to inbox; rule-filed stays put) and the "why is this
    // here?" sheet. Cheap now, impossible to backfill later.
    placementOrigin: text("placement_origin").default("default").notNull(), // default | user | rule
    placementRuleId: text("placement_rule_id"), // set when origin = 'rule'
    placementUserId: text("placement_user_id"), // set when origin = 'user' — who moved it
    placementAt: integer("placement_at", { mode: "timestamp_ms" }),
    // Shared mute (matches thread_state's shared semantics): a new reply never
    // resurfaces or notifies. Per-user mute, if ever needed, is a new table
    // alongside thread_read — additive, no rewrite.
    muted: integer("muted", { mode: "boolean" }).default(false).notNull(),
    // Pin (Phase B): shared across the mailbox, like is_starred. Pinned threads
    // sort to the top of any list containing them. Orthogonal to placement —
    // survives archive/move, never cleared on a placement change. Queried as a
    // separate small list (the partial index below), NOT a tiebreaker on the
    // list sort, so thread_state_list_idx's backward-scan-to-LIMIT is preserved.
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("thread_state_thread_mailbox_uidx").on(t.threadId, t.mailboxId),
    index("thread_state_mailbox_placement_idx").on(t.mailboxId, t.placement),
    // List: equality on (mailbox, placement) then the sort key — SQLite scans it
    // backwards for newest-first and stops at LIMIT instead of sorting the folder.
    index("thread_state_list_idx")
      .on(t.mailboxId, t.placement, t.lastActivityAt)
      .where(sql`${t.hiddenAt} is null`),
    // Unread: the inbox candidate set keyed by the inbound-recency column, so the
    // count compares last_inbound_at to the read cursor without a delivery scan.
    index("thread_state_unread_idx")
      .on(t.mailboxId, t.placement, t.lastInboundAt)
      .where(sql`${t.hiddenAt} is null`),
    // Snooze: partial index over only the (tiny) snoozed set. Serves the cron's
    // due-sweep (snoozed_until <= now) and the Snoozed view without full-scanning
    // thread_state; costs a write only when a thread is actually snoozed.
    index("thread_state_snoozed_idx")
      .on(t.snoozedUntil)
      .where(sql`${t.snoozedUntil} is not null`),
    // Pin: partial index over only the (capped ~10) pinned set per mailbox —
    // serves the separate pinned-list query without touching the list index.
    index("thread_state_pinned_idx")
      .on(t.mailboxId, t.pinnedAt)
      .where(sql`${t.pinnedAt} is not null`),
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
    // Labels are MAILBOX-scoped (privacy: folder names must not leak across
    // mailboxes). Nullable only because SQLite ADD COLUMN can't be NOT NULL
    // without a default — code treats it as required post-0045.
    mailboxId: text("mailbox_id").references(() => mailbox.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    // Folder nesting, max depth 2 (parent → child, no grandchildren) —
    // enforced in the rpc layer, deeper trees are where folder UIs die.
    // No FK self-reference: SQLite ALTER TABLE can't add one, and a dangling
    // parent simply renders at the root.
    parentId: text("parent_id"),
    // Per-folder new-mail notification (All=true / None=false). Rule-fed
    // folders default to None at rule creation (Phase 2) — filing away mail
    // that still buzzes achieves nothing. Inbox itself isn't a label.
    notifyNewMail: integer("notify_new_mail", { mode: "boolean" }).default(true).notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("label_mailbox_name_uidx").on(t.mailboxId, t.name)],
);

/**
 * Mailbox export jobs (build guide, Phase 6) — data portability is part of
 * the self-hosting promise. A queued, RESUMABLE job streams an mbox (plus a
 * sidecar JSON) into R2 part objects; the download route concatenates them
 * behind a short-lived capability URL. This row is the cursor (a lost job
 * resumes from D1), the progress readout, and the AUDIT RECORD — an export
 * decrypts everything, so who/when is part of the feature.
 */
export const mailExport = sqliteTable(
  "mail_export",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").default("running").notNull(), // running | done | failed
    cursor: text("cursor").default("").notNull(), // last delivery id processed
    messageCount: integer("message_count").default(0).notNull(),
    partCount: integer("part_count").default(0).notNull(),
    createdAt: now(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("mail_export_mailbox_idx").on(t.mailboxId)],
);

/**
 * Per-mailbox sender allow/block lists (build guide, Phase 5) — evaluated
 * BEFORE the spam classifier. `address` is a full address or a "@domain"
 * suffix entry. Moving mail out of Junk adds an implicit allow entry.
 */
export const mailboxSenderList = sqliteTable(
  "mailbox_sender_list",
  {
    id: id(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    address: text("address").notNull(), // lowercased; "@acme.com" = whole domain
    kind: text("kind").notNull(), // allow | block
    createdAt: now(),
  },
  (t) => [uniqueIndex("sender_list_mailbox_addr_uidx").on(t.mailboxId, t.address)],
);

/**
 * Vacation auto-responder settings, one row per mailbox (build guide, Phase
 * 4). The UI is trivial; RFC 3834 compliance in vacation.ts is the feature.
 * Dedupe (one reply per sender per interval) lives in KV with TTL, not here.
 */
export const mailboxVacation = sqliteTable("mailbox_vacation", {
  mailboxId: text("mailbox_id")
    .primaryKey()
    .references(() => mailbox.id, { onDelete: "cascade" }),
  orgId: text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).default(false).notNull(),
  // Replies are sent AS the mailbox but authorized as this user (the normal
  // can() send gate) — the responder dies with their revoked access.
  enabledByUserId: text("enabled_by_user_id").references(() => user.id, { onDelete: "set null" }),
  subject: text("subject").default("").notNull(), // empty → "Auto: Re: <subject>"
  bodyText: text("body_text").default("").notNull(),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  // One reply per sender per this many days (KV TTL).
  intervalDays: integer("interval_days").default(4).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

/**
 * Rules engine (build guide, Phase 2). JSON DSL, not Sieve — change_log is
 * JMAP-shaped and JMAP has its own filter model. Evaluated in `position`
 * order at the inbound rulesEval stage (BEFORE placement + notification);
 * spam and vacation later hang off the same stage as built-in kinds.
 * `conditions` / `actions` are validated on write against a closed enum
 * (rules.ts) — nothing unvalidated reaches the executor.
 */
export const rule = sqliteTable(
  "rule",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The human who authored the rule. `forward` actions send AS the mailbox
    // but are authorized as this user — the existing can() send gate applies,
    // so a forward dies with its creator's revoked access instead of becoming
    // an ownerless exfiltration path.
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    position: integer("position").default(0).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    conditions: text("conditions").notNull(), // JSON RuleConditions
    actions: text("actions").notNull(), // JSON RuleAction[]
    stopProcessing: integer("stop_processing", { mode: "boolean" }).default(false).notNull(),
    // Resumable "apply to existing messages" backfill: cursor + progress live
    // here (not in the queue payload alone) so a lost job resumes from D1 and
    // the UI can read progress.
    backfillCursor: text("backfill_cursor"),
    backfillDone: integer("backfill_done").default(0).notNull(),
    backfillStartedAt: integer("backfill_started_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [index("rule_mailbox_position_idx").on(t.mailboxId, t.position)],
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
    // cid-referenced by the body → hidden from the attachment list (shown inline).
    // Computed at ingest so the read path doesn't need the HTML body.
    inline: integer("inline", { mode: "boolean" }).default(false).notNull(),
    // Client-side scan result (Phase D). Shared on the (deduped) attachment row so
    // one teammate's scan is visible to everyone — nobody quietly misses a warning.
    // The verdict is ADVISORY (client-reported): a display signal, NEVER an
    // authorization input. `clean | matched | skipped | error` — fail-closed:
    // a timeout/oversize/crash records skipped/error, never clean.
    sha256: text("sha256"),
    scanVerdict: text("scan_verdict"),
    scanRule: text("scan_rule"), // the matched rule name, when matched
    scannedAt: integer("scanned_at", { mode: "timestamp_ms" }),
    scannerVersion: text("scanner_version"), // engine + ruleset version
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);

/**
 * A calendar invite (iMIP) carried by a message — one VEVENT per message, parsed
 * from its text/calendar part at ingest (see mail-core/calendar.ts). Structural
 * fields stay cleartext (routing-ish: times, organizer/attendee addresses, the
 * meeting platform) so a future "invites" view can query without decrypting; the
 * sensitive free-text (summary/location/description/joinUrl/rsvpLinks) lives in
 * `details_enc`, encrypted with the same DEK as the subject/body. UID is the
 * cross-message event key (REQUEST and later CANCEL share it) and what local
 * RSVP is scoped to.
 */
export const calendarEvent = sqliteTable(
  "calendar_event",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    // RECURRENCE-ID (single-instance override of a recurring series). '' = the
    // series/master (no override). Part of the composite identity
    // `(uid, recurrence_id)` — empty-string sentinel (NOT NULL) so the unique
    // index dedupes (SQLite treats NULLs as distinct).
    recurrenceId: text("recurrence_id").default("").notNull(),
    method: text("method").notNull(), // REQUEST | REPLY | CANCEL | PUBLISH
    sequence: integer("sequence").default(0).notNull(),
    status: text("status"), // CONFIRMED | CANCELLED | TENTATIVE
    // METHOD:CANCEL received for this (uid,recurrence_id). Kept as history — the
    // event is never hard-deleted; the card reads "Cancelled".
    isCancelled: integer("is_cancelled", { mode: "boolean" }).default(false).notNull(),
    // ICS parsed but structurally incomplete (missing UID/DTSTART). The email
    // still ingested normally; raw ICS is kept in R2 for later.
    unparseable: integer("unparseable", { mode: "boolean" }).default(false).notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms"),
    tz: text("tz"), // event timezone label (IANA) when the value carried a TZID
    allDay: integer("all_day", { mode: "boolean" }).default(false).notNull(),
    // RAW recurrence rule, verbatim — NEVER expanded. rdate/exdate stay in the
    // raw ICS blob (raw_ics_r2_key), not surfaced as columns.
    rrule: text("rrule"),
    organizerEmail: text("organizer_email"),
    organizerName: text("organizer_name"),
    attendeesJson: text("attendees_json").default("[]").notNull(),
    meetingPlatform: text("meeting_platform"), // zoom | teams | meet | webex
    calOrigin: text("cal_origin"), // google | microsoft | apple | other
    detailsEnc: text("details_enc"), // encrypted {summary,description,location,joinUrl,rsvpLinks}
    // Encrypted raw ICS bytes in R2 (calendar/<id>.ics) — source of truth a
    // future export/create path re-reads. Null only when there was no ICS blob.
    rawIcsR2Key: text("raw_ics_r2_key"),
    createdAt: now(),
  },
  (t) => [
    // One row per VEVENT per message: (message, uid, recurrence_id). Allows
    // multiple VEVENTs in one VCALENDAR + per-instance overrides, while
    // message-level idempotency collapses "fires once per recipient".
    uniqueIndex("calendar_event_msg_uid_recur_uidx").on(t.messageId, t.uid, t.recurrenceId),
    index("calendar_event_uid_idx").on(t.uid),
  ],
);

/**
 * A user's local RSVP for an event (yes/no/maybe), scoped by the event UID. This
 * is the app's own record — it does NOT notify the organizer (that needs an iMIP
 * reply the outbound provider can't emit yet, or the provider's own RSVP links).
 * Keyed per (user, uid) so the latest answer wins across every message of the
 * event.
 */
export const calendarRsvp = sqliteTable(
  "calendar_rsvp",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    status: text("status").notNull(), // accepted | declined | tentative
    // The PARTSTAT we last emailed the organizer, and when — so re-answering
    // with the SAME value doesn't re-send an iTIP REPLY.
    lastSentPartstat: text("last_sent_partstat"),
    replySentAt: integer("reply_sent_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [uniqueIndex("calendar_rsvp_user_uid_uidx").on(t.userId, t.uid)],
);

/**
 * Durable notification log (docs/notifications.md, Phase A). STRUCTURAL refs
 * only — no rendered title/body: the display string ("New message from Alice")
 * is resolved at read time from the thread's cleartext `message.fromAddr`/
 * `fromName`, so re-wording never needs a migration and no subject line leaks
 * into a zero-access design. Scoped per user; the bell filters to the ACTIVE org
 * (a user can hold mailboxes across served domains under multiSession).
 *
 * Read state is server-owned (cross-device): `seenAt` = bell opened, `readAt` =
 * notification clicked. A daily cron prunes `readAt < now-30d` (folded into the
 * draft-tombstone sweep).
 */
export const notification = sqliteTable(
  "notification",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // new_mail | send_failed | assigned | note | mention | routing_issue
    mailboxId: text("mailbox_id").references(() => mailbox.id, { onDelete: "cascade" }),
    threadId: text("thread_id"),
    submissionId: text("submission_id"),
    // The internal actor (assigned/mention); null for new_mail (sender is external).
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: now(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // Paginated feed (incl. recently-read). SQLite reads it backwards for DESC.
    // No orgId: the app has no org switcher yet, so the bell is not org-scoped —
    // filtering + sorting must share one index, and (userId, createdAt) serves
    // both. `orgId` stays on the row; add (userId, orgId, createdAt) when a
    // switcher exists to scope by.
    index("notification_feed_idx").on(t.userId, t.createdAt),
    // Unread count — partial so read rows drop out and it stays tiny.
    index("notification_unread_idx").on(t.userId).where(sql`read_at is null`),
    // Dedupe: at most ONE unread new_mail row per (user, thread). UNIQUE so a
    // race between two concurrent queue consumers (both SELECT-miss, both
    // INSERT) collapses at the DB instead of stacking a dup — recordNewMail's
    // insert is onConflictDoNothing. Scoped to new_mail in the predicate so it
    // never constrains send_failed/assigned/note (whose natural keys differ and
    // which legitimately repeat per thread).
    uniqueIndex("notification_dedupe_idx")
      .on(t.userId, t.threadId)
      .where(sql`read_at is null and type = 'new_mail'`),
  ],
);

/**
 * Web Push subscriptions (docs/notifications.md, Phase B) — one row per
 * browser/device that opted in. `endpoint` is the push service URL (unique);
 * `p256dh`/`auth` are the client keys the payload is encrypted to. Pruned when
 * the push service returns 404/410 (gone) or the row goes stale. Delivering
 * push with the app CLOSED is what this buys over the tab-open Notification API.
 */
export const pushSubscription = sqliteTable(
  "push_subscription",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: now(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("push_subscription_endpoint_uidx").on(t.endpoint),
    index("push_subscription_user_idx").on(t.userId),
  ],
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
    // Forward: JSON array of source message ids. The forwarded HTML is NOT stored
    // here — it's composed at Send from the sources' R2 raw (raw email HTML never
    // reaches the client), so a marketing template forwards with full fidelity.
    forwardMessageIds: text("forward_message_ids").default("[]").notNull(),
    // JSON array of { r2Key, filename, contentType, size }.
    attachments: text("attachments").default("[]").notNull(),
    status: text("status").default("editing").notNull(), // editing | sending (transient send claim) | sent
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
    // Tombstone GC sweep: `status = 'sent' AND updated_at < ?` — without this it
    // scans every draft each run.
    index("draft_status_updated_idx").on(t.status, t.updatedAt),
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
    // The API key that originated this send (null for interactive sends). The
    // join between the service-account send log and the outbound pipeline.
    apiKeyId: text("api_key_id").references(() => apiKey.id, { onDelete: "set null" }),
    // Scheduled send; null = send now (still held for the undo window below).
    sendAt: integer("send_at", { mode: "timestamp_ms" }),
    // Cancellation is possible while now < undo_until — the row is the source of
    // truth, not the queue delay.
    undoUntil: integer("undo_until", { mode: "timestamp_ms" }),
    status: text("status").default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    // Stamped by the consumer's claim CAS. Distinguishes a FRESH in-flight
    // `sending` row (must not be re-claimed — that's a double send on the wire)
    // from a stuck one (crashed mid-flight; rescue-eligible after a timeout).
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    // Stamped right AFTER the send-rate charge succeeds. The charge-once guard
    // keys on this, not on attempts: a crash between the claim CAS (which bumps
    // attempts) and the charge would otherwise skip the charge on redelivery.
    // A crash between charge and stamp re-charges instead — overcounting is the
    // safe direction for abuse control.
    rateChargedAt: integer("rate_charged_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    // The double-send guard: unique, so a redelivered enqueue can't create a
    // second submission for the same logical send.
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: now(),
  },
  (t) => [
    // Scoped per org: the idempotency key is caller-supplied, so a global unique
    // would let one tenant's key collide with another's and silently drop their
    // send (and leak the other tenant's submission id back).
    uniqueIndex("submission_idempotency_uidx").on(t.orgId, t.idempotencyKey),
    index("submission_mailbox_idx").on(t.mailboxId),
    index("submission_message_idx").on(t.messageId),
    index("submission_status_idx").on(t.status),
    // Per-user failed/scheduled listings scan only that user's rows.
    index("submission_user_status_idx").on(t.createdByUserId, t.status),
    // Wire Message-ID → our message: replies to provider-rewritten ids resolve here.
    index("submission_provider_msgid_idx").on(t.providerMessageId),
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
    // Per-chunk wire Message-ID lookups (chunks past the first live only here).
    index("submission_recipient_provider_msgid_idx").on(t.providerMessageId),
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
    // GC sweep of expired windows (`window_start < ?`) — the composite unique
    // above can't serve it (window_start isn't a prefix).
    index("send_counter_window_idx").on(t.windowStart),
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

/**
 * Outbound webhook endpoints (Phase A). PER MAILBOX: the mailbox's own users
 * decide where its delivery-outcome + inbound events go, so a shared mailbox's
 * webhooks are separate from a personal one's. The signing `secret` is stored
 * ENCRYPTED with the instance DEK (not hashed): unlike an api_key we must
 * recover it to compute the HMAC at delivery time. It is shown in cleartext
 * once at creation and never re-displayed. `events` is a JSON array of
 * subscribed event types; empty = all. Auto-disabled after N consecutive
 * failures (a dead endpoint retried forever is a self-inflicted outbound DoS).
 */
export const webhookEndpoint = sqliteTable(
  "webhook_endpoint",
  {
    id: id(),
    // Denormalized org (from the mailbox) — kept for admin queries + cascade.
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The mailbox whose events this endpoint receives.
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // AES-GCM envelope of the HMAC signing key (see crypto.ts encryptContent).
    secretEnc: text("secret_enc").notNull(),
    // First 12 chars of the plaintext secret, cleartext for display only.
    secretPrefix: text("secret_prefix").notNull(),
    events: text("events").notNull().default("[]"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).default(true).notNull(),
    // Consecutive failures; reset to 0 on any delivered attempt.
    failureCount: integer("failure_count").default(0).notNull(),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: now(),
  },
  (t) => [index("webhook_endpoint_mailbox_idx").on(t.mailboxId)],
);

/**
 * A single delivery attempt-set for one event to one endpoint. `event_id` is
 * stable across retries so receivers dedupe on it. Rides the write-row-then-
 * enqueue pattern (like `submission`): the row is inserted `queued`, then a job
 * is enqueued — so queue redelivery is idempotent. Retries use exponential
 * backoff with jitter; `next_attempt_at` drives both the delay and the due
 * scan (partial index below).
 */
export const webhookDelivery = sqliteTable(
  "webhook_delivery",
  {
    id: id(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: "cascade" }),
    // Stable event identity — receivers dedupe on it across retries/redeliveries.
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    // JSON body (structural refs only — never subject/body). Signed at delivery.
    payload: text("payload").notNull(),
    status: text("status").notNull().default("queued"), // queued|delivering|delivered|failed
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    responseCode: integer("response_code"),
    lastError: text("last_error"),
    createdAt: now(),
  },
  (t) => [
    index("webhook_delivery_endpoint_idx").on(t.endpointId),
    // Due scan for the retry sweep — only rows still awaiting an attempt.
    index("webhook_delivery_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`status = 'queued'`),
  ],
);

/**
 * Send log for API-originated mail (service accounts). Two tiers:
 *   1. durable metadata — who/when/which key/which template/status/recipients —
 *      retained long (the audit trail);
 *   2. a short-TTL, ENCRYPTED `data_cipher` — the template merge payload, often
 *      PII — purged by the cron sweep after `data_expires_at`, leaving the
 *      metadata row intact.
 * Rendered HTML is never stored: reconstruct from template + data while in TTL.
 * Variables flagged `sensitive` on the template are dropped before storage
 * (`redacted_keys` records their names). See docs/service-accounts.md.
 */
export const sendEvent = sqliteTable(
  "send_event",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The service account this send went out as.
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    // Which key sent it (null if interactive / key later deleted).
    apiKeyId: text("api_key_id").references(() => apiKey.id, { onDelete: "set null" }),
    // Link into the outbound pipeline for delivery status.
    submissionId: text("submission_id").references(() => submission.id, {
      onDelete: "set null",
    }),
    // Template used (Phase 2). Kept as plain text ids — no hard FK so a deleted
    // template doesn't cascade-wipe the audit log; the version pins what went out.
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    // Recipients + rendered subject — low-sensitivity audit. JSON string array.
    toAddresses: text("to_addresses").notNull(),
    subject: text("subject").default("").notNull(),
    // queued | sent | bounced | failed — mirrors the submission lifecycle.
    status: text("status").default("queued").notNull(),
    // Encrypted merge payload (mail-core crypto envelope). Nulled by the sweep.
    dataCipher: text("data_cipher"),
    dataExpiresAt: integer("data_expires_at", { mode: "timestamp_ms" }),
    // Variable names dropped before storage (flagged sensitive). JSON string array.
    redactedKeys: text("redacted_keys"),
    createdAt: now(),
  },
  (t) => [
    index("send_event_mailbox_idx").on(t.mailboxId),
    index("send_event_org_idx").on(t.orgId),
    index("send_event_key_idx").on(t.apiKeyId),
    // The purge sweep scans rows whose payload TTL is due.
    index("send_event_data_expiry_idx").on(t.dataExpiresAt),
  ],
);

/**
 * Hosted mail templates (docs/service-accounts.md § Templates) — an ORG-scoped
 * library reusable by any of the org's service accounts. `current_version_id`
 * points at the live version; edits create a new immutable version so a send's
 * pinned `template_version` reproduces exactly what went out.
 */
export const template = sqliteTable(
  "template",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Stable id used by the API (`POST /api/send { templateId }`). Unique per org.
    slug: text("slug").notNull(),
    // The live version. Plain text (no FK) to avoid a circular table reference.
    currentVersionId: text("current_version_id"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("template_org_slug_uidx").on(t.orgId, t.slug),
    index("template_org_idx").on(t.orgId),
  ],
);

/**
 * Immutable template version snapshot. `subjectTemplate` + `compiledHtml` carry
 * Jinja `{{ var }}` merge tags (rendered by un-jinja at send). `editorJson` is
 * the builder's block document (Phase 3), null for API/code-authored templates.
 * `variablesSchema` is the derived merge-tag list ({ name: { required, sensitive } }).
 */
export const templateVersion = sqliteTable(
  "template_version",
  {
    id: id(),
    templateId: text("template_id")
      .notNull()
      .references(() => template.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    subjectTemplate: text("subject_template").notNull(),
    compiledHtml: text("compiled_html").notNull(),
    // Builder block document (JSON string), null for code-authored templates.
    editorJson: text("editor_json"),
    // Derived merge-tag schema (JSON string), null when unspecified.
    variablesSchema: text("variables_schema"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("template_version_uidx").on(t.templateId, t.version),
    index("template_version_template_idx").on(t.templateId),
  ],
);

/**
 * Per-user "always load remote images from this sender" (Gmail/Fastmail
 * pattern). Presence of a row = trusted; delete to revoke. Address stored
 * lowercased. Display preference only — never an authorization surface.
 */
export const senderImageTrust = sqliteTable(
  "sender_image_trust",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    senderAddr: text("sender_addr").notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("sender_image_trust_uidx").on(t.userId, t.senderAddr)],
);

/**
 * Per-(user, mailbox) email signature. The signature is the SENDER's sign-off,
 * so it's keyed on the user AND the sending mailbox — on a shared mailbox each
 * teammate has their own. One signature per identity (bodyHtml, sanitized on
 * write). Injected into the composer client-side on a fresh compose/reply.
 */
export const mailboxSignature = sqliteTable(
  "mailbox_signature",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    // Sanitized signature HTML (reuses the outbound compose sanitizer). Empty
    // string is a valid "no signature" — a row's presence isn't required.
    bodyHtml: text("body_html").notNull().default(""),
    // Separate signatures for fresh messages vs replies/forwards (build guide,
    // Phase 3). Existing rows default to 'new'; a missing 'reply' row falls
    // back to 'new' at load, so one signature keeps working everywhere.
    context: text("context").notNull().default("new"), // new | reply
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("mailbox_signature_user_mailbox_ctx_uidx").on(t.userId, t.mailboxId, t.context),
  ],
);

/**
 * Materialized correspondent index for recipient autocomplete. One row per
 * (mailbox, address): the people a mailbox has sent to OR received from, with
 * the best-known display name and the most recent contact time. Upserted in the
 * inbound consumer (sender → recipient mailbox) and on send (recipient → sender
 * mailbox). Denormalization — same move as thread_state — so autocomplete is a
 * bounded prefix scan over a mailbox's few hundred contacts instead of a
 * GROUP BY over the whole delivery + submission history on every compose open.
 * Display-only, never an authorization surface; scoped by the caller's
 * accessible mailboxes.
 */
export const correspondent = sqliteTable(
  "correspondent",
  {
    id: id(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    address: text("address").notNull(), // lowercased
    name: text("name"), // best-known display name, null if never seen with one
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    // Interaction facts (build guide, Phase 3) — the substance of the contact
    // card, and cheap only if maintained from day one:
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }),
    // Inbound messages received from this address (not sends to it).
    messageCount: integer("message_count").default(0).notNull(),
    // Last time THIS mailbox sent to the address — the ham signal for spam
    // tier 2 and the "you reply to them" line on the card. Cannot be
    // reconstructed cheaply later.
    lastRepliedAt: integer("last_replied_at", { mode: "timestamp_ms" }),
    // User-ACCEPTED contact details (phone/url/…), JSON object. Extraction
    // only ever suggests; nothing lands here without an explicit tap.
    details: text("details"),
  },
  (t) => [
    uniqueIndex("correspondent_mailbox_address_uidx").on(t.mailboxId, t.address),
    // Recency list (no prefix) + the scan target for prefix filtering.
    index("correspondent_recency_idx").on(t.mailboxId, t.lastSeenAt),
  ],
);

/**
 * Monotonic per-mailbox change stream — the substrate for local-first sync and
 * a future JMAP server (shape satisfies JMAP /changes even though no endpoint
 * exists yet). Rows are written by SQLite TRIGGERS (drizzle/*_change_log_triggers.sql),
 * never application code, so logging cannot be forgotten by a future code path.
 * Structural refs only — no subjects, addresses, or bodies (same discipline as
 * notifications).
 *
 * `seq` must be AUTOINCREMENT (not a rowid alias): a reused rowid would let the
 * state token move backwards, which surfaces as silent client data loss.
 * `seq` is global; scoping is by query on mailbox_id (the JMAP accountId).
 */
export const changeLog = sqliteTable(
  "change_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    mailboxId: text("mailbox_id").notNull(),
    type: text("type").notNull(), // JMAP type names: Email | Thread | Mailbox | EmailSubmission
    objectId: text("object_id").notNull(),
    action: text("action").notNull(), // created | updated | destroyed
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("change_log_mailbox_seq").on(t.mailboxId, t.seq)],
);

/**
 * Highest pruned seq per mailbox. A client presenting a token at or below the
 * floor gets JMAP's cannotCalculateChanges (full resync) instead of a silently
 * incomplete diff. Maintained by pruneChangeLog on the daily cron.
 */
export const changeLogFloor = sqliteTable("change_log_floor", {
  mailboxId: text("mailbox_id").primaryKey(),
  floorSeq: integer("floor_seq").notNull(),
});

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
