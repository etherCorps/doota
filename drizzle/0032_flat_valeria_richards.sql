CREATE TABLE `send_event` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`api_key_id` text,
	`submission_id` text,
	`template_id` text,
	`template_version` integer,
	`to_addresses` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`data_cipher` text,
	`data_expires_at` integer,
	`redacted_keys` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `send_event_mailbox_idx` ON `send_event` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `send_event_org_idx` ON `send_event` (`org_id`);--> statement-breakpoint
CREATE INDEX `send_event_key_idx` ON `send_event` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `send_event_data_expiry_idx` ON `send_event` (`data_expires_at`);--> statement-breakpoint
ALTER TABLE `submission` ADD `api_key_id` text REFERENCES api_key(id);