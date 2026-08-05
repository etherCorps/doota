-- Webhooks move from org scope to mailbox scope (a mailbox's users decide where
-- its events go). Pre-release, so the org-scoped rows from 0046 are cleared
-- rather than backfilled — cascade drops their deliveries.
DELETE FROM `webhook_endpoint`;--> statement-breakpoint
ALTER TABLE `webhook_endpoint` ADD COLUMN `mailbox_id` text NOT NULL DEFAULT '' REFERENCES `mailbox`(`id`) ON DELETE cascade;--> statement-breakpoint
DROP INDEX IF EXISTS `webhook_endpoint_org_idx`;--> statement-breakpoint
CREATE INDEX `webhook_endpoint_mailbox_idx` ON `webhook_endpoint` (`mailbox_id`);
