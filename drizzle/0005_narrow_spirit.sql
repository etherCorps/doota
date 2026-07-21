ALTER TABLE `message` ADD `to_addrs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `cc_addrs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `message` ADD `reply_to` text;