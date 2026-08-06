-- Attachment scan verdict (Phase D). Shared on the deduped attachment row so a
-- teammate's scan is visible to everyone. ADVISORY only — never an authz input.
ALTER TABLE `attachment` ADD COLUMN `sha256` text;--> statement-breakpoint
ALTER TABLE `attachment` ADD COLUMN `scan_verdict` text;--> statement-breakpoint
ALTER TABLE `attachment` ADD COLUMN `scan_rule` text;--> statement-breakpoint
ALTER TABLE `attachment` ADD COLUMN `scanned_at` integer;--> statement-breakpoint
ALTER TABLE `attachment` ADD COLUMN `scanner_version` text;
