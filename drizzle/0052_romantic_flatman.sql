DROP INDEX `submission_idempotency_uidx`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_idempotency_uidx` ON `submission` (`org_id`,`idempotency_key`);