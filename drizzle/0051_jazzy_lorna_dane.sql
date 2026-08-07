DROP INDEX `calendar_event_message_uidx`;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `recurrence_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `is_cancelled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `unparseable` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `rrule` text;--> statement-breakpoint
ALTER TABLE `calendar_event` ADD `raw_ics_r2_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_msg_uid_recur_uidx` ON `calendar_event` (`message_id`,`uid`,`recurrence_id`);--> statement-breakpoint
ALTER TABLE `calendar_rsvp` ADD `last_sent_partstat` text;--> statement-breakpoint
ALTER TABLE `calendar_rsvp` ADD `reply_sent_at` integer;
