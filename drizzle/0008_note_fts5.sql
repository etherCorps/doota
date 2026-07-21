-- Custom SQL migration file, put your code below! --

-- Blind-token full-text search for internal notes (search.ts / notes.ts). A
-- SEPARATE FTS5 table from message_fts: notes have no `delivery` row, so they
-- scope directly by mailbox_id (UNINDEXED, stored for scoping) instead of a
-- deliveries join. `tokens` holds per-word HMAC blind tokens (same SEARCH_KEY,
-- never in D1). FTS5 can't be modeled in Drizzle, so this is a --custom migration.
-- Idempotent writes: DELETE by note_id then INSERT (no FTS unique constraint).
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  note_id UNINDEXED,
  mailbox_id UNINDEXED,
  org_id UNINDEXED,
  tokens
);
