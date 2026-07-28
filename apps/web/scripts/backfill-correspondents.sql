-- One-off backfill for the `correspondent` autocomplete index (migration 0025).
-- Idempotent: re-runnable, ON CONFLICT keeps the newest last_seen_at + a name.
-- Run AFTER 0025 is applied. Live upserts (inbound/send hooks) maintain it after.

-- 1. Received: each sender becomes a correspondent of the recipient mailbox.
INSERT INTO correspondent (id, mailbox_id, address, name, last_seen_at)
SELECT lower(hex(randomblob(16))), d.mailbox_id, lower(m.from_addr), MAX(m.from_name),
       COALESCE(MAX(m.sent_at), MAX(d.created_at), 0)
FROM delivery d JOIN message m ON m.id = d.message_id
WHERE m.from_addr IS NOT NULL AND m.from_addr <> '' AND d.role IN ('to','cc','bcc')
GROUP BY d.mailbox_id, lower(m.from_addr)
ON CONFLICT(mailbox_id, address) DO UPDATE SET
  last_seen_at = MAX(excluded.last_seen_at, correspondent.last_seen_at),
  name = COALESCE(correspondent.name, excluded.name);

-- 2. Sent: each addressed recipient becomes a correspondent of the sending mailbox.
INSERT INTO correspondent (id, mailbox_id, address, name, last_seen_at)
SELECT lower(hex(randomblob(16))), s.mailbox_id, lower(sr.address), NULL,
       COALESCE(MAX(s.created_at), 0)
FROM submission_recipient sr JOIN submission s ON s.id = sr.submission_id
WHERE sr.address IS NOT NULL AND sr.address <> ''
GROUP BY s.mailbox_id, lower(sr.address)
ON CONFLICT(mailbox_id, address) DO UPDATE SET
  last_seen_at = MAX(excluded.last_seen_at, correspondent.last_seen_at),
  name = COALESCE(correspondent.name, excluded.name);

-- 3. Our users: every org member is seeded as a correspondent of every mailbox
-- in that org, carrying their display name. Fresh rows rank recent (teammates
-- first); an existing row (they already corresponded) just gains the name and
-- keeps its real recency.
INSERT INTO correspondent (id, mailbox_id, address, name, last_seen_at)
SELECT lower(hex(randomblob(16))), mb.id, lower(u.email), u.name,
       cast(unixepoch('subsecond') * 1000 as integer)
FROM mailbox mb
JOIN member mem ON mem.organization_id = mb.org_id
JOIN "user" u ON u.id = mem.user_id
WHERE u.email IS NOT NULL AND u.email <> ''
  -- Don't suggest a user to themselves: skip mailboxes they can access.
  AND NOT EXISTS (
    SELECT 1 FROM mailbox_access ma
    WHERE ma.mailbox_id = mb.id AND ma.user_id = u.id
  )
ON CONFLICT(mailbox_id, address) DO UPDATE SET
  name = COALESCE(excluded.name, correspondent.name);
