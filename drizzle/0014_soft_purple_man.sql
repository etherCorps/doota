DROP INDEX `message_thread_idx`;--> statement-breakpoint
CREATE INDEX `message_thread_sent_idx` ON `message` (`thread_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `submission_user_status_idx` ON `submission` (`created_by_user_id`,`status`);