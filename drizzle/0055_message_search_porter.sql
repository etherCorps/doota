-- Switch message_search to the Porter stemming tokenizer so inflected forms
-- match a shared stem: "invoices"/"invoicing" ↔ "invoice", "running" ↔ "run".
-- Porter WRAPS unicode61 here (diacritics folded, punctuation split) and then
-- stems each token at BOTH index and query time — the single biggest recall win
-- over the plain unicode61 index in 0054.
--
-- FTS5 fixes the tokenizer at CREATE (no ALTER), so this DROPs and re-CREATEs.
-- Journaled migrations (deploy / db:migrate) run this ONCE, so the drop is safe:
-- the table returns EMPTY and is repopulated by the search reindex backfill
-- (reindexMessages) — new mail re-indexes automatically at ingest.
DROP TABLE IF EXISTS message_search;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  message_id UNINDEXED,
  subject,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
