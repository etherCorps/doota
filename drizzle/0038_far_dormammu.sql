ALTER TABLE `label` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `label` ADD `notify_new_mail` integer DEFAULT true NOT NULL;