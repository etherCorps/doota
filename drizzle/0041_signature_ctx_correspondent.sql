DROP INDEX `mailbox_signature_user_mailbox_uidx`;--> statement-breakpoint
ALTER TABLE `mailbox_signature` ADD `context` text DEFAULT 'new' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_signature_user_mailbox_ctx_uidx` ON `mailbox_signature` (`user_id`,`mailbox_id`,`context`);--> statement-breakpoint
ALTER TABLE `correspondent` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `correspondent` ADD `message_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `correspondent` ADD `last_replied_at` integer;--> statement-breakpoint
ALTER TABLE `correspondent` ADD `details` text;