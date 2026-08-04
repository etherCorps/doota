-- Custom SQL migration file, put your code below! --

-- change_log writers. TRIGGERS, not application code, so logging cannot be
-- forgotten by a future code path. Scoped `AFTER UPDATE OF` to the columns a
-- sync client can observe — body-cache writes, counters, and recency bumps
-- (last_activity_at / last_inbound_at / last_read_at) must NOT burn a seq.
-- All idempotent (IF NOT EXISTS) — re-applied by apply-virtual-tables.mjs
-- after db:push, same treatment as *_fts5.sql.
-- NOTE (SQLite semantics): UPDATE OF fires when a watched column appears in
-- the SET clause, even if the value is unchanged — writers must keep watched
-- columns out of SET unless actually changing them (see ensureThreadState).

-- Email = delivery (the per-mailbox view; `message` is org-shared and has no
-- mailbox_id, so it cannot produce a per-account change row).
CREATE TRIGGER IF NOT EXISTS change_log_delivery_ins AFTER INSERT ON delivery
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Email', NEW.id, 'created', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_delivery_upd AFTER UPDATE OF is_read, keywords ON delivery
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Email', NEW.id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_delivery_del AFTER DELETE ON delivery
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (OLD.mailbox_id, 'Email', OLD.id, 'destroyed', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_thread_state_ins AFTER INSERT ON thread_state
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Thread', NEW.thread_id, 'created', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_thread_state_upd AFTER UPDATE OF placement, is_starred, assignee_user_id, snoozed_until, hidden_at, muted ON thread_state
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Thread', NEW.thread_id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_thread_state_del AFTER DELETE ON thread_state
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (OLD.mailbox_id, 'Thread', OLD.thread_id, 'destroyed', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
-- Mailbox (JMAP) = label. `label` is org-scoped, so its changes fan out one
-- row per mailbox in the org (clients filter on their own mailbox_id).
CREATE TRIGGER IF NOT EXISTS change_log_label_ins AFTER INSERT ON label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  SELECT m.id, 'Mailbox', NEW.id, 'created', cast(unixepoch('subsecond') * 1000 as integer)
  FROM mailbox m WHERE m.org_id = NEW.org_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_label_upd AFTER UPDATE OF name, color ON label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  SELECT m.id, 'Mailbox', NEW.id, 'updated', cast(unixepoch('subsecond') * 1000 as integer)
  FROM mailbox m WHERE m.org_id = NEW.org_id;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_label_del AFTER DELETE ON label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  SELECT m.id, 'Mailbox', OLD.id, 'destroyed', cast(unixepoch('subsecond') * 1000 as integer)
  FROM mailbox m WHERE m.org_id = OLD.org_id;
END;
--> statement-breakpoint
-- Applying/removing a label on a thread = membership change on that Mailbox,
-- scoped to the one mailbox the thread_label row belongs to.
CREATE TRIGGER IF NOT EXISTS change_log_thread_label_ins AFTER INSERT ON thread_label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Mailbox', NEW.label_id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_thread_label_del AFTER DELETE ON thread_label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (OLD.mailbox_id, 'Mailbox', OLD.label_id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_submission_ins AFTER INSERT ON submission
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'EmailSubmission', NEW.id, 'created', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_submission_upd AFTER UPDATE OF status ON submission
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'EmailSubmission', NEW.id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
