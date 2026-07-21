CREATE TABLE `send_counter` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_counter_uidx` ON `send_counter` (`scope`,`scope_key`,`window_start`);--> statement-breakpoint
CREATE TABLE `submission` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`message_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`envelope_from` text NOT NULL,
	`from_alias_id` text,
	`created_by_user_id` text,
	`send_at` integer,
	`undo_until` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`provider` text,
	`provider_message_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_alias_id`) REFERENCES `alias`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_idempotency_uidx` ON `submission` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `submission_mailbox_idx` ON `submission` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `submission_message_idx` ON `submission` (`message_id`);--> statement-breakpoint
CREATE INDEX `submission_status_idx` ON `submission` (`status`);--> statement-breakpoint
CREATE TABLE `submission_recipient` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`address` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`bounce_type` text,
	`bounce_reason` text,
	`provider_message_id` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_recipient_uidx` ON `submission_recipient` (`submission_id`,`address`);--> statement-breakpoint
CREATE INDEX `submission_recipient_submission_idx` ON `submission_recipient` (`submission_id`);--> statement-breakpoint
CREATE TABLE `suppression` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`address` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppression_org_address_uidx` ON `suppression` (`org_id`,`address`);--> statement-breakpoint
ALTER TABLE `org_mail_settings` ADD `return_path_domain` text;