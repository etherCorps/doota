-- Pin a mail (Phase B). Shared per-mailbox, orthogonal to placement. The partial
-- index serves the separate pinned-list query; the main list index is untouched.
ALTER TABLE `thread_state` ADD COLUMN `pinned_at` integer;--> statement-breakpoint
CREATE INDEX `thread_state_pinned_idx` ON `thread_state` (`mailbox_id`,`pinned_at`) WHERE `pinned_at` is not null;--> statement-breakpoint
-- Pinning is a client-observable Thread change: add pinned_at to the trigger's
-- UPDATE OF list (and ONLY that) so a pin/unpin emits a change_log row.
DROP TRIGGER IF EXISTS `change_log_thread_state_upd`;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `change_log_thread_state_upd` AFTER UPDATE OF placement, is_starred, assignee_user_id, snoozed_until, hidden_at, muted, pinned_at ON thread_state
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Thread', NEW.thread_id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
