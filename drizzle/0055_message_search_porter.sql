-- Switch message_search to the Porter stemming tokenizer so inflected forms
-- match a shared stem: "invoices"/"invoicing" ↔ "invoice", "running" ↔ "run".
-- Porter WRAPS unicode61 here (diacritics folded, punctuation split) and then
-- stems each token at BOTH index and query time — the single biggest recall win
-- over the plain unicode61 index in 0054.
--
-- FTS5 fixes the tokenizer at CREATE (no ALTER), so this DROPs and re-CREATEs.
-- Journaled migrations (deploy / db:migrate) run this ONCE. The table returns
-- EMPTY and there is no backfill: new mail re-indexes automatically at ingest,
-- but mail that existed before this migration is no longer searchable
-- (acceptable pre-launch — little/no existing mail).
DROP TABLE IF EXISTS message_search;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  message_id UNINDEXED,
  subject,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
