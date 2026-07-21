-- Custom SQL migration file, put your code below! --

-- Blind-token full-text search (search.ts). Standalone FTS5 table: `tokens` holds
-- per-word HMAC blind tokens (hex, space-separated) derived with a separate
-- SEARCH_KEY that never touches D1 — so the index reveals nothing about content.
-- message_id/org_id are UNINDEXED (stored, not tokenized) for scoping: FTS5
-- returns message_ids, callers scope to a mailbox via a deliveries join.
-- FTS5 can't be expressed in the Drizzle schema, so this is a --custom migration.
-- Idempotent writes: consumer DELETEs by message_id then INSERTs (no FTS unique).
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  org_id UNINDEXED,
  tokens
);