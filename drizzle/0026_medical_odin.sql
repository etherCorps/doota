ALTER TABLE `attachment` ADD `inline` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `html_kind` text;--> statement-breakpoint
ALTER TABLE `message` ADD `has_remote_images` integer DEFAULT false NOT NULL;