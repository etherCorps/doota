-- Custom SQL migration file, put your code below! --

-- Plaintext full-text search index (search.ts / SECURITY docs). DELIBERATE
-- exception to zero-access-at-rest: unlike the D1 content columns and R2 blobs
-- (encrypted), THIS index stores READABLE subject + body so FTS5 gives real
-- ranking, prefix, and phrase search (the Fastmail posture). Separate
-- subject/body columns let BM25 weight the subject higher. message_id is
-- UNINDEXED (stored, not tokenized); callers scope to a mailbox via a deliveries
-- join. FTS5 can't be modeled in Drizzle, so this is a --custom migration;
-- writes are DELETE-by-message_id then INSERT (no FTS unique key).
--
-- Supersedes the old blind-token `message_fts` table (0001), now unused.
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  message_id UNINDEXED,
  subject,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
