ALTER TABLE `organization` ADD `status` text DEFAULT 'pending_zone' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization` DROP COLUMN `dkim_status`;--> statement-breakpoint
ALTER TABLE `organization` DROP COLUMN `sending_status`;
