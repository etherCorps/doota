CREATE TABLE `webhook_endpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`secret_enc` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`disabled_at` integer,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoint_org_idx` ON `webhook_endpoint` (`org_id`);--> statement-breakpoint
CREATE TABLE `webhook_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`response_code` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoint`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_delivery_endpoint_idx` ON `webhook_delivery` (`endpoint_id`);--> statement-breakpoint
CREATE INDEX `webhook_delivery_due_idx` ON `webhook_delivery` (`next_attempt_at`) WHERE status = 'queued';
