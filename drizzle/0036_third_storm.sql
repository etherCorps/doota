CREATE TABLE `change_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mailbox_id` text NOT NULL,
	`type` text NOT NULL,
	`object_id` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_log_mailbox_seq` ON `change_log` (`mailbox_id`,`seq`);--> statement-breakpoint
CREATE TABLE `change_log_floor` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`floor_seq` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `mailbox` ADD `reveal_sender` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailbox_access` ADD `send_display_name` text;--> statement-breakpoint
ALTER TABLE `thread_state` ADD `placement_origin` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_state` ADD `placement_rule_id` text;--> statement-breakpoint
ALTER TABLE `thread_state` ADD `placement_user_id` text;--> statement-breakpoint
ALTER TABLE `thread_state` ADD `placement_at` integer;--> statement-breakpoint
ALTER TABLE `thread_state` ADD `muted` integer DEFAULT false NOT NULL;