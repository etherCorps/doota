CREATE TABLE `internal_note` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`author_user_id` text,
	`body_enc` text,
	`edited_at` integer,
	`deleted_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `internal_note_thread_mailbox_idx` ON `internal_note` (`thread_id`,`mailbox_id`);--> statement-breakpoint
CREATE INDEX `internal_note_mailbox_idx` ON `internal_note` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `system_event` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`actor_user_id` text,
	`event_type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `system_event_thread_mailbox_idx` ON `system_event` (`thread_id`,`mailbox_id`);