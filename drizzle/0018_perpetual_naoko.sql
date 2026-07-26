CREATE TABLE `sender_image_trust` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sender_addr` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_image_trust_uidx` ON `sender_image_trust` (`user_id`,`sender_addr`);