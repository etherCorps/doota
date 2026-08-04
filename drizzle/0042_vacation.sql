CREATE TABLE `mailbox_vacation` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`enabled_by_user_id` text,
	`subject` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`interval_days` integer DEFAULT 4 NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enabled_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
