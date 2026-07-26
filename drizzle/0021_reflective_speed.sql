ALTER TABLE `mailbox_access` ADD `assigned_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing shared-mailbox grants: non-managers become assigned-only (managers keep
-- full access). Personal mailboxes are never restricted — the owner IS the mailbox.
UPDATE `mailbox_access` SET `assigned_only` = 1
WHERE `can_manage` = 0
  AND `mailbox_id` IN (SELECT `id` FROM `mailbox` WHERE `is_personal` = 0);
