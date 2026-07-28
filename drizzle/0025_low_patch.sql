CREATE TABLE `correspondent` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`address` text NOT NULL,
	`name` text,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correspondent_mailbox_address_uidx` ON `correspondent` (`mailbox_id`,`address`);--> statement-breakpoint
CREATE INDEX `correspondent_recency_idx` ON `correspondent` (`mailbox_id`,`last_seen_at`);--> statement-breakpoint
DROP INDEX `notification_dedupe_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_dedupe_idx` ON `notification` (`user_id`,`thread_id`) WHERE read_at is null and type = 'new_mail';