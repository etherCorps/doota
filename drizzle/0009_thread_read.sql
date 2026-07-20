CREATE TABLE `thread_read` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`last_read_at` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_read_user_thread_mailbox_uidx` ON `thread_read` (`user_id`,`thread_id`,`mailbox_id`);--> statement-breakpoint
CREATE INDEX `thread_read_user_mailbox_idx` ON `thread_read` (`user_id`,`mailbox_id`);
