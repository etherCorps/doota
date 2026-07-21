CREATE TABLE `draft` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`thread_id` text,
	`in_reply_to_message_id` text,
	`kind` text DEFAULT 'new' NOT NULL,
	`from_alias_id` text,
	`subaddress_tag` text,
	`to_addrs` text DEFAULT '[]' NOT NULL,
	`cc_addrs` text DEFAULT '[]' NOT NULL,
	`bcc_addrs` text DEFAULT '[]' NOT NULL,
	`subject_enc` text,
	`body_enc` text,
	`attachments` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'editing' NOT NULL,
	`submission_id` text,
	`client_revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_alias_id`) REFERENCES `alias`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `draft_user_updated_idx` ON `draft` (`created_by_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `draft_mailbox_idx` ON `draft` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `draft_thread_idx` ON `draft` (`thread_id`);