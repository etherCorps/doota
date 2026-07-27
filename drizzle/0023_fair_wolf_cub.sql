CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`type` text NOT NULL,
	`mailbox_id` text,
	`thread_id` text,
	`submission_id` text,
	`actor_user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`read_at` integer,
	`seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notification_feed_idx` ON `notification` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_unread_idx` ON `notification` (`user_id`) WHERE read_at is null;--> statement-breakpoint
CREATE INDEX `notification_dedupe_idx` ON `notification` (`user_id`,`thread_id`) WHERE read_at is null;