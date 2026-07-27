CREATE TABLE `calendar_event` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`message_id` text NOT NULL,
	`uid` text NOT NULL,
	`method` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`status` text,
	`start_ms` integer NOT NULL,
	`end_ms` integer,
	`tz` text,
	`all_day` integer DEFAULT false NOT NULL,
	`organizer_email` text,
	`organizer_name` text,
	`attendees_json` text DEFAULT '[]' NOT NULL,
	`meeting_platform` text,
	`cal_origin` text,
	`details_enc` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_message_uidx` ON `calendar_event` (`message_id`);--> statement-breakpoint
CREATE INDEX `calendar_event_uid_idx` ON `calendar_event` (`uid`);--> statement-breakpoint
CREATE TABLE `calendar_rsvp` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`uid` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_rsvp_user_uid_uidx` ON `calendar_rsvp` (`user_id`,`uid`);