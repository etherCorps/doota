-- Org-wide 2FA mandate (Phase C). Enforced in the request guard. require_2fa_from
-- is the grace deadline (before: prompt; after: block). API keys are exempt.
ALTER TABLE `org_mail_settings` ADD COLUMN `require_2fa` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `org_mail_settings` ADD COLUMN `require_2fa_from` integer;
